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
//
// `details` vine din afară, nu îl cerem noi: apelantul are oricum nevoie de
// el (pentru metadatele descărcării), iar tmdbFetch n-are niciun cache — două
// apeluri însemnau două cereri HTTP identice la fiecare ciclu.
async function getAiredEpisodes(
  tmdbId: number,
  fromSeason: number,
  details: TmdbShowDetails | null,
): Promise<EpisodeKey[]> {
  const { getTmdbAllSeasonsInternal } = await import("../tmdb/tmdb.functions");
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

type TmdbShowDetails = Awaited<
  ReturnType<typeof import("../tmdb/tmdb.functions").getTmdbDetailsInternal>
>;

async function fetchShowDetails(tmdbId: number): Promise<TmdbShowDetails | null> {
  const { getTmdbDetailsInternal } = await import("../tmdb/tmdb.functions");
  return getTmdbDetailsInternal(tmdbId, "tv").catch(() => null);
}

// Scrie pe rândul-serial ce ține de titlu, nu de fișiere: statusul curent și
// următorul episod anunțat. Ambele vin din același răspuns TMDB, deci sunt
// gratuite oriunde avem deja `details` în mână.
//
// Ora exactă vine din altă parte: TMDB dă doar data (air_date), fără oră, așa
// că o luăm de la TVmaze — aceeași sursă folosită de wizard. `airstamp` e un
// instant ISO cu fus, deci browserul îl redă direct în ora României, fără să
// calculăm noi vreun offset. TVmaze e interogat doar când chiar există un
// episod următor, ca să nu-l batem degeaba pentru serialele încheiate.
async function writeShowMeta(
  showId: number,
  imdbId: string | null,
  details: TmdbShowDetails | null,
): Promise<void> {
  if (!details) return;
  const next = details.nextEpisode;

  let airstamp: string | null = null;
  if (next && imdbId) {
    const { getTvmazeAirstampsInternal } = await import("../tvmaze/tvmaze.functions");
    const stamps = await getTvmazeAirstampsInternal(imdbId).catch(() => []);
    airstamp =
      stamps.find(
        (a) => a.seasonNumber === next.seasonNumber && a.episodeNum === next.episodeNumber,
      )?.airstamp ?? null;
  }

  // Titlurile se împrospătează și ele. `title` (varianta de afișare, în
  // română) și `original_title` (cea în limba originală de producție) erau
  // scrise o singură dată, la crearea rândului, și rămâneau înghețate — iar
  // ramura de backfill nu completa deloc original_title și year. Rezultatul
  // s-a văzut la "The Rookie", importat din Plex pe 15 aug: title rămăsese
  // englezescul "The Rookie" deși TMDB are "Recrutul", iar original_title era
  // gol, deci nici titlul original nu apărea sub el.
  //
  // COALESCE + NULLIF: nu suprascriem cu gol dacă TMDB răspunde incomplet —
  // mai bine un titlu vechi decât niciunul.
  const year = details.releaseDate ? Number(details.releaseDate.slice(0, 4)) : null;
  const db = getDb();
  db.prepare(
    `UPDATE media
        SET title = COALESCE(NULLIF(?, ''), title),
            original_title = COALESCE(NULLIF(?, ''), original_title),
            year = COALESCE(?, year),
            tv_status = COALESCE(?, tv_status),
            next_episode = ?,
            next_episode_air_date = ?,
            next_episode_airstamp = ?,
            meta_refreshed_at = datetime('now')
      WHERE id = ?`,
  ).run(
    details.title,
    details.originalTitle,
    Number.isFinite(year) ? year : null,
    details.tvStatus,
    next ? formatEpisodeKey({ season: next.seasonNumber, episode: next.episodeNumber }) : null,
    next?.airDate ?? null,
    airstamp,
    showId,
  );

  // Episoadele poartă titlul serialului, prin convenția din `media` — dacă
  // rămâneau pe cel vechi, un episod deschis singur ar fi arătat alt nume
  // decât serialul din care face parte. `original_title` contează în plus:
  // e cheia de rezervă la potrivirea vizionărilor cu Plex, când istoricul
  // vine fără ratingKey.
  db.prepare(
    `UPDATE media
        SET title = COALESCE(NULLIF(?, ''), title),
            original_title = COALESCE(NULLIF(?, ''), original_title)
      WHERE parent_id = ?`,
  ).run(details.title, details.originalTitle, showId);
}

export interface ShowWatchOutcome {
  showId: number;
  title: string;
  missing: string[];
  downloaded: string[];
  skipped: string | null;
}

// Serialele aflate chiar acum în verificare. Restul logicii e idempotentă
// pentru rulări SUCCESIVE (compară mereu realitatea), dar nu și pentru două
// rulări SIMULTANE: butonul "Verifică acum" apăsat în timpul unui ciclu
// automat ar face ambele să vadă aceleași episoade lipsă și să pornească
// același torrent de două ori, înainte ca vreuna să apuce să scrie ceva.
const inProgress = new Set<number>();

// Verifică un singur serial și pornește descărcările lipsă. Exportată separat
// de bucla periodică fiindcă butonul "Verifică acum" din drawer o cheamă
// direct, pentru serialul deschis.
export async function checkShow(showId: number): Promise<ShowWatchOutcome> {
  if (inProgress.has(showId)) {
    return {
      showId,
      title: "?",
      missing: [],
      downloaded: [],
      skipped: "o verificare e deja în curs",
    };
  }
  inProgress.add(showId);
  try {
    return await checkShowInner(showId);
  } finally {
    inProgress.delete(showId);
  }
}

async function checkShowInner(showId: number): Promise<ShowWatchOutcome> {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, title, original_title, literal_title, imdb_id, tmdb_id, poster_path,
              tv_status, auto_download_quality, auto_download_from, requested_by_user_id
         FROM media WHERE id = ? AND media_type = 'tv_show'`,
    )
    .get(showId) as unknown as ShowRow | undefined;

  // datetime('now'), nu new Date().toISOString(): restul coloanelor de timp
  // din `media` sunt în formatul SQLite ("2026-09-06 07:54:16"), iar un ISO
  // complet ("...T07:54:16.987Z") strica două lucruri deodată. Afișarea —
  // conversia standard din UI îi mai adăuga un "Z" și ieșea dată invalidă.
  // Și, mai grav, programarea: comparația din checkDueShows e pe șiruri, iar
  // 'T' (84) > ' ' (32), deci un serial verificat azi nu devenea scadent în
  // aceeași zi oricâte ore treceau — urmărirea rula o dată pe zi, nu la 3 ore.
  const stamp = () =>
    db.prepare("UPDATE media SET watch_last_checked_at = datetime('now') WHERE id = ?").run(showId);

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

  // Un pachet de sezon pornit, dar încă neterminat, e un singur rând cu
  // episode NULL: episoadele lui apar abia după ce Plex îl indexează și
  // resolveSeasonPackPlexLinks îl desface. Până atunci episoadele lui ar
  // părea în continuare "lipsă", iar la ciclul următor am fi descărcat
  // episoadele individuale PESTE pachetul care oricum le aduce. Plasa cu
  // torrent_name de mai jos nu acoperă cazul ăsta — acolo e vorba de alt
  // torrent, cu alt nume.
  const pendingPackSeasons = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT season FROM media
             WHERE parent_id = ? AND is_season_pack = 1
               AND plex_rating_key IS NULL AND season IS NOT NULL`,
        )
        .all(row.id) as unknown as Array<{ season: number }>
    ).map((r) => r.season),
  );

  const from = parseEpisodeKey(row.auto_download_from);
  const details = await fetchShowDetails(row.tmdb_id);
  // Verificarea unui serial urmărit e și momentul în care îi împrospătăm
  // metadatele — datele sunt deja aici, ar fi risipă să le aruncăm.
  await writeShowMeta(row.id, details ? row.imdb_id : null, details);
  const aired = await getAiredEpisodes(row.tmdb_id, from ? from.season : 1, details);
  const missing = aired
    .filter((k) => !ownedKeys.has(formatEpisodeKey(k)))
    .filter((k) => !pendingPackSeasons.has(k.season))
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

  // Dacă urmărirea e DEJA pornită, singurul lucru care se schimbă e calitatea.
  // Punctul de pornire rămâne neatins: recalculându-l, o simplă schimbare de
  // calitate ar muta `auto_download_from` la ultimul episod difuzat și ar sări
  // silențios peste episoadele care încă așteptau un torrent. E exact bug-ul
  // reparat în 4a94143 la implementarea veche ("pinForMonitoring rescria
  // necondiționat setările de urmărire, resetând silențios orice
  // personalizare"), doar cu alt nume.
  const current = db
    .prepare("SELECT auto_download FROM media WHERE id = ? AND media_type = 'tv_show'")
    .get(input.mediaId) as { auto_download: number } | undefined;
  if (current?.auto_download) {
    db.prepare("UPDATE media SET auto_download_quality = ? WHERE id = ?").run(
      input.quality ?? "1080p",
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
    const show = db
      .prepare("SELECT tmdb_id, imdb_id FROM media WHERE id = ?")
      .get(input.mediaId) as { tmdb_id: number | null; imdb_id: string | null } | undefined;

    let bestOrd = owned?.ord ?? 0;
    if (show?.tmdb_id) {
      const details = await fetchShowDetails(show.tmdb_id);
      await writeShowMeta(input.mediaId, show.imdb_id, details);
      const aired = await getAiredEpisodes(show.tmdb_id, 1, details).catch(() => []);
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

// Cât timp mai sperăm că TMDB completează titlul unui episod deja difuzat,
// înainte să acceptăm placeholder-ul lui generic ca răspuns final.
const PLACEHOLDER_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

// "Episodul 8" / "Episode 8" — titlul generic pe care TMDB îl întoarce când
// episodul n-are (încă) nume propriu.
export const GENERIC_EPISODE_TITLE = /^episo(?:dul|de)\s*\d+$/i;

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
    const titles = new Map<string, { title: string; airDate: string | null }>();
    for (const s of schema) {
      for (const ep of s.episodes) {
        titles.set(`${s.seasonNumber}x${ep.episodeNum}`, { title: ep.title, airDate: ep.airDate });
      }
    }
    for (const r of rows) {
      const found = titles.get(`${r.season}x${r.episode}`);
      if (!found) continue;
      // "Episodul 8" e placeholder-ul pe care TMDB îl întoarce cât timp n-are
      // încă titlul real — frecvent în primele ore după difuzare, dar și
      // permanent pentru emisiuni ale căror episoade n-au titluri (reality
      // show-uri, televiziune locală).
      //
      // Pentru un episod difuzat recent sărim peste, ca să reîncercăm când
      // TMDB îl completează. Pentru unul difuzat demult acceptăm
      // placeholder-ul: TMDB n-o să-l mai schimbe, iar altfel rândul rămâne
      // "lipsă" pe veci și îl reinterogăm la fiecare 10 minute la nesfârșit
      // (găsit la "Insula Iubirii" S10, unde TMDB n-are titluri deloc).
      // UI-ul ascunde oricum numele generice, deci nu se vede nimic urât.
      if (GENERIC_EPISODE_TITLE.test(found.title)) {
        // Fără dată de difuzare la TMDB nu avem cum aștepta un moment anume,
        // deci acceptăm placeholder-ul direct — altfel bucla ar fi infinită
        // din alt motiv decât cel de mai sus. Un episod nedifuzat nici n-ar
        // avea rând în `media`: acolo ajunge doar ce e deja descărcat.
        const stillWorthWaiting =
          found.airDate != null &&
          Date.now() - new Date(found.airDate).getTime() <= PLACEHOLDER_GRACE_MS;
        if (stillWorthWaiting) continue;
      }
      update.run(found.title, r.id);
      filled++;
    }
  }
  if (filled > 0) console.log(`[show-watch] Completate ${filled} nume de episoade`);
  return filled;
}

// ---------------------------------------------------------------------------
// Reîmprospătarea metadatelor de serial
// ---------------------------------------------------------------------------

const META_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h per serial
const MAX_META_SHOWS_PER_RUN = 5;

// Ține la zi tv_status și următorul episod pentru TOATE serialele, nu doar
// pentru cele urmărite.
//
// tv_status era scris o singură dată, la prima descărcare, și rămânea așa pe
// veci. Conta: panoul de urmărire se ascunde exact pe `tv_status === 'Ended'`,
// deci un serial reînnoit după ce fusese marcat încheiat nu mai arăta
// niciodată butonul — adică fix pentru serialele NEurmărite era cel mai
// important să fie corect.
export async function refreshShowMetadata(): Promise<number> {
  const db = getDb();
  const due = db
    .prepare(
      `SELECT id, tmdb_id, imdb_id FROM media
         WHERE media_type = 'tv_show' AND tmdb_id IS NOT NULL
           AND (meta_refreshed_at IS NULL OR meta_refreshed_at <= datetime('now', ?))
         ORDER BY meta_refreshed_at IS NOT NULL, meta_refreshed_at
         LIMIT ?`,
    )
    .all(
      `-${Math.round(META_INTERVAL_MS / 1000)} seconds`,
      MAX_META_SHOWS_PER_RUN,
    ) as unknown as Array<{ id: number; tmdb_id: number; imdb_id: string | null }>;

  // Marchează încercarea chiar și când TMDB n-a răspuns. `meta_refreshed_at`
  // se scrie altfel doar în writeShowMeta, deci un serial al cărui tmdb_id nu
  // mai rezolvă (șters de pe TMDB, id greșit) rămânea cu NULL pe veci — iar
  // ORDER BY-ul de mai sus pune NULL-urile primele. Cinci astfel de seriale
  // ocupau permanent tot LIMIT-ul și blocau împrospătarea pentru TOATE
  // celelalte, adică exact regresia pe care funcția asta există s-o prevină.
  //
  // Costul e că o pană TMDB trecătoare amână serialele atinse cu încă 12h.
  // Acceptabil: cadența nu e critică, iar alternativa e înfometarea totală.
  const touch = db.prepare("UPDATE media SET meta_refreshed_at = datetime('now') WHERE id = ?");

  let refreshed = 0;
  for (const row of due) {
    try {
      const details = await fetchShowDetails(row.tmdb_id);
      if (!details) {
        touch.run(row.id);
        continue;
      }
      await writeShowMeta(row.id, row.imdb_id, details);
      refreshed++;
    } catch (e) {
      touch.run(row.id);
      console.warn(`[show-watch] Metadate neactualizate pentru serialul ${row.id}:`, e);
    }
  }
  if (refreshed > 0)
    console.log(`[show-watch] Metadate reîmprospătate pentru ${refreshed} seriale`);
  return refreshed;
}
