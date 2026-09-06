// ---------------------------------------------------------------------------
// Bibliotecă — pentru secțiunea de pe Acasă care înlocuiește fostul "Recent
// adăugate": listă (ordonată după data adăugării) + detalii per titlu
// (calitate, subtitrare RO, cine a văzut, durată). Necesită autentificare
// (orice cont aprobat) — spre deosebire de restul paginii Acasă, care rămâne
// publică.
//
// Atât lista cât și detaliile sunt citite exclusiv din `media` (populată
// doar de wizard/căutarea manuală Filelist — vezi media.ts): zero cereri
// Plex/TMDB live la navigare, indiferent câți utilizatori o deschid
// simultan. Un titlu care nu e adăugat prin aplicație nu apare deloc în
// Bibliotecă (nu mai există backfill retroactiv din Plex).
// ---------------------------------------------------------------------------

import { createServerFn } from "@tanstack/react-start";

// Un rând din Bibliotecă = un film SAU un serial întreg. Episoadele nu mai
// apar niciodată la nivelul listei: se văd doar înăuntrul serialului, în
// drawer. Înainte, lista era per episod și gruparea se făcea în client, doar
// între rânduri adiacente cronologic (groupConsecutiveEpisodes) — un serial
// cu episoade primite în zile diferite apărea de mai multe ori, iar
// sortarea/căutarea/paginarea lucrau tot pe episoade, nu pe seriale.
export interface PlexBrowseItem {
  // Identificator stabil, mereu prezent (id-ul rândului din `media`) —
  // pentru filme rândul filmului, pentru seriale rândul-părinte 'tv_show'.
  mediaId: number;
  ratingKey: string | null;
  title: string;
  type: "movie" | "tv_show";
  show: string | null;
  // Gata de folosit direct ca src de <img> — link TMDB, salvat în `media`.
  thumbUrl: string | null;
  // Pentru seriale: episodul cel mai recent adăugat, nu momentul în care a
  // fost creat rândul-părinte — "Recent adăugate" înseamnă atunci "ultima
  // activitate pe serial", ceea ce e chiar util (un serial care primește
  // episoade noi urcă în listă).
  addedAt: number;
  // Pentru seriale: adevărat dacă a văzut măcar un episod.
  watchedByMe: boolean;
  // Câți utilizatori distincți (din conturile Plex mapate la conturi
  // FaikkitBox) au vizionat titlul — pentru seriale, câți au văzut măcar un
  // episod. Afișat ca badge separat în listă.
  watchedCount: number;
  // Doar pentru seriale (0 la filme).
  episodeCount: number;
  seasonCount: number;
  // Câte episoade a văzut utilizatorul curent — arătat ca "12/36", mai util
  // decât o bifă pentru un serial.
  watchedEpisodes: number;
  // Câte episoade sunt încă în descărcare/procesare.
  downloadingCount: number;
  // Urmărire episoade noi activă pe serial.
  autoDownload: boolean;
  // "downloading" — are torrent, dar Plex nu l-a indexat încă; "processing"
  // — torrentul s-a terminat (completed_at setat), se așteaptă doar
  // legarea la Plex (vezi fereastra de retry din download.ts); "in_library"
  // — normal, deja în Plex.
  status: "in_library" | "downloading" | "processing";
  // Progres live din qBittorrent — populate doar pentru status "downloading"
  // cu torrent_hash cunoscut; null dacă torrentul nu mai e găsit acolo
  // (ex. șters manual) sau qBit nu e configurat/disponibil.
  progress: number | null; // 0-100
  dlspeed: number | null; // bytes/s
  eta: number | null; // secunde
}

// ---------------------------------------------------------------------------
// Progres live qBittorrent — un singur request cu toate hash-urile relevante,
// reutilizat atât de listă cât și de detalii (vezi qbit-client.ts pentru
// autentificarea cu cookie SID + retry).
// ---------------------------------------------------------------------------

interface QbitProgressInfo {
  progress: number;
  dlspeed: number;
  eta: number;
}

async function fetchQbitProgress(hashes: string[]): Promise<Map<string, QbitProgressInfo>> {
  const result = new Map<string, QbitProgressInfo>();
  if (hashes.length === 0) return result;
  const base = process.env.QBIT_URL;
  const user = process.env.QBIT_USERNAME;
  const pass = process.env.QBIT_PASSWORD;
  if (!base || !user || !pass) return result;
  try {
    const { qbitGet } = await import("../qbit-client");
    const url = base.replace(/\/$/, "");
    const res = await qbitGet(url, `/api/v2/torrents/info?hashes=${hashes.join("|")}`, user, pass);
    if (!res.ok) return result;
    const list = (await res.json()) as Array<{
      hash: string;
      progress: number;
      dlspeed: number;
      eta: number;
    }>;
    for (const t of list) {
      result.set(t.hash, { progress: t.progress, dlspeed: t.dlspeed, eta: t.eta });
    }
  } catch {
    // qBit indisponibil — badge-ul rămâne fără procent, nu blocăm lista.
  }
  return result;
}

