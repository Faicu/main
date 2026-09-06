import { useQuery } from "@tanstack/react-query";
import {
  Box,
  GitCommitHorizontal,
  PlayCircle,
  Radar,
  Link2,
  RotateCcw,
  Power,
  PlugZap,
} from "lucide-react";

import { activityLogQuery, commitsFromDbQuery, showWatchStatusQuery } from "@/lib/queries";
import { relativeTime } from "../utils";

// Panoul reflectă exact fișierele din server/plugins/ — un rând per proces
// care rulează, nu per funcționalitate. Completarea numelor de episoade, de
// exemplu, nu are rând propriu: e un pas dintr-un tic al lui show-watcher, iar
// un rând separat ar putea arăta bulina verde chiar dacă plugin-ul e mort.
//
// `activityType` = tipul de intrare din jurnal care dovedește că plugin-ul a
// făcut ceva. Unele n-au niciunul, fiindcă lucrează doar la pornire sau nu
// loghează când nu găsesc nimic de făcut — atunci rândul rămâne fără
// timestamp, ceea ce e onest: știm că e încărcat, nu avem dovadă recentă.
const PLUGINS: Array<{
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  activityType: string | null;
}> = [
  {
    id: "show-watcher",
    label: "Urmărire Seriale",
    description: "Descărcare automată episoade noi · la 3h per serial",
    icon: <Radar className="h-4 w-4 text-violet-400" />,
    activityType: null,
  },
  {
    id: "plex-session-tracker",
    label: "Plex Session Tracker",
    description: "Urmărire sesiuni & vizionări · la 30s",
    icon: <PlayCircle className="h-4 w-4 text-amber-400" />,
    activityType: "plex_watch_start",
  },
  {
    id: "plex-link-reconciler",
    label: "Reconciliere Plex",
    description: "Leagă descărcările rămase fără Plex · la 10 min",
    icon: <Link2 className="h-4 w-4 text-emerald-400" />,
    activityType: null,
  },
  {
    id: "filelist-resume",
    label: "Reluare Descărcări",
    description: "Repornește polling-ul întrerupt de un restart · la pornire",
    icon: <RotateCcw className="h-4 w-4 text-blue-400" />,
    activityType: null,
  },
  {
    id: "github-commit-tracker",
    label: "GitHub Commit Tracker",
    description: "Sincronizare commit-uri din GitHub · la pornire",
    icon: <GitCommitHorizontal className="h-4 w-4 text-purple-400" />,
    activityType: null,
  },
  {
    id: "activity-boot",
    label: "Jurnal Pornire/Oprire",
    description: "Înregistrează ciclul de viață al serverului · la pornire",
    icon: <PlugZap className="h-4 w-4 text-sky-400" />,
    activityType: "server_start",
  },
  {
    id: "fast-shutdown",
    label: "Oprire Controlată",
    description: "Închide curat la SIGTERM, înainte de SIGKILL · la oprire",
    icon: <Power className="h-4 w-4 text-rose-400" />,
    activityType: "server_stop",
  },
];

export function PluginStatusSection() {
  const { data: log } = useQuery(activityLogQuery);
  const { data: commitsData } = useQuery(commitsFromDbQuery);
  const { data: watch } = useQuery(showWatchStatusQuery);

  function lastActivity(type: string | null): string | null {
    if (!type || !Array.isArray(log)) return null;
    const entry = log.find((e) => e.type === type);
    return entry ? entry.timestamp : null;
  }

  function lastCommitSync(): string | null {
    if (commitsData?.status !== "ok" || !commitsData.commits.length) return null;
    return commitsData.commits[0].date;
  }

  // watch_last_checked_at e în formatul SQLite, în UTC ("2026-09-06 08:09:04").
  // new Date() l-ar citi ca oră LOCALĂ, deci "acum" ar apărea ca "acum 3h".
  function lastShowWatch(): string | null {
    const v = watch?.lastCheckedAt;
    return v ? `${v.replace(" ", "T")}Z` : null;
  }

  // Numele de episoade lipsă apar în descriere doar cât timp chiar lipsesc —
  // stare tranzitorie, între descărcarea unui episod și următorul ciclu. Când
  // e 0 (cazul normal), rândul nu spune nimic despre ele.
  function showWatchDescription(fallback: string): string {
    if (!watch) return fallback;
    const shows =
      watch.watchedShows === 0
        ? "niciun serial urmărit"
        : `${watch.watchedShows} ${watch.watchedShows === 1 ? "serial urmărit" : "seriale urmărite"}`;
    if (watch.missingEpisodeTitles === 0) return shows;
    const n = watch.missingEpisodeTitles;
    return `${shows} · ${n} ${n === 1 ? "episod fără nume" : "episoade fără nume"}`;
  }

  return (
    <section className="space-y-2">
      <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <Box className="h-3.5 w-3.5" /> Plugin-uri active
      </h2>
      <div className="rounded-2xl glass-card divide-y divide-border/50">
        {PLUGINS.map((p) => {
          const lastTs =
            p.id === "github-commit-tracker"
              ? lastCommitSync()
              : p.id === "show-watcher"
                ? lastShowWatch()
                : lastActivity(p.activityType);
          const detail =
            p.id === "show-watcher" ? showWatchDescription(p.description) : p.description;
          return (
            <div key={p.id} className="flex items-center gap-3 px-3 py-3">
              <div className="shrink-0">{p.icon}</div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium leading-tight">{p.label}</div>
                <div className="text-[11px] text-muted-foreground">{detail}</div>
              </div>
              <div className="shrink-0 flex flex-col items-end gap-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_#4ade80]" />
                  {lastTs && (
                    <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                      {relativeTime(lastTs)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
