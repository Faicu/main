import { writeFile, unlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { FilelistDownloadResult, QbitTorrentInfo } from "./types";
import { CATEGORY_NAMES, parseCategoryId, isMovieCategory } from "./categories";
import { downloadTorrentFile } from "./filelist-client";
import { qbitGet, qbitLogin, qbitEnsureCookie, resetQbitCookie } from "../qbit-client";
import { readDownloadLog, appendDownloadLog, markLogEntryComplete } from "./log";
import { CORRECTED_OUTCOMES } from "./subtitle-outcomes";
import type { SubtitleRunItem, DeleteSubtitleResult } from "./subtitles";
import { refreshPlexLibrary } from "../plex-refresh";
// Import dinamic (nu static) — subtitles.ts foloseşte node:child_process/node:util
// pentru ffprobe, care nu trebuie să ajungă în bundle-ul de client. download.ts
// e statically importat de filelist.functions.ts, folosit și din componente
// client (hooks.ts, DownloadLogSection.tsx), deci orice import static de aici
// se poate scurge în bundle-ul browserului.

// Un torrent e considerat complet dacă a ajuns la 100% și starea din
// qBittorrent indică seeding/pauzat-după-seeding — folosit de
// pollUntilComplete (torrent pornit din aplicație).
function isTorrentComplete(progress: number, state: string): boolean {
  return (
    progress >= 1 &&
    (state.includes("UP") || state === "uploading" || state === "pausedUP" || state === "stalledUP")
  );
}

// Calculează infohash-ul unui .torrent local, direct din bytes, fără să
// întrebe qBittorrent — infohash-ul e definit ca SHA1 peste dicționarul
// bencode "info" din fișier, deci e determinist și disponibil imediat.
// Înlocuiește o variantă veche care căuta hash-ul prin lista qBittorrent
// după nume normalizat, care eșua când numele intern din .torrent diferea
// de titlul afișat pe Filelist (ex. uploader care redenumește fișierul
// după listare — "Ok.The.Crown.S02..." în loc de "The.Crown.S02...DTS...",
// 2026-09-02).
function bencodeStringAt(buf: Buffer, start: number): { value: string; end: number } {
  const colon = buf.indexOf(0x3a, start);
  const len = parseInt(buf.toString("ascii", start, colon), 10);
  const strStart = colon + 1;
  const strEnd = strStart + len;
  return { value: buf.toString("latin1", strStart, strEnd), end: strEnd };
}

function bencodeSkip(buf: Buffer, start: number): number {
  const c = buf[start];
  if (c === 0x69 /* 'i' */) {
    const end = buf.indexOf(0x65, start);
    return end + 1;
  }
  if (c >= 0x30 && c <= 0x39 /* '0'-'9' -> string */) {
    return bencodeStringAt(buf, start).end;
  }
  if (c === 0x6c /* 'l' */) {
    let pos = start + 1;
    while (buf[pos] !== 0x65) pos = bencodeSkip(buf, pos);
    return pos + 1;
  }
  if (c === 0x64 /* 'd' */) {
    let pos = start + 1;
    while (buf[pos] !== 0x65) {
      pos = bencodeSkip(buf, pos); // cheie
      pos = bencodeSkip(buf, pos); // valoare
    }
    return pos + 1;
  }
  throw new Error(`bencode invalid la offset ${start}`);
}

function computeTorrentInfoHash(torrentBuffer: ArrayBuffer): string | null {
  try {
    const buf = Buffer.from(torrentBuffer);
    if (buf[0] !== 0x64 /* 'd' */) return null;
    let pos = 1;
    while (buf[pos] !== 0x65) {
      const key = bencodeStringAt(buf, pos);
      pos = key.end;
      if (key.value === "info") {
        const valueEnd = bencodeSkip(buf, pos);
        return createHash("sha1").update(buf.subarray(pos, valueEnd)).digest("hex");
      }
      pos = bencodeSkip(buf, pos);
    }
    return null;
  } catch (e) {
    console.warn("[filelist] Nu am putut calcula infohash local din .torrent:", e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Background polling: verifică progresul torrentului și refresh Plex la final
// ---------------------------------------------------------------------------

async function pollUntilComplete(
  qbitUrl: string,
  torrentHash: string,
  plexType: "movie" | "show",
  torrentName: string,
  torrentId: number,
  qbitUser: string,
  qbitPass: string,
  imdbId?: string | null,
): Promise<void> {
  const MAX_WAIT_MS = 48 * 60 * 60 * 1000;
  const POLL_INTERVAL_MS = 30_000;
  const started = Date.now();

  console.log(`[filelist] Pornesc polling pentru "${torrentName}" (${torrentHash})`);

  while (Date.now() - started < MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    try {
      // qbitGet (nu fetch brut cu un cookie înghețat) — SID-ul WebUI expiră
      // implicit după o oră, iar bucla asta poate rula până la 48h. Înainte,
      // orice descărcare mai lungă de o oră primea 403 la fiecare poll, iar
      // `if (!res.ok) continue` trata asta identic cu "încă nu e gata": fără
      // subtitrare, fără completed_at, fără notificare, fără legare Plex —
      // și complet tăcut. qbitGet reautentifică singur la 401/403.
      const res = await qbitGet(
        qbitUrl,
        `/api/v2/torrents/info?hashes=${torrentHash}`,
        qbitUser,
        qbitPass,
      );
      if (!res.ok) {
        console.warn(
          `[filelist] Poll qBit pentru "${torrentName}": HTTP ${res.status} — reîncerc peste ${POLL_INTERVAL_MS / 1000}s`,
        );
        continue;
      }

      const list: QbitTorrentInfo[] = await res.json();
      if (!list.length) continue;

      const torrent = list[0];
      const progress = Number(torrent.progress ?? 0);
      const state: string = torrent.state ?? "";

      const isDone = isTorrentComplete(progress, state);

      if (isDone) {
        const wasFirst = await markLogEntryComplete(torrentId);
        if (wasFirst) {
          console.log(`[filelist] "${torrentName}" complet — dau refresh Plex`);
          import("../notifications/notifications")
            .then(({ buildTorrentCompleteNotification }) =>
              buildTorrentCompleteNotification({ torrentName, imdb: imdbId, torrentHash }),
            )
            .then((n) =>
              import("../activity-log").then(({ logActivity }) =>
                logActivity(
                  "torrent_complete",
                  n.body,
                  { torrentId },
                  { image: n.image, url: n.url, title: n.title },
                ),
              ),
            )
            .catch(() => {});
          try {
            const { ensureRomanianSubtitle, logSubtitleRun } = await import("./subtitles");
            const subtitleItem = await ensureRomanianSubtitle({
              qbitUrl,
              qbitUser,
              qbitPass,
              torrentHash,
              torrentName,
              imdbId,
              mediaType: plexType === "movie" ? "movie" : "tv",
            });
            await logSubtitleRun([subtitleItem], "download");
            const { updateMediaSubtitleStatus } = await import("../media/media");
            updateMediaSubtitleStatus(torrentHash, subtitleItem.outcome, subtitleItem.detail);
          } catch (e) {
            console.warn(`[filelist] Eroare subtitrare pentru "${torrentName}":`, e);
          }
          const {
            markMediaCompleted,
            resolveMediaPlexLinkByTorrentHash,
            resolveSeasonPackPlexLinks,
          } = await import("../media/media");
          markMediaCompleted(torrentHash);
          await refreshPlexLibrary(plexType);
          console.log(`[filelist] Plex refresh trimis pentru "${plexType}"`);

          // Scanarea Plex e asincronă — fișierul poate să nu fie încă indexat
          // chiar după refresh. Reîncercăm cu pauze, ca ratingKey/calitatea/
          // durata din `media` să se completeze fără intervenție manuală.
          // Fereastră totală 30 min (180 × 10s) — nu mai există job periodic
          // de backfill ca plasă de siguranță, deci fereastra asta e singura
          // șansă. resolveMediaPlexLinkByTorrentHash acoperă episod/film
          // individual; resolveSeasonPackPlexLinks acoperă rândul-pachet
          // (episode NULL) — încercăm ambele, doar una din ele găsește
          // vreodată un rând pentru hash-ul curent.
          for (let attempt = 0; attempt < 180; attempt++) {
            await new Promise((r) => setTimeout(r, 10_000));

            const linked = await resolveMediaPlexLinkByTorrentHash(torrentHash).catch(() => false);
            const linkedPack = linked
              ? false
              : await resolveSeasonPackPlexLinks(torrentHash).catch(() => false);
            if (linked || linkedPack) break;
          }
        } else {
          console.log(`[filelist] "${torrentName}" deja marcat complet de alt loop — skip`);
        }
        return;
      }
    } catch (e) {
      console.warn(`[filelist] Eroare polling qBit: ${e}`);
    }
  }

  console.warn(`[filelist] Timeout polling pentru "${torrentName}" după 48h`);
}

// ---------------------------------------------------------------------------
// Resume polling pentru descărcări întrerupte de restart server
// ---------------------------------------------------------------------------

let resumeDone = false;

async function resumeOrphanedPolls(): Promise<void> {
  if (resumeDone) return;
  resumeDone = true;

  try {
    const log = await readDownloadLog();
    const orphaned = log.filter((e) => e.completedAt === null);
    if (orphaned.length === 0) return;

    const qbitBase = process.env.QBIT_URL;
    const qbitUser = process.env.QBIT_USERNAME;
    const qbitPass = process.env.QBIT_PASSWORD;
    if (!qbitBase || !qbitUser || !qbitPass) return;

    const url = qbitBase.replace(/\/$/, "");
    // Nu mai facem login aici: pollUntilComplete folosește qbitGet, care
    // gestionează singur cookie-ul (și reautentifică la expirare). Un login
    // eșuat la pornire nu mai trebuie să anuleze reluarea tuturor polling-urilor.

    console.log(
      `[filelist] Reiau polling pentru ${orphaned.length} descărcări întrerupte de restart`,
    );
    for (const entry of orphaned) {
      const plexType = isMovieCategory(entry.category) ? "movie" : "show";
      if (!entry.torrentHash) {
        console.warn(`[filelist] Resume: hash indisponibil pentru "${entry.name}" — skip`);
        continue;
      }
      pollUntilComplete(
        url,
        entry.torrentHash,
        plexType,
        entry.name,
        entry.id,
        qbitUser,
        qbitPass,
        entry.imdb,
      ).catch((e) => console.error("[filelist] Eroare resume polling:", e));
    }
  } catch (e) {
    console.warn("[filelist] resumeOrphanedPolls eșuat:", e);
  }
}

// Declanșată din server/plugins/filelist-resume.ts, NU dintr-un efect
// secundar la nivel de modul.
//
// Înainte era un `setTimeout` executat la încărcarea modulului, ceea ce
// funcționa doar accidental: barrel-ul filelist.functions.ts importa static
// download.ts, deci modulul se încărca la boot. După ce server function-urile
// s-au mutat în download.functions.ts (ca să nu mai scurgem cod server în
// bundle-ul public), download.ts a devenit import leneș — și reluarea nu a mai
// rulat NICIODATĂ la pornire. Reprodus: un torrent ajuns 100% în qBittorrent
// rămânea cu completed_at NULL, fără subtitrare și fără legare Plex, fiindcă
// bucla lui de polling murise la restart și nimeni nu o mai relua.
export { resumeOrphanedPolls };

// ---------------------------------------------------------------------------
// Server function: descarcă torrent și trimite la qBittorrent
// ---------------------------------------------------------------------------

export interface DownloadFilelistParams {
  torrentId: number;
  torrentName: string;
  categoryId: number;
  categoryName?: string;
  size?: number;
  freeleech?: boolean;
  internal?: boolean;
  imdb?: string | null;
  requestedByUserId?: number | null;
  // Metadate TMDB — trimise deja gata calculate de wizard/Lansări (au TMDB
  // details la îndemână la momentul descărcării). Când lipsesc (căutarea
  // manuală brută din FilelistSection, fără nicio legătură TMDB în UI),
  // downloadFilelistCore încearcă singur o rezolvare
  // best-effort (autoResolveManualMedia) — dacă eșuează, titlul pur și
  // simplu nu ajunge în `media`, exact ca acum. Proveniența torrent-ului
  // (nume/hash/categorie/mărime/cale) e completată aici, în
  // downloadFilelistCore, care oricum le are deja calculate — nu e nevoie
  // ca apelantul să le retrimită.
  media?: Omit<
    import("../media/media").UpsertMediaEntryInput,
    | "torrentName"
    | "torrentHash"
    | "category"
    | "categoryName"
    | "size"
    | "freeleech"
    | "internal"
    | "savePath"
    | "requestedByUserId"
  >;
}

// Rezolvare best-effort a metadatelor TMDB pentru un torrent descărcat din
// căutarea manuală Filelist (FilelistSection), care n-are nicio legătură
// TMDB în UI — spre deosebire de wizard/Lansări, care trimit deja `media`
// gata calculat. Dacă torrentul are IMDb id (Filelist l-a confirmat) îl
// folosim direct; altfel încercăm aceeași căutare pe nume ca la potrivirea
// subtitrărilor. Fără IMDb id găsit, întoarce null — titlul nu ajunge în
// `media`, exact comportamentul de dinainte (nimic nu se strică).
async function autoResolveManualMedia(
  torrentImdb: string | null | undefined,
  torrentName: string,
  isMovie: boolean,
): Promise<DownloadFilelistParams["media"] | null> {
  const mediaType: "movie" | "tv" = isMovie ? "movie" : "tv";
  let imdbId = torrentImdb ?? null;
  if (!imdbId) {
    const { searchImdbIdByReleaseName } = await import("../tmdb/tmdb-title-lookup");
    const found = await searchImdbIdByReleaseName(torrentName, mediaType).catch(() => null);
    imdbId = found?.imdbId ?? null;
  }
  if (!imdbId) return null;

  const { lookupTmdbInfoByImdbId } = await import("../tmdb/tmdb-title-lookup");
  const info = await lookupTmdbInfoByImdbId(imdbId).catch(() => null);
  if (!info) return null;

  const { getTmdbDetailsInternal } = await import("../tmdb/tmdb.functions");
  const details = await getTmdbDetailsInternal(info.id, info.mediaType).catch(() => null);
  const { parseSeasonEpisodeFromName } = await import("../media/torrent-name-parse");
  const parsed = !isMovie ? parseSeasonEpisodeFromName(torrentName) : null;

  return {
    mediaType: isMovie ? "movie" : "episode",
    imdbId,
    tmdbId: info.id,
    title: info.title,
    originalTitle: details?.originalTitle ?? null,
    literalTitle: details?.literalTitle ?? null,
    year: info.year ? Number(info.year) : null,
    season: parsed?.season ?? null,
    episode: parsed?.episode ?? null,
    overviewRo: details?.overview ?? null,
    genres: details?.genres ?? [],
    posterPath: info.posterPath ? `https://image.tmdb.org/t/p/w342${info.posterPath}` : null,
    tvStatus: !isMovie ? (details?.tvStatus ?? null) : null,
    isSeasonPack: !!parsed && parsed.episode === null,
    addedVia: "manual",
  };
}

// Implementare comună pentru descărcare + upload la qBittorrent, folosită de
// server function-ul public (downloadFilelist).
export async function downloadFilelistCore(
  params: DownloadFilelistParams,
): Promise<FilelistDownloadResult> {
  const username = process.env.FILELIST_USERNAME;
  const passkey = process.env.FILELIST_PASSKEY;
  const qbitBase = process.env.QBIT_URL ?? "http://192.168.1.192:25556";
  const qbitUser = process.env.QBIT_USERNAME;
  const qbitPass = process.env.QBIT_PASSWORD;
  const moviesPath = process.env.MEDIA_MOVIES_PATH ?? "/media/ssd2tb/Filme";
  const seriesPath = process.env.MEDIA_SERIES_PATH ?? "/media/ssd2tb/Seriale";

  if (!username || !passkey) {
    return { status: "error", error: "FILELIST_USERNAME / FILELIST_PASSKEY nu sunt configurate" };
  }
  if (!qbitUser || !qbitPass) {
    return { status: "error", error: "QBIT_USERNAME / QBIT_PASSWORD nu sunt configurate" };
  }

  const catId =
    params.categoryId || (params.categoryName ? parseCategoryId(params.categoryName) : 0);
  const isMovie =
    isMovieCategory(catId) || (catId === 0 && /film|movie/i.test(params.categoryName ?? ""));
  const savePath = isMovie ? moviesPath : seriesPath;

  // 1. Descarcă fișierul .torrent de la Filelist
  let torrentBuffer: ArrayBuffer;
  try {
    torrentBuffer = await downloadTorrentFile(params.torrentId);
  } catch (e) {
    return {
      status: "error",
      error: `Eroare rețea Filelist: ${e instanceof Error ? e.message : e}`,
    };
  }

  // 2. Scrie temporar fișierul .torrent pe disk
  const safeName = params.torrentName.replace(/[^a-z0-9_\-. ]/gi, "_").slice(0, 80);
  const tmpPath = join(tmpdir(), `faikkitbox_${params.torrentId}_${Date.now()}.torrent`);
  await writeFile(tmpPath, Buffer.from(torrentBuffer));

  try {
    // 3. Autentifică-te la qBittorrent
    const url = qbitBase.replace(/\/$/, "");
    let cookie: string;
    try {
      cookie = await qbitEnsureCookie(url, qbitUser, qbitPass);
    } catch {
      resetQbitCookie();
      cookie = await qbitLogin(url, qbitUser, qbitPass);
    }

    // 4. Trimite torrentul la qBittorrent cu save path corect
    const form = new FormData();
    const fileBytes = await readFile(tmpPath);
    form.append(
      "torrents",
      new Blob([fileBytes], { type: "application/x-bittorrent" }),
      `${safeName}.torrent`,
    );
    form.append("savepath", savePath);
    form.append("category", isMovie ? "filme" : "seriale");

    let uploadRes = await fetch(`${url}/api/v2/torrents/add`, {
      method: "POST",
      headers: { Cookie: cookie, Referer: url, Origin: url },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });

    // Sesiunea SID poate expira în qBittorrent între timp; un SID expirat
    // primește tot 403 (nu 401), deci reîncercăm o dată cu login proaspăt.
    // Alte coduri de eroare (400 body invalid, 500 server) nu se rezolvă
    // printr-un relogin — le lăsăm să treacă direct la eroarea de mai jos.
    if (uploadRes.status === 401 || uploadRes.status === 403) {
      resetQbitCookie();
      cookie = await qbitLogin(url, qbitUser, qbitPass);
      uploadRes = await fetch(`${url}/api/v2/torrents/add`, {
        method: "POST",
        headers: { Cookie: cookie, Referer: url, Origin: url },
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
    }

    if (!uploadRes.ok) {
      const txt = await uploadRes.text().catch(() => "");
      return {
        status: "error",
        error: `qBittorrent upload eșuat: HTTP ${uploadRes.status} ${txt.slice(0, 120)}`,
      };
    }

    const uploadText = await uploadRes.text();
    if (!uploadText.includes("Ok")) {
      console.warn("qBit upload răspuns neașteptat:", uploadText);
    }

    // 5-7. Restul (jurnalizare, notificare, scriere media, pornire polling)
    // rulează în fundal, fără să blocheze răspunsul — clientul n-are nevoie
    // de hash ca să știe că upload-ul a reușit.
    const catName = params.categoryName || CATEGORY_NAMES[catId] || `Cat ${catId}`;
    finishFilelistDownload({
      params,
      catId,
      catName,
      savePath,
      isMovie,
      url,
      qbitUser,
      qbitPass,
      torrentHash: computeTorrentInfoHash(torrentBuffer),
    }).catch((e) => console.error("[filelist] Eroare la finalizarea descărcării în fundal:", e));

    return { status: "ok", torrentName: params.torrentName, savePath };
  } finally {
    // Curăță fișierul temporar
    await unlink(tmpPath).catch(() => {});
  }
}

// Pasul de finalizare (5-7 din downloadFilelistCore) — separat ca să poată
// rula fără await, imediat după ce upload-ul la qBittorrent a fost confirmat.
async function finishFilelistDownload(ctx: {
  params: DownloadFilelistParams;
  catId: number;
  catName: string;
  savePath: string;
  isMovie: boolean;
  url: string;
  qbitUser: string;
  qbitPass: string;
  torrentHash: string | null;
}): Promise<void> {
  const { params, catId, catName, savePath, isMovie, url, qbitUser, qbitPass, torrentHash } = ctx;

  // 6. Scrie în `media` ÎNAINTE de notificare — sursă unică pentru titlu/
  // poster, ca notificarea (mai jos) să le citească de-acolo, nu să le
  // recalculeze independent printr-un lookup TMDB live paralel.
  const mediaPayload =
    params.media ??
    (await autoResolveManualMedia(params.imdb, params.torrentName, isMovie).catch((e) => {
      console.warn("[filelist] Rezolvare automată media eșuată:", e);
      return null;
    }));
  if (mediaPayload) {
    const { upsertMediaEntry } = await import("../media/media");
    try {
      upsertMediaEntry({
        ...mediaPayload,
        torrentName: params.torrentName,
        torrentHash: torrentHash ?? null,
        category: catId,
        categoryName: catName,
        size: params.size ?? 0,
        freeleech: params.freeleech ?? false,
        internal: params.internal ?? false,
        savePath,
        requestedByUserId: params.requestedByUserId ?? null,
      });
    } catch (e) {
      console.warn("[filelist] Nu am putut scrie în tabela media:", e);
    }
  }

  // 7. Loghează descărcarea imediat (completedAt null = în curs)
  import("../notifications/notifications")
    .then(({ buildTorrentAddedNotification }) =>
      buildTorrentAddedNotification({
        torrentName: params.torrentName,
        imdb: params.imdb,
        torrentHash,
        auto: params.media?.addedVia === "auto",
      }),
    )
    .then((n) =>
      import("../activity-log").then(({ logActivity }) =>
        logActivity(
          "torrent_added",
          n.body,
          {
            category: catName,
            savePath,
            size: params.size,
          },
          { image: n.image, url: n.url, title: n.title },
        ),
      ),
    )
    .catch(() => {});
  await appendDownloadLog({
    id: params.torrentId,
    name: params.torrentName,
    size: params.size ?? 0,
    category: catId,
    categoryName: catName,
    freeleech: params.freeleech ?? false,
    internal: params.internal ?? false,
    savePath,
    downloadedAt: new Date().toISOString(),
    completedAt: null,
    torrentHash: torrentHash ?? undefined,
    imdb: params.imdb ?? undefined,
    requestedByUserId: params.requestedByUserId ?? null,
  });

  // 8. Pornește polling background — refresh Plex și marchează complet DOAR la final
  const plexType = isMovie ? "movie" : "show";
  if (torrentHash) {
    pollUntilComplete(
      url,
      torrentHash,
      plexType,
      params.torrentName,
      params.torrentId,
      qbitUser,
      qbitPass,
      params.imdb,
    ).catch((e) => console.error("[filelist] Eroare polling:", e));
  } else {
    console.warn("[filelist] Hash nedisponibil — Plex nu va fi refreshuit automat");
  }
}

// Corectează subtitrarea pentru un singur titlu — folosește exact aceeași
// logică (ensureRomanianSubtitle) ca descărcarea normală, dar aplicată direct
// pe hash-ul torrentului cerut, fără să mai listeze/itereze toate torrentele
// din qBittorrent.
export type CorrectSubtitleResult =
  ({ status: "ok" } & SubtitleRunItem) | { status: "error"; error: string };

// ---------------------------------------------------------------------------
// Echivalentele de mai sus, dar sursate direct din `media` (media.id), nu din
// `downloads` — folosite de Bibliotecă. Orice rând `media` cu torrent_hash
// cunoscut e gestionabil — nu mai depinde de existența unui rând `downloads`.
// ---------------------------------------------------------------------------

interface MediaActionRow {
  torrent_name: string | null;
  torrent_hash: string | null;
  imdb_id: string | null;
  category: number | null;
  requested_by_user_id: number | null;
}

export async function correctSubtitleForMediaCore(
  session: { data: { admin?: boolean; userId?: number } },
  data: { mediaId: number },
): Promise<CorrectSubtitleResult> {
  {
    const { isAdminOrOwner } = await import("../auth/admin.server");
    const { getDb } = await import("../db");
    const row = getDb()
      .prepare(
        "SELECT torrent_name, torrent_hash, imdb_id, category, requested_by_user_id FROM media WHERE id = ?",
      )
      .get(data.mediaId) as MediaActionRow | undefined;

    if (!row) {
      return { status: "error", error: "Titlul nu a fost găsit" };
    }
    if (!isAdminOrOwner(session, row.requested_by_user_id)) {
      return {
        status: "error",
        error: "Doar cel care a adăugat titlul sau un admin poate corecta subtitrarea",
      };
    }
    if (!row.torrent_hash) {
      return {
        status: "error",
        error: "Hash-ul torrentului e necunoscut — nu poate fi gestionat automat",
      };
    }

    const qbitBase = process.env.QBIT_URL ?? "http://192.168.1.192:25556";
    const qbitUser = process.env.QBIT_USERNAME;
    const qbitPass = process.env.QBIT_PASSWORD;
    if (!qbitUser || !qbitPass) {
      return { status: "error", error: "QBIT_USERNAME / QBIT_PASSWORD nu sunt configurate" };
    }
    const url = qbitBase.replace(/\/$/, "");

    const { ensureRomanianSubtitle, logSubtitleRun } = await import("./subtitles");
    const plexType = row.category !== null && isMovieCategory(row.category) ? "movie" : "show";

    const result = await ensureRomanianSubtitle({
      qbitUrl: url,
      qbitUser,
      qbitPass,
      torrentHash: row.torrent_hash,
      torrentName: row.torrent_name ?? "",
      imdbId: row.imdb_id ?? undefined,
      mediaType: plexType === "movie" ? "movie" : "tv",
    });

    await logSubtitleRun([result], "download");
    const { updateMediaSubtitleStatus } = await import("../media/media");
    updateMediaSubtitleStatus(row.torrent_hash, result.outcome, result.detail);
    if (CORRECTED_OUTCOMES.includes(result.outcome)) {
      await refreshPlexLibrary(plexType).catch(() => {});
    }

    return { status: "ok", ...result };
  }
}

export async function deleteSubtitleForMediaCore(
  session: { data: { admin?: boolean; userId?: number } },
  data: { mediaId: number },
): Promise<DeleteSubtitleResult> {
  {
    const { isAdminOrOwner } = await import("../auth/admin.server");
    const { getDb } = await import("../db");
    const row = getDb()
      .prepare(
        "SELECT torrent_name, torrent_hash, imdb_id, category, requested_by_user_id FROM media WHERE id = ?",
      )
      .get(data.mediaId) as MediaActionRow | undefined;

    if (!row) {
      return { status: "error", deleted: [], error: "Titlul nu a fost găsit" };
    }
    if (!isAdminOrOwner(session, row.requested_by_user_id)) {
      return {
        status: "error",
        deleted: [],
        error: "Doar cel care a adăugat titlul sau un admin poate șterge subtitrarea",
      };
    }
    if (!row.torrent_hash) {
      return {
        status: "error",
        deleted: [],
        error: "Hash-ul torrentului e necunoscut — nu poate fi gestionat automat",
      };
    }

    const qbitBase = process.env.QBIT_URL ?? "http://192.168.1.192:25556";
    const qbitUser = process.env.QBIT_USERNAME;
    const qbitPass = process.env.QBIT_PASSWORD;
    if (!qbitUser || !qbitPass) {
      return {
        status: "error",
        deleted: [],
        error: "QBIT_USERNAME / QBIT_PASSWORD nu sunt configurate",
      };
    }
    const url = qbitBase.replace(/\/$/, "");

    const { deleteRomanianSubtitle } = await import("./subtitles");
    const result = await deleteRomanianSubtitle({
      qbitUrl: url,
      qbitUser,
      qbitPass,
      torrentHash: row.torrent_hash,
    });

    if (result.status === "ok") {
      const { clearMediaSubtitleStatus } = await import("../media/media");
      clearMediaSubtitleStatus(row.torrent_hash);
      if (row.category !== null) {
        const { refreshPlexLibraryForCategory } = await import("../plex-refresh");
        await refreshPlexLibraryForCategory(row.category).catch(() => {});
      }
    }

    return result;
  }
}
