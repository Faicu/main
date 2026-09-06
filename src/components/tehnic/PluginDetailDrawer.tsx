import { useQuery } from "@tanstack/react-query";
import { Clock3, FileCode2, Activity, Radar, CircleHelp } from "lucide-react";

import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { showWatchStatusQuery } from "@/lib/queries";
import { relativeTime, formatDateTime } from "./utils";
import type { PluginInfo } from "./plugins";

// Detaliile unui plugin de fundal. Deschis din lista de pe Tehnic — până acum
// rândurile erau doar informative, fără nimic de apăsat.
export function PluginDetailDrawer({
  plugin,
  lastTs,
  onClose,
}: {
  plugin: PluginInfo | null;
  // Trimis de listă, care oricum îl calculează pentru rând — nu-l recalculăm
  // aici, ca să nu existe două surse pentru același număr.
  lastTs: string | null;
  onClose: () => void;
}) {
  const { data: watch } = useQuery({ ...showWatchStatusQuery, enabled: !!plugin });
  const isWatcher = plugin?.id === "show-watcher";

  return (
    <Drawer open={!!plugin} onOpenChange={(o) => !o && onClose()}>
      <DrawerContent className="max-h-[85vh]">
        <DrawerHeader className="pb-2 text-left">
          <DrawerTitle className="flex items-center gap-2 text-base">
            {plugin?.icon}
            {plugin?.label ?? ""}
          </DrawerTitle>
          <DrawerDescription className="text-left">{plugin?.description}</DrawerDescription>
        </DrawerHeader>

        {plugin && (
          <div className="max-h-[65vh] space-y-2.5 overflow-y-auto overscroll-contain px-4 pb-6 stagger-in">
            <div className="rounded-2xl glass-card p-3 text-xs leading-relaxed text-muted-foreground">
              {plugin.details}
            </div>

            <div className="rounded-2xl glass-card divide-y divide-border/50 text-xs">
              <Row icon={<Clock3 className="h-3.5 w-3.5" />} label="Când rulează">
                {plugin.cadence}
              </Row>
              <Row icon={<Activity className="h-3.5 w-3.5" />} label="Ultima activitate">
                {lastTs ? (
                  <span title={formatDateTime(lastTs)}>{relativeTime(lastTs)}</span>
                ) : (
                  // Explicat, nu ascuns: un rând gol l-ar face să pară stricat.
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <CircleHelp className="h-3 w-3" /> fără dovadă recentă
                  </span>
                )}
              </Row>
              <Row icon={<FileCode2 className="h-3.5 w-3.5" />} label="Fișier">
                <code className="text-[11px]">server/plugins/{plugin.id}.ts</code>
              </Row>
            </div>

            {!lastTs && (
              <div className="rounded-2xl glass-card p-3 text-[11px] leading-relaxed text-muted-foreground">
                Plugin-ul e încărcat, dar nu scrie în jurnal de fiecare dată când rulează — fie
                lucrează doar la pornire, fie nu loghează nimic când n-a găsit nimic de făcut.
                Bulina verde înseamnă „încărcat”, nu „a rulat adineauri”; n-am inventat un timestamp
                din altă sursă doar ca să pară toate la fel.
              </div>
            )}

            {isWatcher && watch && (
              <div className="rounded-2xl glass-card divide-y divide-border/50 text-xs">
                <Row icon={<Radar className="h-3.5 w-3.5" />} label="Seriale urmărite">
                  {watch.watchedShows === 0 ? (
                    <span className="text-muted-foreground">niciunul</span>
                  ) : (
                    watch.watchedShows
                  )}
                </Row>
                <Row icon={<Activity className="h-3.5 w-3.5" />} label="Episoade fără nume">
                  {watch.missingEpisodeTitles === 0 ? (
                    <span className="text-emerald-400">toate completate</span>
                  ) : (
                    <span className="text-amber-400">{watch.missingEpisodeTitles}</span>
                  )}
                </Row>
              </div>
            )}
          </div>
        )}
      </DrawerContent>
    </Drawer>
  );
}

function Row({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="min-w-0 truncate text-right text-foreground">{children}</span>
    </div>
  );
}
