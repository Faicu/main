// ---------------------------------------------------------------------------
// Urmărirea serialelor: descărcarea automată a episoadelor noi.
//
// A doua încercare. Prima (pinned-watcher.ts + tabelele pinned_*, eliminate
// în commit 1599c9e / migrarea v14) a fost problematică din două motive de
// fond, ambele evitate aici:
//
// 1. Trăia într-o structură paralelă. Titlurile urmărite stăteau în
//    `pinned_items`, per-utilizator, legate de `media` doar prin tmdb_id.
//    De-acolo veneau bug-urile ei: rânduri duplicate, dedublare între două
//    liste, un GROUP BY defensiv ca să nu descarce de N ori pentru N useri
//    care fixaseră același serial. Acum urmărirea e patru coloane pe rândul
//    'tv_show' din `media` — rând care e deja unic per serial și deja legat
//    de episoade prin parent_id. Nu mai există nimic de corelat.
//
// 2. Era diferențială, nu declarativă. Ținea `seen_torrent_ids` și
//    `last_aired_key` și reacționa la "ce s-a schimbat de la ultima
//    verificare": prima rulare per item era baseline (rata intenționat
//    primul episod), starea se strica la restart, iar o verificare picată
//    însemna un episod pierdut definitiv.
//
//    Aici comparăm starea dorită cu starea reală: TMDB spune ce episoade au
//    fost difuzate, `media WHERE parent_id = ?` spune ce avem, diferența e
//    ce trebuie descărcat. Rularea e idempotentă — se poate relua oricând,
//    se auto-repară după un restart, nu ratează nimic dacă un ciclu pică, și
//    nu poate descărca de două ori, fiindcă verifică realitatea, nu un
//    jurnal de evenimente.
// ---------------------------------------------------------------------------

import { getDb } from "../db";

const ITEM_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 ore — cadența reală per serial
// Câte descărcări pornim cel mult într-o rulare per serial. Un serial abia
// activat cu multe episoade lipsă nu trebuie să arunce 30 de torrente în
// qBittorrent deodată; restul vin la ciclurile următoare.
const MAX_DOWNLOADS_PER_RUN = 3;

export type EpisodeKey = { season: number; episode: number };

export function formatEpisodeKey(k: EpisodeKey): string {
  return `S${String(k.season).padStart(2, "0")}E${String(k.episode).padStart(2, "0")}`;
}

export function parseEpisodeKey(s: string | null): EpisodeKey | null {
  const m = s?.match(/^S(\d+)E(\d+)$/i);
  return m ? { season: Number(m[1]), episode: Number(m[2]) } : null;
}

// Ordonare stabilă sezon-apoi-episod, folosită și la comparația cu
// auto_download_from ("descarcă doar ce vine după punctul ăsta").
function ord(k: EpisodeKey): number {
  return k.season * 1000 + k.episode;
}

interface ShowRow {
  id: number;
  title: string;
  original_title: string | null;
  literal_title: string | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  poster_path: string | null;
  tv_status: string | null;
  auto_download_quality: string | null;
  auto_download_from: string | null;
  requested_by_user_id: number | null;
}

// Episoadele deja difuzate, după TMDB. Cerem doar sezoanele care ne
// interesează (de la sezonul lui `from` în sus), nu tot serialul — și pe
// alea într-un singur request, prin append_to_response.
//
// Sezonul 0 ("Specials") e sărit intenționat: nu face parte din numerotarea
// pe care o urmărim, iar lansările de pe Filelist nu-l acoperă coerent.
async function getAiredEpisodes(tmdbId: number, fromSeason: number): Promise<EpisodeKey[]> {
  const { getTmdbDetailsInternal, getTmdbAllSeasonsInternal } =
    await import("../tmdb/tmdb.functions");
  const details = await getTmdbDetailsInternal(tmdbId, "tv").catch(() => null);
  const seasonNumbers = (details?.seasons ?? [])
    .map((s) => s.seasonNumber)
    .filter((n) => n >= Math.max(1, fromSeason));
  if (seasonNumbers.length === 0) return [];
  const schema = await getTmdbAllSeasonsInternal(tmdbId, seasonNumbers).catch(() => []);
  return schema.flatMap((s) =>
    s.episodes
      .filter((e) => e.aired)
      .map((e) => ({ season: s.seasonNumber, episode: e.episodeNum })),
  );
}

export interface ShowWatchOutcome {
  showId: number;
  title: string;
  missing: string[];
  downloaded: string[];
  skipped: string | null;
}

