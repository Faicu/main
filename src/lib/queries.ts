import { queryOptions } from "@tanstack/react-query";
import { getPlex, getPlexSessions, getImmich, getQbit, getHost } from "./services.functions";
import { getAdminStatus } from "./auth/admin.functions";
import { getVersions } from "./system/versions.functions";
import {
  getLastSpeedtest,
  getSpeedtestHistory,
  getSpeedtestState,
} from "./system/speedtest.functions";
import { getActivityLog } from "./activity-log.functions";
import { getErrorLogs } from "./errors/error-log.functions";
import {
  getRecentCommits,
  getCommitsFromDb,
  getGitHubSyncStatus,
  getGitPushStatus,
  getUnpushedCommits,
} from "./github.functions";
import { getPlexLibraryBrowse, getRecentWatches } from "./services.functions";
import { getRefreshMs, getFastRefreshMs, REFRESH_DEFAULT_MS } from "./refresh-rate";
import { getNetworkLink } from "./system/network-link.functions";
import { getShowWatchStatus } from "./media/media.functions";

// Ritmul statisticilor live e reglabil din pagina Sistem — vezi
// lib/refresh-rate.ts. `refetchInterval` primește o funcție, evaluată la
// fiecare tick, deci schimbarea are efect imediat, fără reîncărcare.
//
// A fost fix 1000ms, ceea ce însemna, PER TAB DESCHIS, un set complet de
// apeluri pe secundă: si.processes(), dockerContainerStats per container,
// lista completă de torrente din qBittorrent, statisticile Immich. Monitorul
// de sistem ajunsese principalul consumator de CPU al sistemului monitorizat.
// Acum serverul cachează rezultatele (cachedAsync din services/shared.ts),
// deci N tab-uri costă cât unul.

// Listele care se schimbă rar nu merită ritmul statisticilor de sistem, dar
// nici nu trebuie să rămână blocate pe o valoare fixă când userul cere
// explicit un ritm mai lent (ex. economie de baterie pe telefon).
const slower = (factor: number) => () => getRefreshMs() * factor;

// Pulsul de fond al Bibliotecii, ca multiplu al ritmului ales: 30s la
// implicitul de 3s, 5 min dacă userul cere 30s (economie de baterie).
const LIBRARY_IDLE_FACTOR = 10;

// Păstrează datele vechi afișate în timp ce se încarcă cele noi (fără flicker)
const keepPrev = { placeholderData: <T>(prev: T) => prev };

export const plexQuery = queryOptions({
  queryKey: ["plex"],
  queryFn: () => getPlex(),
  refetchInterval: slower(3),
  refetchIntervalInBackground: false,
  staleTime: 10_000,
  ...keepPrev,
});

// "Cine vizionează acum" — cerere separată, rapidă (doar /status/sessions)
export const plexSessionsQuery = queryOptions({
  queryKey: ["plexSessions"],
  queryFn: () => getPlexSessions(),
  refetchInterval: () => getFastRefreshMs(),
  refetchIntervalInBackground: false,
  staleTime: 1_000,
  ...keepPrev,
});

export const immichQuery = queryOptions({
  queryKey: ["immich"],
  queryFn: () => getImmich(),
  refetchInterval: () => getRefreshMs(),
  staleTime: 0,
  ...keepPrev,
});

export const qbitQuery = queryOptions({
  queryKey: ["qbit"],
  queryFn: () => getQbit(),
  refetchInterval: () => getRefreshMs(),
  staleTime: 0,
  ...keepPrev,
});

export const hostQuery = queryOptions({
  queryKey: ["host"],
  queryFn: () => getHost(),
  refetchInterval: () => getRefreshMs(),
  // Era `true`: statisticile de sistem continuau să fie cerute la fiecare
  // secundă și cu tabul minimizat, la nesfârșit. Nimeni nu le vede atunci.
  refetchIntervalInBackground: false,
  staleTime: 0,
  ...keepPrev,
});

export const activityLogQuery = queryOptions({
  queryKey: ["activityLog"],
  queryFn: () => getActivityLog(),
  refetchInterval: slower(2),
  staleTime: 2_000,
  ...keepPrev,
});

export const errorLogQuery = queryOptions({
  queryKey: ["errorLog"],
  queryFn: () => getErrorLogs(),
  refetchInterval: slower(5),
  staleTime: 5_000,
  ...keepPrev,
});

export const adminStatusQuery = queryOptions({
  queryKey: ["adminStatus"],
  queryFn: () => getAdminStatus(),
  staleTime: 30_000,
  refetchOnWindowFocus: true,
});

export const versionsQuery = queryOptions({
  queryKey: ["versions"],
  queryFn: () => getVersions(),
  refetchInterval: 5 * 60_000,
  staleTime: 60_000,
});

export const lastSpeedtestQuery = queryOptions({
  queryKey: ["speedtest"],
  queryFn: () => getLastSpeedtest(),
  staleTime: 30_000,
  refetchOnWindowFocus: true,
});

