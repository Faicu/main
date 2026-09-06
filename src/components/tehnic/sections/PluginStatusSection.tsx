import { useQuery } from "@tanstack/react-query";
import { Box, GitCommitHorizontal, PlayCircle, Radar } from "lucide-react";

import { activityLogQuery, commitsFromDbQuery, showWatchStatusQuery } from "@/lib/queries";
import { relativeTime } from "../utils";

const PLUGINS = [
  {
    id: "plex-session-tracker",
    label: "Plex Session Tracker",
    description: "Urmărire sesiuni & vizionări",
    icon: <PlayCircle className="h-4 w-4 text-amber-400" />,
    activityType: "plex_watch_start",
  },
  {
    id: "show-watcher",
    label: "Urmărire Seriale",
    description: "Descărcare automată episoade noi",
    icon: <Radar className="h-4 w-4 text-violet-400" />,
    activityType: null,
  },
  {
    id: "github-commit-tracker",
    label: "GitHub Commit Tracker",
    description: "Sincronizare commit-uri din GitHub",
    icon: <GitCommitHorizontal className="h-4 w-4 text-purple-400" />,
    activityType: null,
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
            p.id === "show-watcher" && watch
              ? watch.watchedShows === 0
                ? "niciun serial urmărit"
                : `${watch.watchedShows} ${watch.watchedShows === 1 ? "serial urmărit" : "seriale urmărite"}`
              : p.description;
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
