// ---------------------------------------------------------------------------
// Sursă unică pentru datele unui titlu media — vezi schema `media` din db.ts.
// Populată exclusiv de căile de descărcare (wizard, căutare manuală
// Filelist cu rezolvare TMDB best-effort) — vezi upsertMediaEntry.
// ---------------------------------------------------------------------------

import { getDb } from "../db";

// "auto" = pornit de urmărirea serialelor (show-watch.ts), fără intervenție
// umană — singurul caz în care un torrent apare în bibliotecă fără ca cineva
// să fi apăsat ceva, deci merită deosebit în notificări.
export type AddedVia = "wizard" | "manual" | "backfill" | "auto";

export interface UpsertMediaEntryInput {
  mediaType: "movie" | "episode";
  imdbId: string | null;
  tmdbId: number | null;
  title: string;
  originalTitle?: string | null;
  literalTitle?: string | null;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
  overviewRo?: string | null;
  genres?: string[];
  posterPath?: string | null;
  tvStatus?: string | null;
  torrentName?: string | null;
  torrentHash?: string | null;
  category?: number | null;
  categoryName?: string | null;
  size?: number;
  freeleech?: boolean;
  internal?: boolean;
  savePath?: string | null;
  isSeasonPack?: boolean;
  addedVia: AddedVia;
  requestedByUserId?: number | null;
}

// Găsește un rând `media` fără proveniență de torrent deja existent (rândul-
// părinte al unui serial, sau un placeholder de film creat la căutare) —
// prioritar după tmdb_id (mereu prezent odată rezolvat prin TMDB, spre
// deosebire de imdb_id, absent pentru multe titluri — reality show-uri,
// producții locale etc). SQL `imdb_id = NULL` nu se potrivește niciodată cu
// sine (semantica NULL), deci un lookup doar pe imdb_id ar crea un rând nou
// de fiecare dată pentru un titlu fără imdb_id — exact bug-ul reprodus la
// primul backfill (opt rânduri "Elita" în loc de unul). Cade pe imdb_id,
// apoi pe titlu exact (fără niciun id cunoscut), ca ultimă plasă de
// siguranță.
function findExistingMediaRow(
  mediaType: "movie" | "tv_show",
  input: { imdbId: string | null; tmdbId: number | null; title: string },
): number | null {
  const db = getDb();
  if (input.tmdbId != null) {
    const row = db
      .prepare("SELECT id FROM media WHERE media_type = ? AND tmdb_id = ?")
      .get(mediaType, input.tmdbId) as { id: number } | undefined;
    if (row) return row.id;
  }
  if (input.imdbId) {
    const row = db
      .prepare("SELECT id FROM media WHERE media_type = ? AND imdb_id = ?")
      .get(mediaType, input.imdbId) as { id: number } | undefined;
    if (row) return row.id;
  }
  // Plasa de titlu-exact e folosită DOAR când input-ul curent nu are el
  // însuși un tmdb_id/imdb_id rezolvat — altfel, pentru un titlu nou cu
  // tmdb_id rezolvat dar fără rând încă în `media`, s-ar putea potrivi din
  // greșeală cu un placeholder vechi, nerezolvat, al unui titlu DIFERIT care
  // are întâmplător exact același nume (remake-uri, titluri generice),
  // lipind greșit noul tmdb_id pe rândul altui titlu.
  if (input.tmdbId != null || input.imdbId) return null;
  const row = db
    .prepare(
      "SELECT id FROM media WHERE media_type = ? AND tmdb_id IS NULL AND imdb_id IS NULL AND title = ?",
    )
    .get(mediaType, input.title) as { id: number } | undefined;
  return row?.id ?? null;
}

export interface MediaPlaceholderInput {
  imdbId: string | null;
  tmdbId: number | null;
  title: string;
  originalTitle?: string | null;
  literalTitle?: string | null;
  year?: number | null;
  overviewRo?: string | null;
  genres?: string[];
  posterPath?: string | null;
  tvStatus?: string | null;
  addedVia: AddedVia;
  requestedByUserId?: number | null;
}

