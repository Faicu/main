import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Box, ChevronRight } from "lucide-react";

import { activityLogQuery, commitsFromDbQuery, showWatchStatusQuery } from "@/lib/queries";
import { relativeTime } from "../utils";
import { PLUGINS, type PluginInfo } from "../plugins";
import { PluginDetailDrawer } from "../PluginDetailDrawer";

export function PluginStatusSection() {
  const { data: log } = useQuery(activityLogQuery);
  const { data: commitsData } = useQuery(commitsFromDbQuery);
  const { data: watch } = useQuery(showWatchStatusQuery);
  const [openPlugin, setOpenPlugin] = useState<PluginInfo | null>(null);

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

  function lastTsFor(p: PluginInfo): string | null {
    if (p.id === "github-commit-tracker") return lastCommitSync();
    if (p.id === "show-watcher") return lastShowWatch();
    return lastActivity(p.activityType);
  }

  // Numele de episoade lipsă apar în descriere doar cât timp chiar lipsesc —
  // stare tranzitorie, între descărcarea unui episod și următorul ciclu. Când
  // e 0 (cazul normal), rândul nu spune nimic despre ele.
  function descriptionFor(p: PluginInfo): string {
    if (p.id !== "show-watcher" || !watch) return p.description;
    const n = watch.shows.length;
    const shows =
      n === 0 ? "niciun serial urmărit" : `${n} ${n === 1 ? "serial urmărit" : "seriale urmărite"}`;
    const m = watch.missingTitles.length;
    if (m === 0) return shows;
    return `${shows} · ${m} ${m === 1 ? "episod fără nume" : "episoade fără nume"}`;
  }

  return (
    <section className="space-y-2">
      <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <Box className="h-3.5 w-3.5" /> Plugin-uri active
      </h2>
      {/* overflow-hidden: fundalul de hover al primului/ultimului rând ar
          depăși altfel colțurile rotunjite ale cardului. */}
      <div className="overflow-hidden rounded-2xl glass-card divide-y divide-border/50 stagger-in">
        {PLUGINS.map((p) => {
          const lastTs = lastTsFor(p);
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setOpenPlugin(p)}
              className="press-tile flex w-full items-center gap-3 px-3 py-3 text-left transition-colors first:rounded-t-2xl last:rounded-b-2xl hover:bg-muted/40"
            >
              <div className="shrink-0">{p.icon}</div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium leading-tight">{p.label}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {descriptionFor(p)}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {/* live-dot pulsează; e nepot al lui stagger-in, nu copil
                    direct, deci propriul lui `animation` nu intră în conflict
                    cu animația de intrare a rândului. */}
                <span className="live-dot" />
                {lastTs && (
                  <span className="whitespace-nowrap text-[10px] text-muted-foreground">
                    {relativeTime(lastTs)}
                  </span>
                )}
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              </div>
            </button>
          );
        })}
      </div>

      <PluginDetailDrawer
        plugin={openPlugin}
        lastTs={openPlugin ? lastTsFor(openPlugin) : null}
        onClose={() => setOpenPlugin(null)}
      />
    </section>
  );
}
