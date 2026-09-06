// ---------------------------------------------------------------------------
// Sursă unică pentru CONȚINUTUL (titlu + text + imagine + link) notificărilor
// push din aplicație — trimiterea efectivă rămâne în push.ts (sendPushToAll,
// singura funcție care vorbește cu web-push), dar construirea conținutului nu
// mai e împrăștiată sau duplicată în fiecare modul care are nevoie să notifice.
//
// Totul e aici: și builder-ele "bogate" (torrent/watcher, mai jos) care au
// nevoie de parametri/lookup-uri, și PUSH_TITLES/PUSH_URLS — titlul/link-ul
// implicit pentru evenimentele simple logate prin logActivity() (server,
// Plex, Immich, update-uri, erori...), consumate de activity-log.ts. Dacă
// vrei să schimbi cum arată orice notificare din aplicație, e un singur loc.
//
// Torrentele (download.ts) folosesc buildTorrentDisplayName
// (tmdb-title-lookup.ts) + detectTorrentQuality (torrent-quality.ts) — aceeași
// logică peste tot, nu recalculată ad-hoc per apel.
// ---------------------------------------------------------------------------

import { sendPushToAll } from "./push";
import { buildTorrentDisplayName, lookupPosterUrlByImdbId } from "../tmdb/tmdb-title-lookup";
import { detectTorrentQuality } from "../media/torrent-quality";
import type { ActivityType } from "../activity-log";

export interface PushNotification {
  title: string;
  body: string;
  image?: string | null;
  url?: string;
}

// --- Evenimente simple (logActivity, activity-log.ts) -----------------------
// Titlul/link-ul implicit per tip de activitate — logActivity le folosește
// când apelul nu suprascrie explicit `options.title`/`options.url` (ex.
// torrent_added/torrent_complete, care diferă manual/automat — vezi mai jos).

export const PUSH_TITLES: Record<ActivityType, string> = {
  server_start: "🟢 Serverul a pornit",
  server_stop: "🔴 Serverul s-a oprit",
  plex_watch_start: "🎬 Vizionare începută",
  plex_watch_stop: "🎬 Vizionare încheiată",
  // Fallback — titlul real vine din options.title (n.title de la
  // buildTorrentAddedNotification/buildTorrentCompleteNotification, mai jos),
  // fiindcă torrent_added acoperă atât manual cât și automat.
  torrent_added: "⬇️ Descărcare Inițiată",
  torrent_complete: "✅ Descărcare Completă",
  immich_upload: "📷 Immich",
  service_restart: "🔄 Serviciu Repornit",
  service_update: "⬆️ Actualizare Aplicată",
  ubuntu_update: "🐧 Ubuntu Actualizat",
  qbit_action: "⚙️ Acțiune qBittorrent",
  app_error: "⚠️ Eroare Nouă Aplicație",
  // O singură intrare de log per rulare (descărcare unică sau backfill întreg
  // — vezi logSubtitleRun în src/lib/filelist/subtitles.ts), deci un singur
  // push per rulare, nu per torrent.
  subtitle_fix: "💬 Corecție Subtitrare",
  account_request: "🆕 Cerere Aprobare Cont",
};

// Pagina spre care duce apăsarea notificării — implicit per tip; se poate
// suprascrie punctual din `options.url` la apel din logActivity.
export const PUSH_URLS: Record<ActivityType, string> = {
  server_start: "/sistem",
  server_stop: "/sistem",
  plex_watch_start: "/",
  plex_watch_stop: "/",
  torrent_added: "/biblioteca",
  torrent_complete: "/biblioteca",
  immich_upload: "/immich",
  service_restart: "/sistem",
  service_update: "/sistem",
  ubuntu_update: "/sistem",
  qbit_action: "/qbit",
  app_error: "/tehnic",
  subtitle_fix: "/biblioteca",
  account_request: "/users",
};

// --- Server (activity-log.ts — start/stop) ----------------------------------

export function buildServerStartMessage(cause: string, time: string): string {
  return `Cauză: ${cause}, ora ${time}`;
}

export function buildServerStopMessage(cause: string, time: string): string {
  return `Cauză: ${cause}, ora ${time}`;
}

// --- Plex (activity-log.ts — tracking sesiuni) -------------------------------

export function buildPlexWatchStartMessage(user: string, what: string): string {
  return `${user}: ${what}`;
}

export function buildPlexWatchStopMessage(user: string, what: string, progress: string): string {
  return `${user}: ${what}${progress}`;
}

// --- Torrente (filelist/download.ts) ----------------------------------------
//
// Sursa de adevăr pentru titlu/poster e rândul deja scris în `media`
// (upsertMediaEntry, la rândul lui alimentat de wizard/autoResolveManualMedia
// — vezi getMediaDisplayByTorrentHash). Lookup-ul TMDB live de mai jos e
// DOAR fallback, pentru fereastra scurtă dinaintea scrierii în `media` (sau
// pentru torrente care n-au ajuns deloc să fie legate de un rând media) —
// altfel am recalcula independent ceva ce riscă să difere de ce arată deja
// Biblioteca/jurnalul Plex pentru același titlu.