const BROWSE_LIMIT = 300;

// Fallback pentru "Marchează ca vizionat" din Plex (setează viewCount pe
// item, dar NU scrie o intrare de istoric/scrobble — invizibil pentru
// PlexWatchedIndex, oricât de bine ar potrivi ratingKey-ul). Sigur doar
// pentru owner-ul serverului (singurul cont ale cărui viewCount-uri sunt
// reflectate corect de PLEX_TOKEN) — vezi getPlexOwnerUsername în plex.ts.
// Un singur loc, folosit identic de listă și de drawer.
async function getOwnerViewedAtByRatingKey(
  myPlexUsername: string | null,
  candidateRatingKeys: string[],
): Promise<Map<string, number>> {
  if (!myPlexUsername || candidateRatingKeys.length === 0) return new Map();
  const { getPlexOwnerUsername, getPlexViewedRatingKeys } = await import("./plex");
  const ownerUsername = await getPlexOwnerUsername();
  if (myPlexUsername !== ownerUsername) return new Map();
  return getPlexViewedRatingKeys(candidateRatingKeys);
}

interface MediaBrowseRow {
  id: number;
  parent_id: number | null;
  plex_rating_key: string | null;
  media_type: string;
  title: string;
  original_title: string | null;
  season: number | null;
  episode: number | null;
  poster_path: string | null;
  plex_added_at: number | null;
  added_at: string;
  torrent_hash: string | null;
  completed_at: string | null;
  auto_download: number;
}

function rowAddedAt(r: MediaBrowseRow): number {
  return (
    r.plex_added_at ?? Math.floor(new Date(`${r.added_at.replace(" ", "T")}Z`).getTime() / 1000)
  );
}

function rowStatus(r: MediaBrowseRow): PlexBrowseItem["status"] {
  return r.plex_rating_key ? "in_library" : r.completed_at ? "processing" : "downloading";
}