// Verifică un singur serial și pornește descărcările lipsă. Exportată separat
// de bucla periodică fiindcă butonul "Verifică acum" din drawer o cheamă
// direct, pentru serialul deschis.
export async function checkShow(showId: number): Promise<ShowWatchOutcome> {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, title, original_title, literal_title, imdb_id, tmdb_id, poster_path,
              tv_status, auto_download_quality, auto_download_from, requested_by_user_id
         FROM media WHERE id = ? AND media_type = 'tv_show'`,
    )
    .get(showId) as unknown as ShowRow | undefined;

  const stamp = () =>
    db
      .prepare("UPDATE media SET watch_last_checked_at = ? WHERE id = ?")
      .run(new Date().toISOString(), showId);

  if (!row)
    return { showId, title: "?", missing: [], downloaded: [], skipped: "serial inexistent" };
  const result: ShowWatchOutcome = {
    showId,
    title: row.title,
    missing: [],
    downloaded: [],
    skipped: null,
  };

  // Fără IMDb id nu avem cum căuta: căutarea pe Filelist e strict pe IMDb
  // (fallback-ul pe titlu a fost eliminat definitiv, confirmat de suport).
  if (!row.imdb_id || !row.tmdb_id) {
    stamp();
    result.skipped = "lipsește imdb_id sau tmdb_id";
    return result;
  }

  const owned = db
    .prepare("SELECT season, episode FROM media WHERE parent_id = ?")
    .all(row.id) as unknown as Array<{ season: number | null; episode: number | null }>;
  const ownedKeys = new Set(
    owned
      .filter((e) => e.season != null && e.episode != null)
      .map((e) => formatEpisodeKey({ season: e.season!, episode: e.episode! })),
  );

  const from = parseEpisodeKey(row.auto_download_from);
  const aired = await getAiredEpisodes(row.tmdb_id, from ? from.season : 1);
  const missing = aired
    .filter((k) => !ownedKeys.has(formatEpisodeKey(k)))
    .filter((k) => !from || ord(k) > ord(from))
    .sort((a, b) => ord(a) - ord(b));
  result.missing = missing.map(formatEpisodeKey);

  if (missing.length === 0) {
    stamp();
    return result;
  }

  const { checkFilelistForItemInternal } = await import("../filelist/filelist-client");
  const search = await checkFilelistForItemInternal({
    title: row.title,
    originalTitle: row.literal_title || row.original_title || row.title,
    imdbId: row.imdb_id,
    mediaType: "tv",
  });
  if (search.status !== "ok" || search.torrents.length === 0) {
    stamp();
    result.skipped =
      search.status === "ok" ? "niciun torrent pe Filelist" : (search.error ?? "eroare Filelist");
    return result;
  }

  const { detectTorrentQuality } = await import("./torrent-quality");
  const { parseSeasonEpisodeFromName } = await import("./torrent-name-parse");
  const wantedQuality = row.auto_download_quality || "1080p";

  // Torrente deja aduse (indiferent de stadiu) — plasa care ține rularea
  // idempotentă în fereastra dintre pornirea unui pachet de sezon și
  // apariția rândurilor lui per episod: până atunci episoadele încă apar
  // "lipsă", iar fără verificarea asta același pachet ar fi descărcat din
  // nou la fiecare ciclu.
  const alreadyFetched = new Set(
    (
      db
        .prepare("SELECT DISTINCT torrent_name FROM media WHERE torrent_name IS NOT NULL")
        .all() as unknown as Array<{ torrent_name: string }>
    ).map((r) => r.torrent_name),
  );

  const missingKeys = new Set(missing.map(formatEpisodeKey));
  const candidates = search.torrents
    .filter((t) => t.matchedByImdb)
    .filter((t) => detectTorrentQuality(t.name) === wantedQuality)
    .filter((t) => !alreadyFetched.has(t.name))
    .map((t) => ({ torrent: t, parsed: parseSeasonEpisodeFromName(t.name) }))
    .filter((c) => c.parsed != null)
    .filter((c) => {
      const p = c.parsed!;
      if (p.episode != null) return missingKeys.has(formatEpisodeKey({ ...p, episode: p.episode }));
      // Pachet de sezon: util doar dacă acoperă măcar un episod lipsă.
      // Alegerea ta explicită e să-l luăm oricând acoperă ceva, chiar dacă
      // aduce și episoade deja deținute — singura excepție e pachetul din
      // care avem deja tot, care n-ar aduce nimic nou.
      return missing.some((k) => k.season === p.season);
    })
    // Episoadele individuale au prioritate față de pachete la aceeași
    // calitate (mai puțin trafic pentru același rezultat), apoi seederi.
    .sort((a, b) => {
      const aPack = a.parsed!.episode == null ? 1 : 0;
      const bPack = b.parsed!.episode == null ? 1 : 0;
      return aPack - bPack || b.torrent.seeders - a.torrent.seeders;
    });

  if (candidates.length === 0) {
    stamp();
    result.skipped = `niciun torrent ${wantedQuality} pentru episoadele lipsă`;
    return result;
  }

  const { downloadFilelistCore } = await import("../filelist/download");
  const { getTmdbDetailsInternal } = await import("../tmdb/tmdb.functions");
  const details = await getTmdbDetailsInternal(row.tmdb_id, "tv").catch(() => null);
  const covered = new Set<string>();

  for (const c of candidates) {
    if (result.downloaded.length >= MAX_DOWNLOADS_PER_RUN) break;
    const p = c.parsed!;
    // Nu porni două torrente care acoperă același episod în aceeași rulare
    // (ex. episodul individual și pachetul sezonului lui).
    const coversNow =
      p.episode != null
        ? [formatEpisodeKey({ season: p.season, episode: p.episode })]
        : missing.filter((k) => k.season === p.season).map(formatEpisodeKey);
    if (coversNow.every((k) => covered.has(k))) continue;

    const dl = await downloadFilelistCore({
      torrentId: c.torrent.id,
      torrentName: c.torrent.name,
      categoryId: c.torrent.category,
      categoryName: c.torrent.categoryName,
      size: c.torrent.size,
      freeleech: c.torrent.freeleech,
      internal: c.torrent.internal,
      imdb: c.torrent.imdb ?? row.imdb_id,
      requestedByUserId: row.requested_by_user_id,
      media: {
        // parent_id nu se trimite: upsertMediaEntry îl rezolvă singur, prin
        // ensureMediaPlaceholder, după tmdb_id/imdb_id/titlu — adică exact
        // rândul-serial de la care am pornit. Dublarea lui aici ar fi o a
        // doua sursă de adevăr pentru aceeași legătură.
        mediaType: "episode",
        imdbId: c.torrent.imdb ?? row.imdb_id,
        tmdbId: row.tmdb_id,
        title: row.title,
        originalTitle: row.original_title,
        literalTitle: row.literal_title,
        overviewRo: details?.overview ?? null,
        genres: details?.genres ?? [],
        posterPath: row.poster_path,
        tvStatus: details?.tvStatus ?? row.tv_status,
        season: p.season,
        episode: p.episode,
        isSeasonPack: p.episode == null,
        addedVia: "auto",
      },
    });

    if (dl.status !== "ok") {
      console.warn(
        `[show-watch] "${row.title}" — descărcare eșuată (${c.torrent.name}):`,
        dl.error,
      );
      continue;
    }
    for (const k of coversNow) covered.add(k);
    result.downloaded.push(
      p.episode == null
        ? `Sezonul ${p.season} (pachet)`
        : formatEpisodeKey({ season: p.season, episode: p.episode }),
    );
  }

  // Fără notificare proprie aici: downloadFilelistCore loghează deja
  // torrent_added și trimite push-ul, iar `addedVia: "auto"` face titlul
  // notificării "🤖 Descărcare Automată" în loc de "⬇️ Descărcare Inițiată".
  // Un push în plus de-aici ar dubla fiecare episod.
  stamp();
  return result;
}

// Bucla periodică: verifică serialele urmărite cărora le-a expirat cadența
// de 3 ore. Cadența e persistată în DB (watch_last_checked_at), nu într-un
// timer în memorie — altfel fiecare restart al serviciului ar reporni
// numărătoarea de la zero.
export async function checkDueShows(): Promise<void> {
  const db = getDb();
  const due = db
    .prepare(
      `SELECT id FROM media
         WHERE media_type = 'tv_show' AND auto_download = 1
           AND (watch_last_checked_at IS NULL
                OR watch_last_checked_at <= datetime('now', ?))`,
    )
    .all(`-${Math.round(ITEM_INTERVAL_MS / 1000)} seconds`) as unknown as Array<{ id: number }>;

  for (const { id } of due) {
    try {
      const outcome = await checkShow(id);
      if (outcome.downloaded.length > 0) {
        console.log(`[show-watch] "${outcome.title}" — pornite ${outcome.downloaded.length}`);
      } else if (outcome.skipped) {
        console.log(`[show-watch] "${outcome.title}" — sărit: ${outcome.skipped}`);
      }
    } catch (e) {
      console.warn(`[show-watch] Eroare la serialul ${id}:`, e);
    }
  }
}

// ---------------------------------------------------------------------------
// Setarea urmăririi (din drawer-ul serialului)
// ---------------------------------------------------------------------------

export interface SetShowWatchInput {
  mediaId: number;
  enabled: boolean;
  quality?: string;
  // "forward" (implicit) = doar episoadele care apar de-acum înainte;
  // "backfill" = și tot ce lipsește deja din istoric. Distincția contează:
  // pentru un serial cu 7 sezoane din care ai 2, "backfill" înseamnă câteva
  // zeci de episoade, deci trebuie să fie o alegere conștientă, nu implicită.
  mode?: "forward" | "backfill";
}

export async function setShowWatchCore(input: SetShowWatchInput): Promise<void> {
  const db = getDb();
  if (!input.enabled) {
    db.prepare("UPDATE media SET auto_download = 0 WHERE id = ? AND media_type = 'tv_show'").run(
      input.mediaId,
    );
    return;
  }

  let from: string | null = null;
  if ((input.mode ?? "forward") === "forward") {
    // Punctul de plecare = ce e mai târziu dintre ultimul episod deținut și
    // ultimul difuzat. Fără el, un serial din care ai doar primele sezoane
    // ar declanșa la activare descărcarea a tot ce a apărut între timp.
    const owned = db
      .prepare(
        `SELECT MAX(season * 1000 + episode) AS ord FROM media
           WHERE parent_id = ? AND season IS NOT NULL AND episode IS NOT NULL`,
      )
      .get(input.mediaId) as { ord: number | null } | undefined;
    const show = db.prepare("SELECT tmdb_id FROM media WHERE id = ?").get(input.mediaId) as
      { tmdb_id: number | null } | undefined;

    let bestOrd = owned?.ord ?? 0;
    if (show?.tmdb_id) {
      const aired = await getAiredEpisodes(show.tmdb_id, 1).catch(() => []);
      for (const k of aired) bestOrd = Math.max(bestOrd, ord(k));
    }
    if (bestOrd > 0) {
      from = formatEpisodeKey({
        season: Math.floor(bestOrd / 1000),
        episode: bestOrd % 1000,
      });
    }
  }

  db.prepare(
    `UPDATE media SET auto_download = 1, auto_download_quality = ?, auto_download_from = ?,
                      watch_last_checked_at = NULL
       WHERE id = ? AND media_type = 'tv_show'`,
  ).run(input.quality ?? "1080p", from, input.mediaId);
}

// ---------------------------------------------------------------------------
// Numele episoadelor
// ---------------------------------------------------------------------------

// Câte seriale completăm cel mult într-o rulare — cu getTmdbAllSeasonsInternal
// e o singură cerere TMDB per serial, dar nu are rost să le luăm pe toate
// deodată la prima pornire după migrare.
const MAX_TITLE_SHOWS_PER_RUN = 5;

// Umple `episode_title` pentru episoadele care încă n-au unul.
//
// Aceeași abordare declarativă ca restul fișierului: nu ținem minte ce am
// completat, ci întrebăm de fiecare dată ce lipsește. Rularea e un no-op
// ieftin (un singur SELECT) când nu lipsește nimic, se auto-repară după un
// restart, și prinde din mers atât episoadele descărcate acum, cât și cele
// existente dinaintea coloanei.
export async function fillMissingEpisodeTitles(): Promise<number> {
  const db = getDb();
  const missing = db
    .prepare(
      `SELECT e.id, e.season, e.episode, p.tmdb_id AS tmdb_id
         FROM media e
         JOIN media p ON p.id = e.parent_id
        WHERE e.media_type = 'episode'
          AND e.episode_title IS NULL
          AND e.season IS NOT NULL
          AND e.episode IS NOT NULL
          AND p.tmdb_id IS NOT NULL`,
    )
    .all() as unknown as Array<{
    id: number;
    season: number;
    episode: number;
    tmdb_id: number;
  }>;
  if (missing.length === 0) return 0;

  const byShow = new Map<number, typeof missing>();
  for (const row of missing) {
    const list = byShow.get(row.tmdb_id);
    if (list) list.push(row);
    else byShow.set(row.tmdb_id, [row]);
  }

  const { getTmdbAllSeasonsInternal } = await import("../tmdb/tmdb.functions");
  const update = db.prepare("UPDATE media SET episode_title = ? WHERE id = ?");
  let filled = 0;

  for (const [tmdbId, rows] of [...byShow].slice(0, MAX_TITLE_SHOWS_PER_RUN)) {
    const seasons = [...new Set(rows.map((r) => r.season))].sort((a, b) => a - b);
    const schema = await getTmdbAllSeasonsInternal(tmdbId, seasons).catch(() => []);
    const titles = new Map<string, string>();
    for (const s of schema) {
      for (const ep of s.episodes) {
        titles.set(`${s.seasonNumber}x${ep.episodeNum}`, ep.title);
      }
    }
    for (const r of rows) {
      const title = titles.get(`${r.season}x${r.episode}`);
      // "Episodul 8" e placeholder-ul pe care TMDB îl întoarce cât timp n-are
      // încă titlul real (frecvent în primele ore după difuzare). Nu-l
      // salvăm: ar deveni permanent, fiindcă rândul n-ar mai fi "lipsă".
      if (!title || new RegExp(`^episodul\\s*${r.episode}$`, "i").test(title)) continue;
      update.run(title, r.id);
      filled++;
    }
  }
  if (filled > 0) console.log(`[show-watch] Completate ${filled} nume de episoade`);
  return filled;
}