// Fetch periodic de pe GitHub → upsert în DB (rulat în background)
export const recentCommitsQuery = queryOptions({
  queryKey: ["recentCommits"],
  queryFn: () => getRecentCommits(),
  refetchInterval: 5 * 60_000,
  staleTime: 2 * 60_000,
  refetchOnWindowFocus: true,
});

// Citire din DB — sursa pentru timeline (istoric complet)
export const commitsFromDbQuery = queryOptions({
  queryKey: ["commitsFromDb"],
  queryFn: () => getCommitsFromDb(),
  refetchInterval: 5 * 60_000,
  staleTime: 60_000,
  refetchOnWindowFocus: true,
});

export const githubSyncQuery = queryOptions({
  queryKey: ["githubSync"],
  queryFn: () => getGitHubSyncStatus(),
  refetchInterval: 60_000,
  staleTime: 30_000,
  refetchOnWindowFocus: true,
});

export const githubPushStatusQuery = queryOptions({
  queryKey: ["githubPushStatus"],
  queryFn: () => getGitPushStatus(),
  refetchInterval: 60_000,
  staleTime: 30_000,
  refetchOnWindowFocus: true,
});
export const unpushedCommitsQuery = queryOptions({
  queryKey: ["unpushedCommits"],
  queryFn: () => getUnpushedCommits(),
  refetchInterval: 60_000,
  staleTime: 30_000,
  refetchOnWindowFocus: true,
});

export const speedtestHistoryQuery = queryOptions({
  queryKey: ["speedtestHistory"],
  queryFn: () => getSpeedtestHistory(),
  staleTime: 60_000,
});

// Starea rulării de speedtest, ținută pe server. Interogăm des DOAR cât timp
// chiar rulează un test; altfel query-ul stă liniștit. Așa butonul arată "se
// rulează" corect chiar dacă ai redeschis aplicația la mijlocul testului.
export const speedtestStateQuery = queryOptions({
  queryKey: ["speedtestState"],
  queryFn: () => getSpeedtestState(),
  refetchInterval: (query) => (query.state.data?.running ? 2_000 : false),
  refetchOnWindowFocus: true,
  staleTime: 0,
});

export const plexLibraryBrowseQuery = queryOptions({
  queryKey: ["plexLibraryBrowse"],
  queryFn: () => getPlexLibraryBrowse(),
  // Cât timp o descărcare e în curs: ritmul ales, pentru progresul live din
  // qBittorrent. Altfel un puls lent de fond (30s implicit), ca un titlu
  // adăugat de pe alt dispozitiv — sau de alt utilizator — să apară singur,
  // fără refresh manual. Înainte era `false`, adică lista rămânea înghețată
  // pe ce era la deschiderea paginii.
  //
  // Costul e mic și mărginit: query-ul e folosit DOAR de pagina Bibliotecă
  // (BibliotecaList), iar refetchInterval rulează doar cât timp query-ul e
  // montat — deci pulsul există doar cât ai efectiv pagina deschisă. Cererea
  // se servește din `media`, fără să atingă Plex sau TMDB.
  refetchInterval: (query) => {
    const data = query.state.data;
    const items = data?.status === "ok" ? data.items : [];
    return items.some((it) => it.status === "downloading")
      ? getRefreshMs()
      : slower(LIBRARY_IDLE_FACTOR)();
  },
  // staleTime aliniat la pulsul de fond: revenind pe pagină nu vezi date mai
  // vechi decât un ciclu. Era 60s, adică dublu față de puls.
  staleTime: LIBRARY_IDLE_FACTOR * REFRESH_DEFAULT_MS,
  // Revenind din altă aplicație / alt tab, reîmprospătează imediat, fără să
  // aștepți următorul puls.
  refetchOnWindowFocus: true,
});

export const recentWatchesQuery = queryOptions({
  queryKey: ["recentWatches"],
  queryFn: () => getRecentWatches(),
  staleTime: 60_000,
  refetchInterval: 60_000,
});

// Viteza negociată a legăturii Ethernet — se schimbă doar la evenimente fizice
// (cablu atins, switch repornit), deci un ritm lent e suficient. Componenta
// invalidează manual query-ul cât timp urmărește revenirea după renegociere.
export const networkLinkQuery = queryOptions({
  queryKey: ["networkLink"],
  queryFn: () => getNetworkLink(),
  staleTime: 30_000,
  refetchInterval: 60_000,
  refetchOnWindowFocus: true,
});

// Starea urmăririi serialelor, pentru panoul "Plugin-uri active" din Tehnic.
// Ritm lent: plugin-ul verifică oricum o dată la 3 ore per serial, deci n-are
// rost un puls mai des decât atât.
export const showWatchStatusQuery = queryOptions({
  queryKey: ["showWatchStatus"],
  queryFn: () => getShowWatchStatus(),
  staleTime: 60_000,
  refetchInterval: 120_000,
});