export const getPlexLibraryBrowse = createServerFn({ method: "GET" }).handler(
  async (): Promise<
    { status: "ok"; items: PlexBrowseItem[] } | { status: "error"; error: string }
  > => {
    const { requireAuth } = await import("../auth/admin.server");
    const session = await requireAuth();
    try {
      const { getDb } = await import("../db");
      const db = getDb();

      // Bibliotecă arată doar conținut real: deja confirmat în Plex
      // (plex_rating_key cunoscut, indiferent de sursă: descărcat prin
      // aplicație SAU backfill din restul bibliotecii), sau în curs de
      // descărcare (torrent_hash cunoscut, încă neindexat de Plex).
      //
      // Rândurile-părinte 'tv_show' intră și ele, fără condiția de conținut
      // real (n-au niciodată torrent propriu) — dar doar dacă au măcar un
      // episod; un serial fără episoade n-are ce căuta în Bibliotecă.
      const rows = db
        .prepare(
          `SELECT m.id, m.parent_id, m.plex_rating_key, m.media_type, m.title, m.original_title,
                  m.season, m.episode, m.poster_path, m.plex_added_at, m.added_at,
                  m.torrent_hash, m.completed_at, m.auto_download
           FROM media m
           WHERE (
                   m.media_type IN ('movie', 'episode')
                   AND (m.torrent_hash IS NOT NULL OR m.plex_rating_key IS NOT NULL)
                 )
              OR (
                   m.media_type = 'tv_show'
                   AND EXISTS (SELECT 1 FROM media e WHERE e.parent_id = m.id)
                 )
           ORDER BY COALESCE(m.plex_added_at, CAST(strftime('%s', m.added_at) AS INTEGER)) DESC`,
        )
        .all() as unknown as MediaBrowseRow[];

      // Episoadele nu devin rânduri de listă; ele alimentează agregatele
      // serialului lor. Le ținem separat, indexate pe parent_id, fiindcă mai
      // jos avem nevoie de ele și pentru "cine a văzut" (potrivirea cu
      // istoricul Plex se face per episod, nu per serial).
      const byId = new Map(rows.map((r) => [r.id, r]));
      const episodesByParent = new Map<number, MediaBrowseRow[]>();
      for (const r of rows) {
        if (r.media_type !== "episode" || r.parent_id == null) continue;
        const list = episodesByParent.get(r.parent_id);
        if (list) list.push(r);
        else episodesByParent.set(r.parent_id, [r]);
      }

      const items: PlexBrowseItem[] = [];
      for (const r of rows) {
        if (r.media_type === "episode") continue;
        if (r.media_type === "movie") {
          items.push({
            mediaId: r.id,
            ratingKey: r.plex_rating_key,
            title: r.title,
            type: "movie",
            show: null,
            thumbUrl: r.poster_path,
            addedAt: rowAddedAt(r),
            watchedByMe: false,
            watchedCount: 0,
            episodeCount: 0,
            seasonCount: 0,
            watchedEpisodes: 0,
            downloadingCount: 0,
            autoDownload: false,
            status: rowStatus(r),
            progress: null,
            dlspeed: null,
            eta: null,
          });
          continue;
        }
        const episodes = episodesByParent.get(r.id) ?? [];
        if (episodes.length === 0) continue;
        const pending = episodes.filter((e) => rowStatus(e) !== "in_library");
        items.push({
          mediaId: r.id,
          ratingKey: null,
          // Pentru seriale, `title` pe rândul din `media` e deja titlul
          // serialului (nu se ține un titlu separat per episod).
          title: "",
          type: "tv_show",
          show: r.title,
          // Rândul-părinte are de regulă posterul serialului; dacă lipsește
          // (seriale vechi din backfill), cădem pe al primului episod.
          thumbUrl: r.poster_path ?? episodes.find((e) => e.poster_path)?.poster_path ?? null,
          addedAt: Math.max(...episodes.map(rowAddedAt)),
          watchedByMe: false,
          watchedCount: 0,
          episodeCount: episodes.length,
          seasonCount: new Set(episodes.map((e) => e.season).filter((s) => s != null)).size,
          watchedEpisodes: 0,
          downloadingCount: pending.length,
          autoDownload: !!r.auto_download,
          // Serialul e "în descărcare" cât timp are măcar un episod care nu
          // a ajuns încă în Plex — badge-ul din listă arată atunci câte.
          status: pending.length > 0 ? "downloading" : "in_library",
          progress: null,
          dlspeed: null,
          eta: null,
        });
      }
      items.sort((a, b) => b.addedAt - a.addedAt);
      items.splice(BROWSE_LIMIT);

      // Progres live: un singur request către qBit cu toate hash-urile
      // titlurilor încă în descărcare, nu unul per titlu. Pentru un serial,
      // hash-urile relevante sunt ale episoadelor lui neajunse încă în Plex
      // (pot fi mai multe, sau unul singur dacă e un pachet de sezon), iar
      // progresul afișat e media lor — un singur procent pe rândul din listă.
      const hashesByMediaId = new Map<number, string[]>();
      for (const item of items) {
        const source =
          item.type === "tv_show"
            ? (episodesByParent.get(item.mediaId) ?? [])
            : [byId.get(item.mediaId)!];
        const hashes = [
          ...new Set(
            source
              .filter((r) => r && !r.plex_rating_key && r.torrent_hash)
              .map((r) => r.torrent_hash!),
          ),
        ];
        if (hashes.length > 0) hashesByMediaId.set(item.mediaId, hashes);
      }
      if (hashesByMediaId.size > 0) {
        const progressByHash = await fetchQbitProgress([
          ...new Set([...hashesByMediaId.values()].flat()),
        ]);
        for (const item of items) {
          const infos = (hashesByMediaId.get(item.mediaId) ?? [])
            .map((h) => progressByHash.get(h))
            .filter((i) => i !== undefined);
          if (infos.length > 0) {
            const avg = infos.reduce((s, i) => s + i.progress, 0) / infos.length;
            item.progress = Math.round(avg * 1000) / 10;
            item.dlspeed = infos.reduce((s, i) => s + i.dlspeed, 0);
            item.eta = Math.max(...infos.map((i) => i.eta));
          }
        }
      }

      // "Am văzut" + "văzut de N" — badge-uri afișate direct în listă, fără
      // cost suplimentar (nicio cerere nouă către Plex): potrivim doar cu
      // istoricul deja cachuit, pentru toți utilizatorii deodată.
      const me = db
        .prepare("SELECT plex_username FROM users WHERE id = ?")
        .get(session.data.userId!) as { plex_username: string | null } | undefined;
      const myPlexUsername = me?.plex_username ?? null;
      if (!myPlexUsername) return { status: "ok", items };

      const { getAllPlexWatchedIndexes, isItemWatched } = await import("./plex");
      const allWatchedIndexes = await getAllPlexWatchedIndexes();

      // Potrivirea cu istoricul Plex rămâne per episod (asta e granularitatea
      // la care Plex ține evidența); pentru un serial doar agregăm rezultatul:
      // "văzut de N" = câți au văzut măcar un episod, iar pentru utilizatorul
      // curent păstrăm și câte episoade a văzut, ca să putem arăta "12/36".
      const unitsFor = (it: PlexBrowseItem): MediaBrowseRow[] =>
        it.type === "tv_show" ? (episodesByParent.get(it.mediaId) ?? []) : [byId.get(it.mediaId)!];
      const matchOf = (r: MediaBrowseRow) => {
        const titleForMatch = r.original_title || r.title;
        return {
          ratingKey: r.plex_rating_key,
          title: titleForMatch,
          show: r.media_type === "episode" ? titleForMatch : null,
          season: r.season,
          episode: r.episode,
        };
      };

      const withWatched = items.map((it) => {
        const units = unitsFor(it).filter(Boolean);
        const matches = units.map(matchOf);
        let watchedCount = 0;
        let watchedByMe = false;
        let watchedEpisodes = 0;
        for (const [username, index] of Object.entries(allWatchedIndexes)) {
          const seen = matches.filter((m) => isItemWatched(index, m));
          if (seen.length === 0) continue;
          watchedCount += 1;
          if (username === myPlexUsername) {
            watchedByMe = true;
            watchedEpisodes = seen.length;
          }
        }
        return { ...it, watchedByMe, watchedCount, watchedEpisodes };
      });

      // Fallback pentru "Marchează ca vizionat" din Plex (vezi
      // getOwnerViewedAtByRatingKey) — tot per episod, agregat la fel.
      const ratingKeysByItem = new Map(
        withWatched.map((it) => [
          it.mediaId,
          unitsFor(it)
            .filter((r) => r?.plex_rating_key)
            .map((r) => r.plex_rating_key!),
        ]),
      );
      // Doar titlurile care nu-mi apar deja integral ca văzute — cheile plec
      // toate într-un singur URL către Plex, deci lista trebuie să rămână
      // mărginită pe măsură ce biblioteca crește.
      const ownerViewedAt = await getOwnerViewedAtByRatingKey(
        myPlexUsername,
        withWatched
          .filter((it) => it.watchedEpisodes < (ratingKeysByItem.get(it.mediaId)?.length ?? 0))
          .flatMap((it) => ratingKeysByItem.get(it.mediaId) ?? [])
          .slice(0, 400),
      );
      if (ownerViewedAt.size > 0) {
        for (const it of withWatched) {
          const seen = (ratingKeysByItem.get(it.mediaId) ?? []).filter((k) => ownerViewedAt.has(k));
          if (seen.length === 0) continue;
          if (!it.watchedByMe) {
            it.watchedByMe = true;
            it.watchedCount += 1;
          }
          it.watchedEpisodes = Math.max(it.watchedEpisodes, seen.length);
        }
      }
      return { status: "ok", items: withWatched };
    } catch (e) {
      return { status: "error", error: e instanceof Error ? e.message : String(e) };
    }
  },
);

