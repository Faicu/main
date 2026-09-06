import { formatDateTime } from "@/components/tehnic/utils";
import type { PlexBrowseItem, ShowEpisodeEntry } from "@/lib/services/plex-browse";

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

export function episodeCode(season: number | null, episode: number | null): string | null {
  return season != null && episode != null
    ? `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
    : null;
}

// "Episodul 8" — TMDB întoarce asta când episodul n-are nume propriu, iar
// show-watch îl salvează ca răspuns final după două săptămâni (altfel ar
// reinteroga la nesfârșit). N-are rost afișat lângă "S10E08": ar spune de
// două ori același lucru.
const GENERIC_EPISODE_TITLE = /^episo(?:dul|de)\s*\d+$/i;

export function displayEpisodeTitle(title: string | null): string | null {
  return title && !GENERIC_EPISODE_TITLE.test(title.trim()) ? title : null;
}

export function itemLabel(item: PlexBrowseItem): string {
  return item.type === "movie" ? item.title : (item.show ?? "—");
}

// addedAt e unix timestamp în secunde (convenția Plex) — formatDateTime
// lucrează cu ISO, de-aia conversia
export function addedDate(unixSec: number): string {
  if (!unixSec) return "—";
  return formatDateTime(new Date(unixSec * 1000).toISOString());
}

// Gruparea pe sezoane a episoadelor unui serial, pentru lista din drawer.
//
// Grupare pe sezonul real, nu pe secvențe consecutive cronologic ca înainte:
// atâta timp cât lista era ordonată după data adăugării, un sezon reluat mai
// târziu producea un al doilea segment "Sezonul N". Acum episoadele vin deja
// sortate după (sezon, episod) din server, deci fiecare sezon apare o
// singură dată, cu episoadele lui în ordine.
export type SeasonGroup = { season: number | null; episodes: ShowEpisodeEntry[] };

export function groupBySeason(episodes: ShowEpisodeEntry[]): SeasonGroup[] {
  const bySeason = new Map<number | null, ShowEpisodeEntry[]>();
  for (const ep of episodes) {
    const list = bySeason.get(ep.season);
    if (list) list.push(ep);
    else bySeason.set(ep.season, [ep]);
  }
  return [...bySeason.entries()]
    .map(([season, eps]) => ({ season, episodes: eps }))
    .sort((a, b) => (a.season ?? Infinity) - (b.season ?? Infinity));
}

export function matchesQuery(item: PlexBrowseItem, q: string): boolean {
  if (!q) return true;
  const n = norm(q);
  return norm(item.title).includes(n) || (!!item.show && norm(item.show).includes(n));
}

const STALE_UNWATCHED_SECONDS = 90 * 24 * 60 * 60; // 3 luni

// Semnal de curățenie: nimeni nu l-a vizionat de la adăugare, iar adăugarea
// nu e recentă (deci nu e doar "încă n-a apucat nimeni să-l vadă"). Pentru
// seriale, `addedAt` e episodul cel mai recent — un serial care încă
// primește episoade nu e "uitat", chiar dacă a început demult.
export function isStaleUnwatched(item: PlexBrowseItem, nowSec = Date.now() / 1000): boolean {
  return item.watchedCount === 0 && nowSec - item.addedAt > STALE_UNWATCHED_SECONDS;
}

export type SortMode = "recent" | "mostWatched" | "unwatched";

export function sortItems(items: PlexBrowseItem[], mode: SortMode): PlexBrowseItem[] {
  if (mode === "mostWatched") {
    return [...items].sort((a, b) => b.watchedCount - a.watchedCount || b.addedAt - a.addedAt);
  }
  if (mode === "unwatched") {
    return items.filter((it) => it.watchedCount === 0).sort((a, b) => b.addedAt - a.addedAt);
  }
  return items;
}

// Următorul episod, în ora României. `airstamp` (TVmaze) e un instant ISO cu
// fus, deci toLocaleString îl convertește singur în ora locală — nu calculăm
// noi niciun offset și nu se strică la trecerea la ora de vară. Când TVmaze
// n-are serialul, cădem pe data fără oră de la TMDB.
export function nextEpisodeWhen(
  airDate: string | null,
  airstamp: string | null,
): { text: string; soon: boolean } | null {
  const when = airstamp ? new Date(airstamp) : airDate ? new Date(`${airDate}T00:00:00`) : null;
  if (!when || Number.isNaN(when.getTime())) return null;

  const dayLabel = when.toLocaleDateString("ro-RO", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const time = airstamp
    ? when.toLocaleTimeString("ro-RO", { hour: "2-digit", minute: "2-digit" })
    : null;

  // Zile calendaristice, nu diferență de 24h: un episod de mâine dimineață e
  // "mâine" chiar dacă până atunci mai sunt 9 ore.
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(when) - startOfDay(new Date())) / 86_400_000);
  const relative =
    days === 0 ? "azi" : days === 1 ? "mâine" : days > 1 && days <= 7 ? `în ${days} zile` : null;

  const head = relative ?? dayLabel;
  return { text: time ? `${head}, ${time}` : head, soon: days >= 0 && days <= 2 };
}
