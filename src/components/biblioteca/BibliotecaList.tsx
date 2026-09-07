import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Search, Film, Tv, Eye, Users, Layers, AlertTriangle } from "lucide-react";
import { ThinkingOrb } from "thinking-orbs";

import { plexLibraryBrowseQuery } from "@/lib/queries";
import { deleteMediaEntry } from "@/lib/filelist.functions";
import type { PlexBrowseItem } from "@/lib/services/plex-browse";
import { StatusBadge } from "./StatusBadge";
import { TitleDetailDrawer } from "./TitleDetailDrawer";
import {
  addedDate,
  itemLabel,
  matchesQuery,
  isStaleUnwatched,
  sortItems,
  type SortMode,
} from "./utils";

const PAGE_SIZE = 20;

export function BibliotecaList() {
  const queryClient = useQueryClient();
  const browse = useQuery(plexLibraryBrowseQuery);
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [selectedMediaId, setSelectedMediaId] = useState<number | null>(null);
  const [confirmDeleteTitle, setConfirmDeleteTitle] = useState<{
    mediaId: number;
    title: string;
    isSeasonPack: boolean;
    isCancel: boolean;
  } | null>(null);
  const deleteEntryFn = useServerFn(deleteMediaEntry);

  const browseItems = browse.data?.status === "ok" ? browse.data.items : null;
  const allItems = useMemo(() => browseItems ?? [], [browseItems]);
  const filtered = useMemo(
    () =>
      sortItems(
        allItems.filter((it) => matchesQuery(it, query)),
        sortMode,
      ),
    [allItems, query, sortMode],
  );

  async function confirmDeleteTitleAction() {
    if (!confirmDeleteTitle) return;
    const { mediaId, isCancel } = confirmDeleteTitle;
    const res = await deleteEntryFn({ data: { mediaId } });
    setConfirmDeleteTitle(null);
    if (!res.ok) {
      toast.error(isCancel ? "Nu am putut anula descărcarea" : "Nu am putut șterge titlul", {
        description: res.error,
      });
      return;
    }
    setSelectedMediaId(null);
    queryClient.invalidateQueries({ queryKey: ["plexLibraryBrowse"] });
    if (res.qbitDeleted) {
      toast.success(
        isCancel
          ? "Descărcare anulată — fișiere + qBittorrent"
          : "Titlu șters complet — fișiere + qBittorrent + Plex",
      );
    } else {
      toast.warning("Șters din jurnal, dar nu am putut confirma ștergerea din qBittorrent");
    }
  }

  if (browse.isLoading) {
    return (
      <div className="space-y-3">
        <div className="h-10 skeleton-sweep rounded-xl" />
        <div className="space-y-1.5 rounded-2xl glass-card p-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-9 skeleton-sweep rounded-lg" />
          ))}
        </div>
      </div>
    );
  }
  if (browse.data?.status === "error") {
    return <div className="text-sm text-red-400 px-1">{browse.data.error}</div>;
  }
  if (allItems.length === 0) {
    return <div className="text-sm text-muted-foreground px-1">Biblioteca Plex e goală.</div>;
  }

  // Un singur fel de rând, pentru filme și seriale deopotrivă — episoadele nu
  // mai apar aici, ci doar în drawer-ul serialului.
  function renderRow(item: PlexBrowseItem) {
    const isShow = item.type === "tv_show";
    return (
      <button
        key={item.mediaId}
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setSelectedMediaId(item.mediaId);
        }}
        className="flex w-full items-center gap-2 rounded-lg bg-muted/40 px-2 py-1.5 text-left transition-all hover:bg-muted/60 active:scale-[0.99] active:bg-muted"
      >
        {item.thumbUrl ? (
          <img
            src={item.thumbUrl}
            className="h-8 w-8 shrink-0 rounded object-cover bg-muted"
            loading="lazy"
            alt=""
          />
        ) : isShow ? (
          <Tv className="h-3.5 w-3.5 shrink-0 text-blue-400" />
        ) : (
          <Film className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs">{itemLabel(item)}</span>
          <span className="block truncate text-[10px] text-muted-foreground">
            {isShow
              ? `${item.seasonCount || 1} ${item.seasonCount === 1 ? "sezon" : "sezoane"} · ${item.episodeCount} ${item.episodeCount === 1 ? "episod" : "episoade"}`
              : addedDate(item.addedAt)}
          </span>
        </span>
        {isShow && item.autoDownload && (
          <span
            title="Urmărit — episoadele noi se descarcă automat"
            className="flex shrink-0 items-center"
          >
            <ThinkingOrb
              state="searching"
              size={20}
              style={{ width: 12, height: 12 }}
              aria-label="Urmărit"
            />
          </span>
        )}
        {isShow && item.downloadingCount > 0 ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-400">
            <Layers className="h-2.5 w-2.5 animate-pulse" />
            {item.downloadingCount}
            {item.progress != null && ` · ${Math.round(item.progress)}%`}
          </span>
        ) : (
          <StatusBadge status={item.status} progress={item.progress} />
        )}
        {item.watchedCount > 0 && (
          <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground">
            <Users className="h-3 w-3" />
            {item.watchedCount}
          </span>
        )}
        {isStaleUnwatched(item) && (
          <span
            title="Nimeni nu l-a vizionat de peste 3 luni"
            className="flex shrink-0 items-center gap-0.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400"
          >
            <AlertTriangle className="h-2.5 w-2.5" />
          </span>
        )}
        {/* Pentru un serial, o bifă simplă "văzut" ar fi înșelătoare (ai văzut
            un episod din 36?) — arătăm câte din câte. */}
        {isShow && item.watchedEpisodes > 0 ? (
          <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-emerald-400">
            <Eye className="h-3 w-3" />
            {item.watchedEpisodes}/{item.episodeCount}
          </span>
        ) : (
          item.watchedByMe && !isShow && <Eye className="h-3 w-3 shrink-0 text-emerald-400" />
        )}
      </button>
    );
  }

  const visibleRows = filtered.slice(0, visible);

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setVisible(PAGE_SIZE);
            }}
            placeholder="Caută film sau serial…"
            className="w-full rounded-xl glass-card py-2.5 pl-9 pr-3 text-sm outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <select
          value={sortMode}
          onChange={(e) => {
            setSortMode(e.target.value as SortMode);
            setVisible(PAGE_SIZE);
          }}
          className="shrink-0 rounded-xl glass-card px-2 text-xs outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="recent">Recent adăugate</option>
          <option value="mostWatched">Cei mai vizionați</option>
          <option value="unwatched">Nevăzute de nimeni</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="text-sm text-muted-foreground px-1">Niciun rezultat.</div>
      ) : (
        <div className="glass-card rounded-2xl p-3">
          {/* `key` doar pe sortMode: schimbarea sortării chiar reordonează lista,
              deci merită reanimată. Dacă `query` ar face parte din key, fiecare
              tastă ar remonta containerul și ar reporni stagger-ul de la
              opacity: 0 — lista pâlpâia la fiecare caracter tastat. */}
          <div key={sortMode} className="space-y-1 stagger-in">
            {visibleRows.map((item) => renderRow(item))}
          </div>
          {filtered.length > visible && (
            <button
              type="button"
              onClick={() => setVisible((v) => v + PAGE_SIZE)}
              className="mt-1.5 w-full rounded-lg bg-muted/50 py-1.5 text-xs font-medium text-muted-foreground transition-all hover:bg-muted/80 hover:text-foreground active:scale-[0.98]"
            >
              Afișează mai mult
            </button>
          )}
        </div>
      )}

      <TitleDetailDrawer
        mediaId={selectedMediaId}
        onClose={() => setSelectedMediaId(null)}
        onRequestDelete={(info) => setConfirmDeleteTitle(info)}
      />

      {/* Overlay simplu (fără AlertDialog/focus-trap Radix) — peste
          TitleDetailDrawer (deja deschis) a fost un risc de îngheț identic
          cu bug-ul reparat în AddMediaWizard, vezi commit c76ce30. Portalat
          direct în body — fără portal, ancestorii cu transform (animația
          stagger-in din PageShell) devin containing block pentru "fixed" și
          overlay-ul apare decupat/în spatele conținutului, poate bloca
          click-ul pe butoane. */}
      {confirmDeleteTitle &&
        createPortal(
          <div
            className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/80 pointer-events-auto"
            onClick={() => setConfirmDeleteTitle(null)}
          >
            <div
              role="dialog"
              aria-label="Ștergere completă"
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-sm space-y-4 rounded-2xl glass-card p-5 shadow-xl"
            >
              <div className="text-sm font-semibold">
                {confirmDeleteTitle.isCancel ? "Anulare descărcare" : "Ștergere completă"}
              </div>
              <p className="whitespace-pre-line text-sm text-muted-foreground">
                {confirmDeleteTitle.isCancel
                  ? confirmDeleteTitle.isSeasonPack
                    ? `Acest episod face parte dintr-un pachet de sezon — anularea elimină TOT pachetul (toate episoadele lui), din jurnal, din qBittorrent și fișierele descărcate parțial de pe disk.\n\n${confirmDeleteTitle.title}`
                    : `Anulezi descărcarea titlului? Torrentul și fișierele descărcate parțial vor fi șterse din qBittorrent și de pe disk.\n\n${confirmDeleteTitle.title}`
                  : confirmDeleteTitle.isSeasonPack
                    ? `Acest episod face parte dintr-un pachet de sezon — ștergerea elimină TOT pachetul (toate episoadele lui), din jurnal, din qBittorrent și de pe disk, apoi rescanează Plex.\n\n${confirmDeleteTitle.title}`
                    : `Ștergi titlul din jurnal, din qBittorrent și fișierele de pe disk, apoi rescanezi Plex?\n\n${confirmDeleteTitle.title}`}
              </p>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:space-x-2">
                <button
                  type="button"
                  onClick={() => setConfirmDeleteTitle(null)}
                  className="rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground hover:bg-muted/60"
                >
                  Renunță
                </button>
                <button
                  type="button"
                  onClick={confirmDeleteTitleAction}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
                >
                  {confirmDeleteTitle.isCancel ? "Anulează descărcarea" : "Șterge"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