// ---------------------------------------------------------------------------
// Detalii complete pentru un titlu — la click pe un rând din listă
// ---------------------------------------------------------------------------

export interface ShowEpisodeEntry {
  mediaId: number;
  season: number | null;
  episode: number | null;
  addedAt: number;
  status: "in_library" | "downloading" | "processing";
  watchedByMe: boolean;
  isSeasonPack: boolean;
}

export interface PlexTitleDetail {
  mediaId: number;
  ratingKey: string | null;
  title: string;
  type: "movie" | "episode" | "tv_show";
  show: string | null;
  season: number | null;
  episode: number | null;
  // Gata de folosit direct ca src de <img> — link TMDB, salvat în `media`.
  thumbUrl: string | null;
  addedAt: number;
  durationMs: number;
  year: number | null;
  quality: string | null;
  hasRomanianSubtitle: boolean;
  hasRomanianAudio: boolean;
  summary: string | null;
  genres: string[];
  watchedByMe: boolean;
  watchedByMeAt: number | null;
  watchedByOthers: Array<{ username: string; viewedAt: number }>;
  addedByUsername: string | null;
  status: "in_library" | "downloading" | "processing";
  // Progres live din qBittorrent — vezi PlexBrowseItem.
  progress: number | null;
  dlspeed: number | null;
  eta: number | null;
  // Butoanele de corectare/ștergere subtitrare și ștergere completă operează
  // direct pe media.id + torrentHash.
  torrentHash: string | null;
  // true dacă intrarea găsită e un pachet de sezon întreg, nu doar acest
  // episod — ștergerea/corectarea ar afecta atunci tot pachetul.
  isSeasonPack: boolean;
  // true doar pentru cel care a adăugat titlul sau pentru un admin — UI-ul
  // ascunde butoanele de subtitrare/ștergere pentru oricine altcineva.
  canManage: boolean;
  tmdbId: number | null;
  originalTitle: string | null;
  // Vizibil pentru toți (nu doar admin, spre deosebire de tech.imdbId) —
  // folosit direct pentru butonul de link către IMDb.
  imdbId: string | null;
  // Doar pentru 'tv_show': episoadele deținute, în ordine, ca drawer-ul să
  // le poată lista pe sezoane fără încă o cerere. Un episod deschis de-aici
  // își cere propriile detalii complete, cu getPlexTitleDetail(mediaId).
  episodes: ShowEpisodeEntry[];
  // Doar pentru 'tv_show': starea urmăririi (vezi coloanele din `media`).
  tvStatus: string | null;
  autoDownload: boolean;
  autoDownloadQuality: string | null;
  autoDownloadFrom: string | null;
  watchLastCheckedAt: string | null;
  // Detalii tehnice — populate doar pentru admin (vezi isAdminOrOwner mai
  // jos); UI-ul le ascunde complet pentru restul utilizatorilor.
  tech: {
    imdbId: string | null;
    torrentName: string | null;
    categoryName: string | null;
    sizeBytes: number;
    freeleech: boolean;
    internal: boolean;
    savePath: string | null;
    addedVia: string | null;
    completedAt: string | null;
    subtitleSource: string | null;
    subtitleDetail: string | null;
    subtitleCheckedAt: string | null;
    plexRatingKey: string | null;
  } | null;
}