// Creează (sau actualizează, dacă există deja) rândul-părinte al unui serial
// — apelat intern la fiecare episod inserat (descărcare sau backfill).
// Actualizarea nu atinge niciodată coloanele de proveniență torrent — cele
// aparțin doar rândurilor de episod/film create la descărcare
// (upsertMediaEntry).
function ensureMediaPlaceholder(
  mediaType: "movie" | "tv_show",
  input: MediaPlaceholderInput,
): number {
  const db = getDb();
  const existingId = findExistingMediaRow(mediaType, input);
  if (existingId != null) {
    db.prepare(
      `UPDATE media SET title = ?, original_title = ?, literal_title = ?, year = ?,
       overview_ro = ?, genres = ?, poster_path = ?, tv_status = ?, tmdb_id = ?,
       requested_by_user_id = COALESCE(requested_by_user_id, ?), updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      input.title,
      input.originalTitle ?? null,
      input.literalTitle ?? null,
      input.year ?? null,
      input.overviewRo ?? null,
      JSON.stringify(input.genres ?? []),
      input.posterPath ?? null,
      input.tvStatus ?? null,
      input.tmdbId,
      input.requestedByUserId ?? null,
      existingId,
    );
    return existingId;
  }
  const res = db
    .prepare(
      `INSERT INTO media (
        media_type, imdb_id, tmdb_id, title, original_title, literal_title, year,
        overview_ro, genres, poster_path, tv_status, added_via, requested_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      mediaType,
      input.imdbId,
      input.tmdbId,
      input.title,
      input.originalTitle ?? null,
      input.literalTitle ?? null,
      input.year ?? null,
      input.overviewRo ?? null,
      JSON.stringify(input.genres ?? []),
      input.posterPath ?? null,
      input.tvStatus ?? null,
      input.addedVia,
      input.requestedByUserId ?? null,
    );
  return Number(res.lastInsertRowid);
}

export interface LibraryTitleMatch {
  mediaId: number;
  mediaType: "movie" | "tv";
  tmdbId: number | null;
  imdbId: string | null;
  title: string;
  originalTitle: string | null;
  literalTitle: string | null;
  year: number | null;
  posterPath: string | null;
  tvStatus: string | null;
}

// Căutare de titluri deja existente în bibliotecă (rânduri-rădăcină, fără
// parent_id) — folosită la descărcarea manuală de pe Filelist, ca adminul să
// poată lega explicit un torrent de un show/film corect din bibliotecă, în
// loc să lase rezolvarea automată (autoResolveManualMedia) să ghicească după
// IMDb ID-ul torrentului — greșit pentru titluri indexate pe Filelist sub
// ID-ul altei producții din aceeași franciză (vezi spinoff-uri/reunion-uri).
export async function searchLibraryTitlesCore(query: string): Promise<LibraryTitleMatch[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, media_type, tmdb_id, imdb_id, title, original_title, literal_title, year, poster_path, tv_status
         FROM media
         WHERE parent_id IS NULL AND media_type IN ('movie', 'tv_show') AND title LIKE ?
         ORDER BY title LIMIT 20`,
    )
    .all(`%${q}%`) as Array<{
    id: number;
    media_type: string;
    tmdb_id: number | null;
    imdb_id: string | null;
    title: string;
    original_title: string | null;
    literal_title: string | null;
    year: number | null;
    poster_path: string | null;
    tv_status: string | null;
  }>;
  return rows.map((r) => ({
    mediaId: r.id,
    mediaType: r.media_type === "movie" ? "movie" : "tv",
    tmdbId: r.tmdb_id,
    imdbId: r.imdb_id,
    title: r.title,
    originalTitle: r.original_title,
    literalTitle: r.literal_title,
    year: r.year,
    posterPath: r.poster_path,
    tvStatus: r.tv_status,
  }));
}

export interface DownloadingMediaEntry {
  season: number | null;
  episode: number | null;
  isSeasonPack: boolean;
  torrentName: string | null;
}

// Ce e deja în curs de descărcare pentru un titlu (torrent pornit, dar încă
// neindexat de Plex) — folosit de wizard ca să blocheze orice acțiune nouă
// pe un sezon/episod/film deja pornit, în loc să lase userul să-l pornească
// din nou din greșeală (torrent_hash e cunoscut, plex_rating_key încă nu).
export async function getDownloadingMediaForTmdbIdCore(
  tmdbId: number,
  mediaType: "movie" | "tv",
): Promise<DownloadingMediaEntry[]> {
  const db = getDb();
  const dbMediaType = mediaType === "movie" ? "movie" : "episode";
  const rows = db
    .prepare(
      `SELECT season, episode, is_season_pack, torrent_name FROM media
         WHERE tmdb_id = ? AND media_type = ? AND torrent_hash IS NOT NULL AND plex_rating_key IS NULL`,
    )
    .all(tmdbId, dbMediaType) as Array<{
    season: number | null;
    episode: number | null;
    is_season_pack: number;
    torrent_name: string | null;
  }>;
  return rows.map((r) => ({
    season: r.season,
    episode: r.episode,
    isSeasonPack: !!r.is_season_pack,
    torrentName: r.torrent_name,
  }));
}

// Un rând deja existent pentru EXACT același torrent (hash + sezon/episod) —
// posibil dacă două cereri de descărcare pornesc aproape simultan pentru
// același episod/pachet. Fără verificarea asta, upsertMediaEntry ar insera
// un al doilea rând duplicat pentru același torrent, amândouă vizibile
// separat ca "în curs" în wizard/Bibliotecă.
function findExistingDownloadRow(input: UpsertMediaEntryInput): number | null {
  if (!input.torrentHash) return null;
  const db = getDb();
  if (input.mediaType === "episode") {
    const row = db
      .prepare(
        `SELECT id FROM media WHERE media_type = 'episode' AND torrent_hash = ?
         AND season IS ? AND episode IS ?`,
      )
      .get(input.torrentHash, input.season ?? null, input.episode ?? null) as
      { id: number } | undefined;
    return row?.id ?? null;
  }
  const row = db
    .prepare(`SELECT id FROM media WHERE media_type = 'movie' AND torrent_hash = ?`)
    .get(input.torrentHash) as { id: number } | undefined;
  return row?.id ?? null;
}

export function upsertMediaEntry(input: UpsertMediaEntryInput): number {
  const db = getDb();

  const existingId = findExistingDownloadRow(input);
  if (existingId != null) return existingId;

  const parentId = input.mediaType === "episode" ? ensureMediaPlaceholder("tv_show", input) : null;

  const res = db
    .prepare(
      `INSERT INTO media (
        media_type, parent_id, imdb_id, tmdb_id, title, original_title, literal_title,
        year, season, episode, overview_ro, genres, poster_path, tv_status,
        torrent_name, torrent_hash, category, category_name, size, freeleech, internal,
        save_path, is_season_pack, added_via, requested_by_user_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.mediaType,
      parentId,
      input.imdbId,
      input.tmdbId,
      input.title,
      input.originalTitle ?? null,
      input.literalTitle ?? null,
      input.year ?? null,
      input.season ?? null,
      input.episode ?? null,
      input.overviewRo ?? null,
      JSON.stringify(input.genres ?? []),
      input.posterPath ?? null,
      input.tvStatus ?? null,
      input.torrentName ?? null,
      input.torrentHash ?? null,
      input.category ?? null,
      input.categoryName ?? null,
      input.size ?? 0,
      input.freeleech ? 1 : 0,
      input.internal ? 1 : 0,
      input.savePath ?? null,
      input.isSeasonPack ? 1 : 0,
      input.addedVia,
      input.requestedByUserId ?? null,
    );
  return Number(res.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Sincronizare ulterioară — actualizează rândul/rândurile deja existente
// (create de wizard), potrivite după torrent_hash (mai multe rânduri pot
// partaja un hash pentru pachetele de sezon — vezi migrarea v13 din db.ts).
// Dacă niciun rând `media` nu corespunde (torrent pornit din afara
// wizard-ului), UPDATE/DELETE-ul nu afectează nimic — nu creăm rânduri noi
// din aceste căi, doar sincronizăm unde există deja unul.
// ---------------------------------------------------------------------------

// Sursa subtitrării, derivată din outcome-ul ensureRomanianSubtitle
// (subtitles.ts) — vezi SubtitleOutcome acolo pentru lista completă.
const SUBTITLE_SOURCE_BY_OUTCOME: Record<string, string | null> = {
  already_embedded: "embedded",
  audio_already_romanian: "audio_ro",
  srt_already_ok: "tracked_srt",
  renamed_srt: "tracked_srt",
  reencoded_srt: "tracked_srt",
  downloaded_opensubtitles: "opensubtitles",
  downloaded_opensubtitles_approximate: "opensubtitles",
  season_corrected: "season_aggregate",
  season_already_ok: "season_aggregate",
};

const HAS_ROMANIAN_OUTCOMES = new Set([
  "already_embedded",
  "audio_already_romanian",
  "srt_already_ok",
  "renamed_srt",
  "reencoded_srt",
  "downloaded_opensubtitles",
  "downloaded_opensubtitles_approximate",
  "season_corrected",
  "season_already_ok",
]);

// Apelat după fiecare verificare/corectare de subtitrare (finalul unei
// descărcări, "Corectează subtitrare" din Lansări/Bibliotecă, backfill).
export function updateMediaSubtitleStatus(
  torrentHash: string,
  outcome: string,
  detail: string,
): void {
  getDb()
    .prepare(
      `UPDATE media SET has_romanian_subtitle = ?, subtitle_source = ?, subtitle_detail = ?,
       has_romanian_audio = CASE WHEN ? = 1 THEN 1 ELSE has_romanian_audio END,
       subtitle_checked_at = datetime('now'), updated_at = datetime('now')
       WHERE torrent_hash = ?`,
    )
    .run(
      HAS_ROMANIAN_OUTCOMES.has(outcome) ? 1 : 0,
      SUBTITLE_SOURCE_BY_OUTCOME[outcome] ?? null,
      detail,
      outcome === "audio_already_romanian" ? 1 : 0,
      torrentHash,
    );
}

// Apelat după "Șterge subtitrare" (Lansări/Bibliotecă) — subtitrarea .srt
// sidecar a fost ștearsă de pe disk, deci starea redevine "fără RO".
export function clearMediaSubtitleStatus(torrentHash: string): void {
  getDb()
    .prepare(
      `UPDATE media SET has_romanian_subtitle = 0, subtitle_source = NULL, subtitle_detail = NULL,
       subtitle_checked_at = datetime('now'), updated_at = datetime('now')
       WHERE torrent_hash = ?`,
    )
    .run(torrentHash);
}

// Apelat când torrentul a ajuns la 100% (pollUntilComplete) — marchează
// finalizarea, exact ca downloads.completed_at.
export function markMediaCompleted(torrentHash: string): void {
  getDb()
    .prepare(
      `UPDATE media SET completed_at = datetime('now'), updated_at = datetime('now')
       WHERE torrent_hash = ? AND completed_at IS NULL`,
    )
    .run(torrentHash);
}

// Titlu + poster deja cunoscute în `media` pentru un torrent — folosit de
// notificările de descărcare (download.ts), ca să NU-și mai recalculeze
// singure titlul/poster-ul printr-un lookup TMDB live paralel (sursă de
// adevăr unică: ce s-a scris deja în `media` la adăugare, vezi
// upsertMediaEntry) — TMDB live rămâne doar fallback, pentru torrente fără
// nicio legătură media (autoResolveManualMedia eșuat).
export function getMediaDisplayByTorrentHash(torrentHash: string): {
  title: string;
  posterPath: string | null;
  season: number | null;
  episode: number | null;
  isSeasonPack: boolean;
} | null {
  const row = getDb()
    .prepare(
      "SELECT title, poster_path, season, episode, is_season_pack FROM media WHERE torrent_hash = ? LIMIT 1",
    )
    .get(torrentHash) as
    | {
        title: string;
        poster_path: string | null;
        season: number | null;
        episode: number | null;
        is_season_pack: number;
      }
    | undefined;
  if (!row) return null;
  return {
    title: row.title,
    posterPath: row.poster_path,
    season: row.season,
    episode: row.episode,
    isSeasonPack: !!row.is_season_pack,
  };
}

// Apelat la "Șterge titlul complet" (Lansări/Bibliotecă) — elimină rândul
// din `media`, ca torrentul șters din downloads/qBittorrent/disk să dispară
// și de-aici.
export function deleteMediaByTorrentHash(torrentHash: string): void {
  getDb().prepare("DELETE FROM media WHERE torrent_hash = ?").run(torrentHash);
}

// Leagă un rând `media` de item-ul lui real din Plex — ratingKey, calitate,
// durată. Apelat cu reîncercări (pollUntilComplete), pentru că scanarea Plex
// e asincronă: la refreshPlexLibrary, fișierul poate să nu fie încă indexat.
// Sare peste pachetele de sezon (episode NULL) — un singur rând `media` nu
// poate reprezenta N ratingKey-uri diferite, câte unul per episod din pachet.
// Întoarce true dacă a găsit și a scris legătura, ca apelantul să știe când
// să oprească reîncercările.
export async function resolveMediaPlexLinkByTorrentHash(torrentHash: string): Promise<boolean> {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT id, media_type, title, original_title, season, episode FROM media WHERE torrent_hash = ?",
    )
    .get(torrentHash) as
    | {
        id: number;
        media_type: string;
        title: string;
        original_title: string | null;
        season: number | null;
        episode: number | null;
      }
    | undefined;
  if (!row) return false;

  const { findPlexMovieLink, findPlexEpisodeLink } = await import("../services/plex-library");
  const link =
    row.media_type === "movie"
      ? await findPlexMovieLink(row.title, row.original_title ?? row.title)
      : row.media_type === "episode" && row.season != null && row.episode != null
        ? await findPlexEpisodeLink(row.title, row.season, row.episode)
        : null;
  if (!link) return false;

  db.prepare(
    `UPDATE media SET plex_rating_key = ?, quality = ?, duration_ms = ?, plex_added_at = ?,
     updated_at = datetime('now') WHERE id = ?`,
  ).run(link.ratingKey, link.quality, link.durationMs, link.addedAt, row.id);
  return true;
}

interface SeasonPackMediaRow {
  id: number;
  media_type: string;
  parent_id: number | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  title: string;
  original_title: string | null;
  literal_title: string | null;
  year: number | null;
  season: number | null;
  episode: number | null;
  overview_ro: string | null;
  genres: string;
  poster_path: string | null;
  tv_status: string | null;
  torrent_name: string | null;
  torrent_hash: string | null;
  category: number | null;
  category_name: string | null;
  size: number;
  freeleech: number;
  internal: number;
  save_path: string | null;
  is_season_pack: number;
  added_via: string;
  requested_by_user_id: number | null;
  completed_at: string | null;
  has_romanian_subtitle: number;
  has_romanian_audio: number;
  subtitle_source: string | null;
  subtitle_detail: string | null;
  subtitle_checked_at: string | null;
}

// Echivalentul lui resolveMediaPlexLinkByTorrentHash, pentru pachete de
// sezon (rândul are episode NULL, is_season_pack = 1 — vezi upsertMediaEntry,
// apelat o singură dată per torrent, indiferent dacă e episod sau pachet).
// Un singur rând `media` nu poate purta N ratingKey-uri, deci rândul-pachet
// rămânea "downloading" definitiv (resolveMediaPlexLinkByTorrentHash îl sare
// mereu). Aici desfacem pachetul: pentru fiecare episod găsit deja în Plex,
// clonăm rândul-pachet într-un rând de episod normal (sau actualizăm unul
// deja existent, dacă episodul fusese descărcat separat înainte), apoi ștergem
// placeholder-ul de pachet. Întoarce true dacă a găsit și desfăcut cel puțin
// un episod, ca apelantul (pollUntilComplete) să oprească reîncercările.
export async function resolveSeasonPackPlexLinks(torrentHash: string): Promise<boolean> {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM media WHERE torrent_hash = ? AND media_type = 'episode'
       AND episode IS NULL AND is_season_pack = 1`,
    )
    .get(torrentHash) as SeasonPackMediaRow | undefined;
  if (!row || row.season == null) return false;

  const { findPlexSeasonLinks } = await import("../services/plex-library");
  const links = await findPlexSeasonLinks(row.title, row.season);
  if (!links || links.size === 0) return false;

  const insert = db.prepare(
    `INSERT INTO media (
      media_type, parent_id, imdb_id, tmdb_id, title, original_title, literal_title,
      year, season, episode, overview_ro, genres, poster_path, tv_status,
      plex_rating_key, plex_added_at, torrent_name, torrent_hash, category, category_name,
      size, freeleech, internal, save_path, is_season_pack, added_via, requested_by_user_id,
      completed_at, has_romanian_subtitle, has_romanian_audio, subtitle_source,
      subtitle_detail, subtitle_checked_at, quality, duration_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const updateExisting = db.prepare(
    `UPDATE media SET plex_rating_key = ?, quality = ?, duration_ms = ?, plex_added_at = ?,
     updated_at = datetime('now') WHERE id = ?`,
  );
  const findExisting = db.prepare(
    `SELECT id FROM media WHERE parent_id = ? AND season = ? AND episode = ? AND id != ?`,
  );

  for (const [episodeNum, link] of links) {
    const existing = findExisting.get(row.parent_id, row.season, episodeNum, row.id) as
      { id: number } | undefined;
    if (existing) {
      updateExisting.run(link.ratingKey, link.quality, link.durationMs, link.addedAt, existing.id);
      continue;
    }
    insert.run(
      row.media_type,
      row.parent_id,
      row.imdb_id,
      row.tmdb_id,
      row.title,
      row.original_title,
      row.literal_title,
      row.year,
      row.season,
      episodeNum,
      row.overview_ro,
      row.genres,
      row.poster_path,
      row.tv_status,
      link.ratingKey,
      link.addedAt,
      row.torrent_name,
      row.torrent_hash,
      row.category,
      row.category_name,
      row.size,
      row.freeleech,
      row.internal,
      row.save_path,
      row.is_season_pack,
      row.added_via,
      row.requested_by_user_id,
      row.completed_at,
      row.has_romanian_subtitle,
      row.has_romanian_audio,
      row.subtitle_source,
      row.subtitle_detail,
      row.subtitle_checked_at,
      link.quality,
      link.durationMs,
    );
  }

  db.prepare("DELETE FROM media WHERE id = ?").run(row.id);
  return true;
}
