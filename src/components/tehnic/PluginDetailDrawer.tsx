import { useQuery } from "@tanstack/react-query";
import { Clock3, FileCode2, Activity, CircleHelp, RefreshCw, Tv, Tag } from "lucide-react";
import { ThinkingOrb } from "thinking-orbs";

import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { showWatchStatusQuery } from "@/lib/queries";
import { relativeTime, formatDateTime } from "./utils";
import { useFlashOnChange } from "@/hooks/use-flash-on-change";
import { nextEpisodeWhen } from "@/components/biblioteca/utils";
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
            {/* Haloul stă pe ::after al containerului (vezi nota din
                styles.css), nu pe iconiță — altfel ar înlocui orice animație
                proprie a ei. */}
            <span className="pulse-glow flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted/50">
              {plugin?.icon}
            </span>
            {plugin?.label ?? ""}
            <span className="live-dot ml-auto" />
          </DrawerTitle>
          <DrawerDescription className="text-left">{plugin?.description}</DrawerDescription>
        </DrawerHeader>

        {plugin && (
          <div className="max-h-[65vh] space-y-2.5 overflow-y-auto overscroll-contain px-4 pb-6 stagger-in">
            <div className="whitespace-pre-line rounded-2xl glass-card p-3 text-xs leading-relaxed text-muted-foreground">
              {plugin.details}
            </div>

            <div className="rounded-2xl glass-card divide-y divide-border/50 text-xs">
              <Row icon={<Clock3 className="h-3.5 w-3.5" />} label="Când rulează">
                {plugin.cadence}
              </Row>
              <Row
                icon={<Activity className="h-3.5 w-3.5" />}
                label="Ultima activitate"
                flashKey={lastTs}
              >
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
              <>
                {/* Numere goale ("Seriale urmărite: 2") nu spun nimic util —
                    întrebarea firească e "care?". Aceleași date, doar
                    desfășurate. */}
                <div className="rounded-2xl glass-card p-3 text-xs">
                  <div className="mb-2 flex items-center gap-1.5 text-muted-foreground">
                    <ThinkingOrb
                      state="searching"
                      size={20}
                      style={{ width: 14, height: 14, flexShrink: 0 }}
                    />{" "}
                    Seriale urmărite
                  </div>
                  {watch.shows.length === 0 ? (
                    <div className="text-muted-foreground">
                      Niciunul. Pornești urmărirea din drawer-ul unui serial, în Bibliotecă.
                    </div>
                  ) : (
                    <div className="space-y-1.5 stagger-in">
                      {watch.shows.map((sh) => {
                        const when = nextEpisodeWhen(sh.nextEpisodeAirDate, sh.nextEpisodeAirstamp);
                        return (
                          <div key={sh.mediaId} className="rounded-lg bg-muted/40 px-2 py-1.5">
                            <div className="flex items-center gap-2">
                              <Tv className="h-3 w-3 shrink-0 text-blue-400" />
                              <span className="min-w-0 flex-1 truncate font-medium">
                                {sh.title}
                              </span>
                              {sh.quality && (
                                <span className="flex shrink-0 items-center gap-0.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                                  <Tag className="h-2.5 w-2.5" />
                                  {sh.quality}
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                              {sh.from ? `de după ${sh.from}` : "recuperează tot ce lipsește"}
                              {sh.nextEpisode && when
                                ? ` · urmează ${sh.nextEpisode}, ${when.text}`
                                : " · niciun episod nou anunțat"}
                              {" · "}
                              <FlashValue flashKey={sh.lastCheckedAt}>
                                {sh.lastCheckedAt
                                  ? `verificat ${relativeTime(`${sh.lastCheckedAt.replace(" ", "T")}Z`)}`
                                  : "încă neverificat"}
                              </FlashValue>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="rounded-2xl glass-card p-3 text-xs">
                  <div className="mb-2 flex items-center gap-1.5 text-muted-foreground">
                    <Activity className="h-3.5 w-3.5" /> Episoade fără nume
                  </div>
                  {watch.missingTitles.length === 0 ? (
                    <div className="text-emerald-400">Toate completate.</div>
                  ) : (
                    <>
                      <div className="flex flex-wrap gap-1 stagger-in">
                        {watch.missingTitles.map((m) => (
                          <span
                            key={`${m.show}-${m.code}`}
                            className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-400"
                          >
                            {m.show} {m.code}
                          </span>
                        ))}
                      </div>
                      {/* Fără explicație, lista pare o defecțiune. De obicei nu
                          e: TMDB pur și simplu n-a publicat încă titlul. */}
                      <div className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                        TMDB n-are încă un titlu pentru ele. Se reîncearcă la fiecare ciclu; după 14
                        zile de la difuzare acceptăm numele generic și nu mai interogăm.
                      </div>
                    </>
                  )}
                </div>

                <div className="rounded-2xl glass-card divide-y divide-border/50 text-xs">
                  <Row
                    icon={<RefreshCw className="h-3.5 w-3.5" />}
                    label="Metadate împrospătate"
                    flashKey={watch.lastMetaRefreshAt}
                  >
                    {watch.lastMetaRefreshAt ? (
                      relativeTime(`${watch.lastMetaRefreshAt.replace(" ", "T")}Z`)
                    ) : (
                      <span className="text-muted-foreground">încă niciodată</span>
                    )}
                  </Row>
                </div>
              </>
            )}
          </div>
        )}
      </DrawerContent>
    </Drawer>
  );
}

// `flashKey`: când valoarea afișată se schimbă (ex. "acum 1h" → "acum 2h",
// după un refetch), valoarea clipește scurt. Animația stă pe cifre, unde
// înseamnă ceva — "asta tocmai s-a actualizat" — nu pe blocuri de text
// statice, unde ar fi doar decor.
function Row({
  icon,
  label,
  children,
  flashKey,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
  flashKey?: string | number | null;
}) {
  const flash = useFlashOnChange(flashKey);
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span
        className={`min-w-0 truncate text-right tabular-nums text-foreground ${flash ? "tick-flash" : ""}`}
      >
        {children}
      </span>
    </div>
  );
}

// Aceeași idee ca `Row`, dar pentru o valoare dintr-un rând de text liber.
function FlashValue({
  flashKey,
  children,
}: {
  flashKey?: string | number | null;
  children: React.ReactNode;
}) {
  const flash = useFlashOnChange(flashKey);
  return <span className={`tabular-nums ${flash ? "tick-flash" : ""}`}>{children}</span>;
}