interface MediaRow {
  id: number;
  media_type: string;
  title: string;
  original_title: string | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  season: number | null;
  episode: number | null;
  poster_path: string | null;
  year: number | null;
  overview_ro: string | null;
  genres: string;
  quality: string | null;
  has_romanian_subtitle: number;
  has_romanian_audio: number;
  duration_ms: number | null;
  torrent_name: string | null;
  torrent_hash: string | null;
  category_name: string | null;
  size: number;
  freeleech: number;
  internal: number;
  save_path: string | null;
  added_via: string | null;
  plex_rating_key: string | null;
  is_season_pack: number;
  requested_by_user_id: number | null;
  added_at: string;
  completed_at: string | null;
  subtitle_source: string | null;
  subtitle_detail: string | null;
  subtitle_checked_at: string | null;
  tv_status: string | null;
  auto_download: number;
  auto_download_quality: string | null;
  auto_download_from: string | null;
  watch_last_checked_at: string | null;
}

// Orice titlu clicabil din Bibliotecă are un rând `media` (lista provine
// exclusiv de-acolo) — răspunsul e mereu doar SELECT-uri, fără nicio cerere
// Plex/TMDB live. Singurul lucru încă live e "cine a văzut" (istoricul Plex,
// cache-uit separat 60s) — n-are sens duplicat static, s-ar dezactualiza la
// fiecare vizionare nouă.
async function buildDetailFromMediaRow(
  row: MediaRow,
  session: { data: { userId?: number; admin?: boolean } },
): Promise<PlexTitleDetail> {
  const { getDb } = await import("../db");
  const { isAdminOrOwner } = await import("../auth/admin.server");
  const db = getDb();

  const isEpisode = row.media_type === "episode";
  const isShow = row.media_type === "tv_show";

  const me = session.data.userId
    ? (db.prepare("SELECT plex_username FROM users WHERE id = ?").get(session.data.userId) as
        { plex_username: string | null } | undefined)
    : undefined;
  const myPlexUsername = me?.plex_username ?? null;

  // Pentru un serial, episoadele sunt necesare din două motive: lista pe
  // sezoane din drawer, și "cine a văzut" — Plex ține evidența per episod,
  // deci un serial e "văzut de X" dacă X a văzut măcar un episod al lui.
  const epRows = isShow
    ? (db
        .prepare(
          `SELECT id, season, episode, original_title, title, plex_rating_key, plex_added_at,
                  added_at, completed_at, is_season_pack
             FROM media WHERE parent_id = ?
             ORDER BY season, episode`,
        )
        .all(row.id) as unknown as Array<{
        id: number;
        season: number | null;
        episode: number | null;
        original_title: string | null;
        title: string;
        plex_rating_key: string | null;
        plex_added_at: number | null;
        added_at: string;
        completed_at: string | null;
        is_season_pack: number;
      }>)
    : [];

  const { getAllPlexWatchedIndexes, getWatchedAt } = await import("./plex");
  const titleForMatch = row.original_title || row.title;
  const allWatchedIndexes = await getAllPlexWatchedIndexes();
  const matchUnits = isShow
    ? epRows.map((e) => ({
        ratingKey: e.plex_rating_key,
        title: e.original_title || e.title,
        show: e.original_title || e.title,
        season: e.season,
        episode: e.episode,
      }))
    : [
        {
          ratingKey: row.plex_rating_key,
          title: titleForMatch,
          show: isEpisode ? titleForMatch : null,
          season: row.season,
          episode: row.episode,
        },
      ];
  const watchedByAll: Array<{ username: string; viewedAt: number }> = [];
  for (const [username, index] of Object.entries(allWatchedIndexes)) {
    // Pentru serial reținem cea mai recentă vizionare dintre episoade — un
    // singur rând per utilizator, ca la film.
    const viewedAts = matchUnits
      .map((u) => getWatchedAt(index, u))
      .filter((v): v is number => v != null);
    if (viewedAts.length === 0) continue;
    watchedByAll.push({ username, viewedAt: Math.max(...viewedAts) });
  }

  if (!isShow && row.plex_rating_key && !watchedByAll.some((w) => w.username === myPlexUsername)) {
    const ownerViewedAt = await getOwnerViewedAtByRatingKey(myPlexUsername, [row.plex_rating_key]);
    const lastViewedAt = ownerViewedAt.get(row.plex_rating_key);
    if (lastViewedAt != null && myPlexUsername) {
      watchedByAll.push({ username: myPlexUsername, viewedAt: lastViewedAt });
    }
  }
  const myWatched = myPlexUsername
    ? watchedByAll.find((w) => w.username === myPlexUsername)
    : undefined;
  const watchedByMe = !!myWatched;
  const watchedByMeAt = myWatched && myWatched.viewedAt > 0 ? myWatched.viewedAt : null;
  const watchedByOthers = watchedByAll.filter((w) => w.username !== myPlexUsername);

  const canManage = isAdminOrOwner(session, row.requested_by_user_id);
  const isAdmin = !!session.data.admin;

  // Episoadele serialului — pentru lista pe sezoane din drawer. "Văzut" se
  // potrivește per episod, ca peste tot (Plex ține evidența la nivel de
  // episod), refolosind indexul deja încărcat mai sus.
  let episodes: ShowEpisodeEntry[] = [];
  if (isShow) {
    const { isItemWatched } = await import("./plex");
    const myIndex = myPlexUsername ? allWatchedIndexes[myPlexUsername] : undefined;
    episodes = epRows.map((e) => {
      const epTitle = e.original_title || e.title;
      return {
        mediaId: e.id,
        season: e.season,
        episode: e.episode,
        addedAt:
          e.plex_added_at ??
          Math.floor(new Date(`${e.added_at.replace(" ", "T")}Z`).getTime() / 1000),
        status: e.plex_rating_key ? "in_library" : e.completed_at ? "processing" : "downloading",
        watchedByMe: myIndex
          ? isItemWatched(myIndex, {
              ratingKey: e.plex_rating_key,
              title: epTitle,
              show: epTitle,
              season: e.season,
              episode: e.episode,
            })
          : false,
        isSeasonPack: !!e.is_season_pack,
      };
    });
  }

  let progress: number | null = null;
  let dlspeed: number | null = null;
  let eta: number | null = null;
  if (!row.plex_rating_key && row.torrent_hash) {
    const info = (await fetchQbitProgress([row.torrent_hash])).get(row.torrent_hash);
    if (info) {
      progress = Math.round(info.progress * 1000) / 10;
      dlspeed = info.dlspeed;
      eta = info.eta;
    }
  }

  let addedByUsername: string | null = null;
  if (row.requested_by_user_id != null) {
    const u = db
      .prepare("SELECT username FROM users WHERE id = ?")
      .get(row.requested_by_user_id) as { username: string } | undefined;
    addedByUsername = u?.username ?? null;
  }

  return {
    mediaId: row.id,
    ratingKey: row.plex_rating_key,
    title: isEpisode || isShow ? "" : row.title,
    type: isEpisode ? "episode" : isShow ? "tv_show" : "movie",
    show: isEpisode || isShow ? row.title : null,
    season: row.season,
    episode: row.episode,
    thumbUrl: row.poster_path,
    addedAt: Math.floor(new Date(`${row.added_at.replace(" ", "T")}Z`).getTime() / 1000),
    durationMs: row.duration_ms ?? 0,
    year: row.year,
    quality: row.quality,
    hasRomanianSubtitle: !!row.has_romanian_subtitle,
    hasRomanianAudio: !!row.has_romanian_audio,
    summary: row.overview_ro,
    genres: JSON.parse(row.genres || "[]"),
    watchedByMe,
    watchedByMeAt,
    watchedByOthers,
    addedByUsername,
    status: row.plex_rating_key ? "in_library" : row.completed_at ? "processing" : "downloading",
    progress,
    dlspeed,
    eta,
    torrentHash: row.torrent_hash,
    isSeasonPack: !!row.is_season_pack,
    canManage,
    tmdbId: row.tmdb_id,
    originalTitle: row.original_title,
    imdbId: row.imdb_id,
    episodes,
    tvStatus: row.tv_status,
    autoDownload: !!row.auto_download,
    autoDownloadQuality: row.auto_download_quality,
    autoDownloadFrom: row.auto_download_from,
    watchLastCheckedAt: row.watch_last_checked_at,
    tech: isAdmin
      ? {
          imdbId: row.imdb_id,
          torrentName: row.torrent_name,
          categoryName: row.category_name,
          sizeBytes: row.size,
          freeleech: !!row.freeleech,
          internal: !!row.internal,
          savePath: row.save_path,
          addedVia: row.added_via,
          completedAt: row.completed_at,
          subtitleSource: row.subtitle_source,
          subtitleDetail: row.subtitle_detail,
          subtitleCheckedAt: row.subtitle_checked_at,
          plexRatingKey: row.plex_rating_key,
        }
      : null,
  };
}