// Poster-ul stocat în `media` (poster_path) vine din surse diferite, cu
// dimensiuni TMDB diferite (w92 în lista de căutare a wizard-ului, w342 la
// autoResolveManualMedia etc.) — bune pentru carduri mici din UI, dar afișate
// prea mare (lățime completă) în notificarea push, unde ies neclare. Urcăm
// la o rezoluție mare doar aici, la nivel de URL TMDB, indiferent ce
// dimensiune a fost stocată inițial, fără să atingem valoarea din DB
// (folosită și în altă parte, la dimensiunea ei originală).
function upscalePosterForPush(posterPath: string | null): string | null {
  if (!posterPath) return null;
  return posterPath.replace(/\/t\/p\/w\d+\//, "/t/p/w780/");
}

function seasonEpisodeLabel(
  season: number | null,
  episode: number | null,
  isSeasonPack: boolean,
): string | null {
  if (season == null) return null;
  if (isSeasonPack) return `Sezonul ${season}`;
  if (episode != null) {
    return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  }
  return null;
}

async function resolveTorrentDisplay(params: {
  torrentName: string;
  imdb?: string | null;
  torrentHash?: string | null;
}): Promise<{ displayName: string; image: string | null; seasonLabel: string | null }> {
  if (params.torrentHash) {
    const { getMediaDisplayByTorrentHash } = await import("../media/media");
    const known = getMediaDisplayByTorrentHash(params.torrentHash);
    if (known) {
      return {
        displayName: known.title,
        image: upscalePosterForPush(known.posterPath),
        seasonLabel: seasonEpisodeLabel(known.season, known.episode, known.isSeasonPack),
      };
    }
  }
  const [displayName, image] = await Promise.all([
    buildTorrentDisplayName(params.torrentName, params.imdb).catch(() => params.torrentName),
    params.imdb ? lookupPosterUrlByImdbId(params.imdb).catch(() => null) : Promise.resolve(null),
  ]);
  return { displayName, image, seasonLabel: null };
}

export async function buildTorrentAddedNotification(params: {
  torrentName: string;
  imdb?: string | null;
  torrentHash?: string | null;
  // Pornit de urmărirea serialelor, nu de un om — titlu distinct, ca o
  // descărcare apărută "din senin" să fie imediat explicabilă.
  auto?: boolean;
}): Promise<PushNotification> {
  const { displayName, image, seasonLabel } = await resolveTorrentDisplay(params);
  const quality = detectTorrentQuality(params.torrentName);
  return {
    title: params.auto ? "🤖 Descărcare Automată" : "⬇️ Descărcare Inițiată",
    body: `${displayName}${seasonLabel ? ` — ${seasonLabel}` : ""} [${quality}]`,
    image,
    url: "/biblioteca",
  };
}

export async function buildTorrentCompleteNotification(params: {
  torrentName: string;
  imdb?: string | null;
  torrentHash?: string | null;
}): Promise<PushNotification> {
  const { displayName, image, seasonLabel } = await resolveTorrentDisplay(params);
  const quality = detectTorrentQuality(params.torrentName);
  return {
    title: "✅ Descărcare Completă",
    body: `${displayName}${seasonLabel ? ` — ${seasonLabel}` : ""} [${quality}]`,
    image,
    url: "/biblioteca",
  };
}

// --- Commit-uri GitHub (3 locuri: webhook, plugin de pornire, funcție server) ---
// Trimiterea e imediată, nu amânată, dar e grupată pe lot: un push cu 9
// commit-uri trebuie să dea o notificare, nu nouă.

export interface CommitNotice {
  author: string;
  message: string;
}

/**
 * O singură notificare pentru tot lotul de commit-uri noi.
 *
 * Înainte, fiecare apelant itera lista și trimitea un push per commit — un
 * push cu 9 commit-uri însemna 9 notificări, care pe Android se grupau
 * automat și acopereau ecranul.
 */
export async function notifyGithubCommits(commits: CommitNotice[]): Promise<void> {
  if (commits.length === 0) return;

  if (commits.length === 1) {
    const { author, message } = commits[0];
    await sendPushToAll(`📦 Commit nou — ${author}`, message, { url: "/tehnic" });
    return;
  }

  const authors = [...new Set(commits.map((c) => c.author))];
  const who = authors.length === 1 ? ` — ${authors[0]}` : "";
  // Primele câteva mesaje, ca notificarea să spună ceva concret; restul
  // se numără, ca să nu devină un perete de text.
  const MAX_LINES = 4;
  const lines = commits.slice(0, MAX_LINES).map((c) => `• ${c.message}`);
  const rest = commits.length - MAX_LINES;
  if (rest > 0) lines.push(`…și încă ${rest}`);

  await sendPushToAll(`📦 ${commits.length} commit-uri noi${who}`, lines.join("\n"), {
    url: "/tehnic",
  });
}