export const getPlexTitleDetail = createServerFn({ method: "GET" })
  .validator((data: { mediaId: number }) => data)
  .handler(
    async ({
      data,
    }): Promise<{ status: "ok"; detail: PlexTitleDetail } | { status: "error"; error: string }> => {
      const { requireAuth } = await import("../auth/admin.server");
      const session = await requireAuth();

      const { getDb } = await import("../db");
      const mediaRow = getDb()
        .prepare(
          `SELECT id, media_type, title, original_title, imdb_id, tmdb_id, season, episode, poster_path, year,
           overview_ro, genres, quality, has_romanian_subtitle, has_romanian_audio, duration_ms, torrent_name, torrent_hash,
           category_name, size, freeleech, internal, save_path, added_via,
           plex_rating_key, is_season_pack, requested_by_user_id, added_at, completed_at,
           subtitle_source, subtitle_detail, subtitle_checked_at,
           tv_status, auto_download, auto_download_quality, auto_download_from, watch_last_checked_at
           FROM media WHERE id = ?`,
        )
        .get(data.mediaId) as MediaRow | undefined;
      if (!mediaRow) {
        return { status: "error", error: "Titlul nu a fost găsit" };
      }
      return { status: "ok", detail: await buildDetailFromMediaRow(mediaRow, session) };
    },
  );

// ---------------------------------------------------------------------------
// "Vizionări recente" — card pe Acasă. Sursa afișată e `recent_watch_cache`
// (supraviețuiește ștergerii titlului din `media`, vezi recent-watch-cache.ts);
// aici doar recalculăm live din PlexWatchedIndex ce s-a schimbat față de
// ultima citire și scriem diferența în cache, cât timp titlul mai există în
// `media` — nu putem detecta vizionări noi pentru un titlu deja șters.
// ---------------------------------------------------------------------------

export interface RecentWatch {
  ratingKey: string;
  title: string;
  show: string | null;
  season: number | null;
  episode: number | null;
  episodeEnd: number | null;
  thumbUrl: string | null;
  username: string;
  viewedAt: number;
  completed: boolean;
  progressMinutes: number | null;
  durationMinutes: number | null;
}

// Unește episoade consecutive din același serial/sezon/user într-un singur
// card (ex. S02E03-E05), ca "Vizionări recente" să nu se umple cu rânduri
// separate pentru un maraton de episoade — grupare pur pe array-ul deja
// calculat, fără nicio schimbare de schemă. Doar episoadele terminate
// complet se unesc — un episod neterminat rămâne pe rândul lui, altfel
// minutele afișate ("34/41 min") ar părea să se refere la tot intervalul
// unit, nu la ultimul episod din el.
function mergeConsecutiveEpisodes(items: RecentWatch[]): RecentWatch[] {
  const episodeGroups = new Map<string, RecentWatch[]>();
  const rest: RecentWatch[] = [];

  for (const item of items) {
    if (item.show == null || item.season == null || item.episode == null || !item.completed) {
      rest.push(item);
      continue;
    }
    const key = `${item.username}|${item.show}|${item.season}`;
    const group = episodeGroups.get(key);
    if (group) group.push(item);
    else episodeGroups.set(key, [item]);
  }

  const merged: RecentWatch[] = [...rest];
  for (const group of episodeGroups.values()) {
    group.sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
    let run: RecentWatch[] = [];
    const flush = () => {
      if (run.length === 0) return;
      const latest = run.reduce((a, b) => (b.viewedAt > a.viewedAt ? b : a));
      merged.push({
        ...latest,
        episode: run[0].episode,
        episodeEnd: run.length > 1 ? run[run.length - 1].episode : null,
      });
      run = [];
    };
    for (const item of group) {
      const last = run[run.length - 1];
      if (last && item.episode === (last.episode ?? 0) + 1) run.push(item);
      else {
        flush();
        run = [item];
      }
    }
    flush();
  }
  return merged;
}

const RECENT_WATCH_WINDOW_SECONDS = 30 * 24 * 60 * 60;
const RECENT_TITLES_LIMIT = 200;

export const getRecentWatches = createServerFn({ method: "GET" }).handler(
  async (): Promise<
    { status: "ok"; items: RecentWatch[] } | { status: "error"; error: string }
  > => {
    await (await import("../auth/admin.server")).requireAuth();
    try {
      const { getDb } = await import("../db");
      const db = getDb();

      const rows = db
        .prepare(
          `SELECT plex_rating_key, media_type, title, original_title, season, episode, poster_path
           FROM media
           WHERE media_type IN ('movie', 'episode')
             AND plex_rating_key IS NOT NULL
           ORDER BY added_at DESC
           LIMIT ?`,
        )
        .all(RECENT_TITLES_LIMIT) as unknown as Array<{
        plex_rating_key: string | null;
        media_type: string;
        title: string;
        original_title: string | null;
        season: number | null;
        episode: number | null;
        poster_path: string | null;
      }>;

      const cutoff = Math.floor(Date.now() / 1000) - RECENT_WATCH_WINDOW_SECONDS;

      // Recalculează live doar cât timp titlul mai există în `media` — pentru
      // ce mai găsește, ține-o minte în `recent_watch_cache`, ca titlul să
      // rămână vizibil aici și după ce e șters din Bibliotecă (torrent +
      // rândul `media`), nu doar cât există local.
      if (rows.length > 0) {
        const { getAllPlexWatchedIndexes, getWatchedAt } = await import("./plex");
        const { createRecentWatchUpserter } = await import("./recent-watch-cache");
        const allWatchedIndexes = await getAllPlexWatchedIndexes();
        const upsert = createRecentWatchUpserter(db);
        for (const row of rows) {
          const isEpisode = row.media_type === "episode";
          const titleForMatch = row.original_title || row.title;
          for (const [username, index] of Object.entries(allWatchedIndexes)) {
            const viewedAt = getWatchedAt(index, {
              ratingKey: row.plex_rating_key,
              title: titleForMatch,
              show: isEpisode ? titleForMatch : null,
              season: row.season,
              episode: row.episode,
            });
            if (viewedAt == null || viewedAt < cutoff) continue;
            upsert({
              ratingKey: row.plex_rating_key!,
              username,
              title: isEpisode ? "" : row.title,
              show: isEpisode ? row.title : null,
              season: row.season,
              episode: row.episode,
              posterPath: row.poster_path,
              viewedAt,
              viewOffsetMs: null,
              durationMs: null,
              completed: true,
            });
          }
        }
      }

      db.prepare("DELETE FROM recent_watch_cache WHERE viewed_at < ?").run(cutoff);
      const cached = db
        .prepare(
          `SELECT plex_rating_key, username, title, show, season, episode, poster_path, viewed_at,
                  view_offset_ms, duration_ms, completed
           FROM recent_watch_cache
           WHERE viewed_at >= ?
           ORDER BY viewed_at DESC
           LIMIT 100`,
        )
        .all(cutoff) as unknown as Array<{
        plex_rating_key: string;
        username: string;
        title: string;
        show: string | null;
        season: number | null;
        episode: number | null;
        poster_path: string | null;
        viewed_at: number;
        view_offset_ms: number | null;
        duration_ms: number | null;
        completed: number;
      }>;

      const items: RecentWatch[] = cached.map((row) => ({
        ratingKey: row.plex_rating_key,
        title: row.show ? "" : row.title,
        show: row.show,
        season: row.season,
        episode: row.episode,
        episodeEnd: null,
        completed: !!row.completed,
        progressMinutes:
          !row.completed && row.view_offset_ms != null
            ? Math.round(row.view_offset_ms / 60_000)
            : null,
        durationMinutes:
          !row.completed && row.duration_ms != null ? Math.round(row.duration_ms / 60_000) : null,
        thumbUrl: row.poster_path,
        username: row.username,
        viewedAt: row.viewed_at,
      }));
      const merged = mergeConsecutiveEpisodes(items);
      merged.sort((a, b) => b.viewedAt - a.viewedAt);
      return { status: "ok", items: merged.slice(0, 8) };
    } catch (e) {
      return { status: "error", error: e instanceof Error ? e.message : String(e) };
    }
  },
);
