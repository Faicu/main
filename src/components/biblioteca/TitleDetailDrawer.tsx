import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Film,
  Tv,
  Eye,
  EyeOff,
  Captions,
  CaptionsOff,
  Flag,
  Clock3,
  Users,
  User,
  Tag,
  Loader2,
  Trash2,
  Wrench,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  XCircle,
  ArrowLeft,
  Radar,
  CalendarClock,
  CheckCheck,
  RefreshCw,
  CircleDashed,
} from "lucide-react";

import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { getPlexTitleDetail } from "@/lib/services.functions";
import type { PlexTitleDetail } from "@/lib/services/plex-browse";
import { correctSubtitleForMedia, deleteSubtitleForMedia } from "@/lib/filelist.functions";
import { setShowWatch, checkShowNow } from "@/lib/media/media.functions";
import { formatMs, formatBytes, formatSpeed, formatEta } from "@/lib/format";
import { Progress } from "@/components/ui/progress";
import { StatusBadge } from "./StatusBadge";
import {
  episodeCode,
  addedDate,
  groupBySeason,
  nextEpisodeWhen,
  displayEpisodeTitle,
} from "./utils";

// Drawer-ul de detalii al unui titlu din Bibliotecă — complet independent de
// listă: primește doar mediaId, își gestionează singur toată starea (query
// de detalii, corectare/ștergere subtitrare). Cere listei doar două lucruri,
// prin callback-uri: să deschidă confirmarea de ștergere completă (rândurile
// rămân la nivel de listă, ca overlay simplu peste drawer — nu un
// AlertDialog Radix imbricat, care ar îngheța ecranul, vezi commit c76ce30)
// și să știe când s-a șters efectiv titlul, ca să închidă drawer-ul și să
// reîmprospăteze lista.
export function TitleDetailDrawer({
  mediaId,
  onClose,
  onRequestDelete,
}: {
  mediaId: number | null;
  onClose: () => void;
  onRequestDelete: (info: {
    mediaId: number;
    title: string;
    isSeasonPack: boolean;
    isCancel: boolean;
  }) => void;
}) {
  const queryClient = useQueryClient();
  const [correcting, setCorrecting] = useState(false);
  const [deletingSubtitle, setDeletingSubtitle] = useState(false);
  const [showTech, setShowTech] = useState(false);
  // Navigare serial → episod în ACELAȘI drawer, cu buton de întoarcere.
  // Nu un al doilea drawer/dialog peste primul: overlay-urile Radix imbricate
  // într-un Drawer vaul îngheață ecranul fără nicio eroare logată (vezi
  // commit c76ce30 și incidentul din AddMediaWizard).
  // Perechea (serial, episod), nu doar id-ul episodului: ștergerea unui titlu
  // pune mediaId pe null din afară, fără ca vaul să apeleze onOpenChange, deci
  // un reset făcut doar acolo lăsa episodul agățat — următorul titlu deschis
  // ar fi afișat direct episodul rămas din sesiunea anterioară. Legat de
  // serialul lui, starea se invalidează singură, fără useEffect.
  const [openEpisode, setOpenEpisode] = useState<{ showId: number; episodeId: number } | null>(
    null,
  );
  const [savingWatch, setSavingWatch] = useState(false);
  const [checkingNow, setCheckingNow] = useState(false);
  const [pickingWatch, setPickingWatch] = useState(false);

  const correctFn = useServerFn(correctSubtitleForMedia);
  const deleteSubtitleFn = useServerFn(deleteSubtitleForMedia);
  const setShowWatchFn = useServerFn(setShowWatch);
  const checkShowNowFn = useServerFn(checkShowNow);

  // Serialul rămâne "titlul de bază" al drawer-ului; când e deschis un episod,
  // el devine subiectul afișat, iar butonul înapoi doar golește starea asta.
  // Dacă titlul de bază a dispărut (ex. ștergere), episodul deschis peste el
  // nu mai are context — nu ținem o cerere vie pentru un drawer închis.
  const openEpisodeId = openEpisode?.showId === mediaId ? openEpisode.episodeId : null;
  const activeId = mediaId == null ? null : (openEpisodeId ?? mediaId);

  const detail = useQuery({
    queryKey: ["plexTitleDetail", activeId],
    queryFn: () => getPlexTitleDetail({ data: { mediaId: activeId! } }),
    enabled: !!activeId,
    // Progres live cât timp titlul e în descărcare sau în așteptarea
    // indexării Plex — se oprește automat când trece la "in_library" (vezi
    // și plexLibraryBrowseQuery).
    //
    // Serialele merg pe un puls mult mai lent, din două motive. Întâi, n-au
    // ce câștiga din cel rapid: buildDetailFromMediaRow calculează progresul
    // qBittorrent doar pentru filme/episoade, deci pentru un serial cele
    // 2.5s reinterogau ceva ce se schimbă abia când Plex indexează un episod
    // — o chestiune de minute. Apoi, statusul unui serial e agregat din
    // episoadele lui și rămâne "downloading" cât timp măcar unul n-a ajuns
    // în Plex: un episod blocat definitiv (torrent șters din qBittorrent)
    // ținea pulsul de 2.5s pornit la nesfârșit, cât timp drawer-ul e deschis.
    refetchInterval: (query) => {
      const d = query.state.data;
      if (d?.status !== "ok") return false;
      const { status, type } = d.detail;
      if (status !== "downloading" && status !== "processing") return false;
      return type === "tv_show" ? 15_000 : 2500;
    },
  });
  const d = detail.data?.status === "ok" ? detail.data.detail : null;

  function invalidateAfterMutation() {
    queryClient.invalidateQueries({ queryKey: ["plexLibraryBrowse"] });
    // Ambele niveluri: o schimbare pe episod (subtitrare, ștergere) se vede și
    // în lista de episoade a serialului de deasupra.
    for (const id of new Set([mediaId, activeId])) {
      if (id) queryClient.invalidateQueries({ queryKey: ["plexTitleDetail", id] });
    }
  }

  async function toggleWatch(enabled: boolean, mode: "forward" | "backfill" = "forward") {
    if (!d) return;
    setSavingWatch(true);
    const res = await setShowWatchFn({
      data: { mediaId: d.mediaId, enabled, quality: d.autoDownloadQuality ?? "1080p", mode },
    }).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
    setSavingWatch(false);
    setPickingWatch(false);
    if (!res.ok) {
      toast.error("Nu am putut schimba urmărirea", { description: res.error });
      return;
    }
    toast.success(enabled ? "Urmărire pornită" : "Urmărire oprită");
    invalidateAfterMutation();
  }

  async function setWatchQuality(quality: string) {
    if (!d) return;
    setSavingWatch(true);
    // Schimbarea calității pe un serial deja urmărit nu trebuie să mute
    // punctul de pornire înapoi — de-aia "backfill" nu apare aici.
    //
    // Eroarea se raportează, ca la toggleWatch de mai sus: setShowWatchCore
    // întoarce {ok:false} și când n-ai drepturi pe serial, iar varianta veche
    // (`.catch(() => {})`, fără să se uite la rezultat) o înghițea complet —
    // calitatea părea schimbată până la următorul refetch, care o dădea
    // înapoi fără nicio explicație.
    const res = await setShowWatchFn({
      data: { mediaId: d.mediaId, enabled: true, quality },
    }).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
    setSavingWatch(false);
    if (!res.ok) {
      toast.error("Nu am putut schimba calitatea", { description: res.error });
      return;
    }
    invalidateAfterMutation();
  }

  async function checkNow() {
    if (!d) return;
    setCheckingNow(true);
    const toastId = toast.loading(`Verific episoade noi pentru „${d.show ?? d.title}”…`);
    const res = await checkShowNowFn({ data: { mediaId: d.mediaId } }).catch((e) => ({
      ok: false as const,
      error: e instanceof Error ? e.message : String(e),
    }));
    setCheckingNow(false);
    if (!res.ok) {
      toast.error("Verificarea a eșuat", { id: toastId, description: res.error });
      return;
    }
    const o = res.outcome;
    if (o.downloaded.length > 0) {
      toast.success(`Pornite ${o.downloaded.length}`, {
        id: toastId,
        description: o.downloaded.join(", "),
        duration: 8000,
      });
    } else {
      toast.info("Niciun episod nou de descărcat", {
        id: toastId,
        // Motivul contează: "lipsesc 3 episoade, dar niciun torrent 1080p" e
        // altceva decât "ești la zi", iar fără el depanarea e ghicit.
        description:
          o.skipped ??
          (o.missing.length > 0 ? `Lipsesc: ${o.missing.join(", ")}` : "Ești la zi cu serialul"),
        duration: 8000,
      });
    }
    invalidateAfterMutation();
  }

  async function correctSubtitle() {
    if (!d) return;
    setCorrecting(true);
    const toastId = toast.loading(`Verific subtitrarea pentru „${d.title}”…`);
    const res = await correctFn({
      data: { mediaId: d.mediaId },
    }).catch((e) => ({
      status: "error" as const,
      error: e instanceof Error ? e.message : String(e),
    }));
    setCorrecting(false);
    if (res.status !== "ok") {
      toast.error("Eroare la corectarea subtitrării", { id: toastId, description: res.error });
      return;
    }
    toast.success("Subtitrare verificată", {
      id: toastId,
      description: res.detail,
      duration: 6000,
    });
    invalidateAfterMutation();
  }

  async function deleteSubtitle() {
    if (!d) return;
    setDeletingSubtitle(true);
    const toastId = toast.loading(`Șterg subtitrarea pentru „${d.title}”…`);
    const res = await deleteSubtitleFn({
      data: { mediaId: d.mediaId },
    }).catch((e) => ({
      status: "error" as const,
      error: e instanceof Error ? e.message : String(e),
    }));
    setDeletingSubtitle(false);
    if (res.status !== "ok") {
      toast.error("Eroare la ștergerea subtitrării", { id: toastId, description: res.error });
      return;
    }
    toast.success("Subtitrare ștearsă", {
      id: toastId,
      description: res.deleted.join(", "),
      duration: 6000,
    });
    invalidateAfterMutation();
  }

  return (
    <Drawer
      open={!!mediaId}
      onOpenChange={(o) => {
        if (o) return;
        setOpenEpisode(null);
        onClose();
      }}
    >
      <DrawerContent className="max-h-[85vh]">
        <DrawerHeader className="pb-2 text-left">
          {openEpisodeId != null && (
            <button
              type="button"
              onClick={() => setOpenEpisode(null)}
              className="mb-1 flex w-fit items-center gap-1 rounded-full bg-muted/60 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ArrowLeft className="h-3 w-3" /> Înapoi la serial
            </button>
          )}
          <div className="flex items-start gap-3">
            {d?.thumbUrl && (
              <img
                src={d.thumbUrl}
                className="h-20 w-14 shrink-0 rounded-lg object-cover bg-muted"
                loading="lazy"
                alt=""
              />
            )}
            <div className="min-w-0">
              <DrawerTitle className="flex items-center gap-2 text-base">
                {d?.type === "movie" ? (
                  <Film className="h-4 w-4 text-amber-400 shrink-0" />
                ) : (
                  <Tv className="h-4 w-4 text-blue-400 shrink-0" />
                )}
                {d ? (d.type === "movie" ? d.title : (d.show ?? d.title)) : "Se încarcă…"}
              </DrawerTitle>
              {d?.type === "episode" && (
                <DrawerDescription className="text-left text-sm font-medium text-foreground leading-snug mt-1">
                  {episodeCode(d.season, d.episode) ?? ""}
                  {displayEpisodeTitle(d.title) ? ` · ${d.title}` : ""}
                </DrawerDescription>
              )}
              {d?.originalTitle &&
                d.originalTitle !== (d.type === "movie" ? d.title : (d.show ?? d.title)) && (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground italic">
                    {d.originalTitle}
                  </div>
                )}
              {d?.imdbId && (
                <a
                  href={`https://www.imdb.com/title/${d.imdbId}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-flex w-fit items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-muted transition-colors"
                >
                  <ExternalLink className="h-3 w-3" /> IMDb
                </a>
              )}
            </div>
          </div>
        </DrawerHeader>

        <div className="px-4 pb-6 space-y-3 overflow-y-auto overscroll-contain max-h-[65vh]">
          {detail.isLoading && (
            <div className="text-xs text-muted-foreground">Se încarcă detaliile…</div>
          )}
          {detail.data?.status === "error" && (
            <div className="text-xs text-red-400">{detail.data.error}</div>
          )}
          {d && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {d.status !== "in_library" && (
                  <StatusBadge status={d.status} progress={d.progress} />
                )}
                {/* Calitatea, audio/subtitrarea și durata sunt proprietăți ale
                    unui FIȘIER. Rândul-părinte 'tv_show' nu are fișier, deci
                    coloanele lui sunt goale prin construcție — iar
                    has_romanian_subtitle = 0 pe el nu înseamnă "fără
                    subtitrare RO", ci "întrebare fără sens la nivel de
                    serial". Se aplică per episod, nu aici. */}
                {d.type !== "tv_show" && d.quality && (
                  <span className="rounded-full bg-amber-500/15 text-amber-400 px-2 py-0.5 font-medium">
                    {d.quality}
                  </span>
                )}
                {d.type === "tv_show" ? null : d.hasRomanianAudio ? (
                  <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 text-emerald-400 px-2 py-0.5 font-medium">
                    <Flag className="h-3 w-3" />
                    Românesc
                  </span>
                ) : (
                  // Cât timp titlul e în descărcare, subtitrarea încă nu a fost
                  // căutată/verificată — un badge "Fără subtitrare RO" ar fi fals,
                  // nu doar incomplet, de-aia îl ascundem până se termină.
                  d.status !== "downloading" && (
                    <span
                      className={`flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${
                        d.hasRomanianSubtitle
                          ? "bg-emerald-500/15 text-emerald-400"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      <Captions className="h-3 w-3" />
                      {d.hasRomanianSubtitle
                        ? "Subtitrare RO"
                        : "Fără subtitrare RO (doar engleză)"}
                    </span>
                  )
                )}
                {d.durationMs > 0 && (
                  <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
                    <Clock3 className="h-3 w-3" /> {formatMs(d.durationMs)}
                  </span>
                )}
                {d.year && (
                  <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
                    {d.year}
                  </span>
                )}
              </div>

              {d.status === "downloading" && d.progress != null && (
                <div>
                  <Progress value={d.progress} />
                  <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>{d.progress.toFixed(1)}%</span>
                    <span>
                      {d.dlspeed != null && formatSpeed(d.dlspeed)}
                      {d.eta != null && ` · rămas ${formatEta(d.eta)}`}
                    </span>
                  </div>
                </div>
              )}

              {d.status === "processing" && (
                <div className="text-[11px] text-muted-foreground">
                  Fișierul e descărcat complet — aștept ca Plex să îl indexeze.
                </div>
              )}

              {d.genres.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <Tag className="h-3 w-3 text-muted-foreground shrink-0" />
                  {d.genres.map((g) => (
                    <span
                      key={g}
                      className="rounded-full bg-muted/60 px-2 py-0.5 text-[11px] text-foreground"
                    >
                      {g}
                    </span>
                  ))}
                </div>
              )}

              {d.summary && (
                <div className="text-xs text-muted-foreground leading-relaxed">{d.summary}</div>
              )}

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>Adăugat: {addedDate(d.addedAt)}</span>
                <span className="flex items-center gap-1">
                  <User className="h-3 w-3" /> {d.addedByUsername ?? "necunoscut"}
                </span>
              </div>

              <div className="flex items-center gap-1.5 text-xs">
                {d.watchedByMe ? (
                  <Eye className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                ) : (
                  <EyeOff className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                )}
                <span>
                  {d.type === "tv_show"
                    ? // Pentru un serial, "ai văzut acest titlu" n-ar spune
                      // nimic util — un episod din 36 e tot "văzut".
                      `Ai văzut ${d.episodes.filter((e) => e.watchedByMe).length} din ${d.episodes.length} episoade`
                    : d.watchedByMe
                      ? d.watchedByMeAt
                        ? `Ai văzut acest titlu · ${addedDate(d.watchedByMeAt)}`
                        : "Ai văzut acest titlu"
                      : "Nu ai văzut acest titlu"}
                </span>
              </div>

              <div className="text-xs">
                <div className="mb-1 flex items-center gap-1 text-muted-foreground">
                  <Users className="h-3.5 w-3.5" /> Alți utilizatori care au văzut
                </div>
                {d.watchedByOthers.length > 0 ? (
                  <div className="flex flex-col gap-1">
                    {d.watchedByOthers.map((u) => (
                      <div
                        key={u.username}
                        className="flex items-center justify-between gap-2 rounded-lg bg-muted/60 px-2 py-1"
                      >
                        <span className="text-[11px] font-medium text-foreground">
                          {u.username}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          {addedDate(u.viewedAt)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-muted-foreground">Nimeni altcineva încă</div>
                )}
              </div>

              {d.tech && (
                <div className="text-xs">
                  <button
                    type="button"
                    onClick={() => setShowTech((v) => !v)}
                    className="flex w-full items-center gap-1 py-1 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Wrench className="h-3.5 w-3.5" /> Detalii tehnice
                    {showTech ? (
                      <ChevronDown className="h-3.5 w-3.5 ml-auto" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 ml-auto" />
                    )}
                  </button>
                  {showTech && (
                    <div className="flex flex-col gap-1 rounded-lg bg-muted/40 px-2 py-1.5">
                      {[
                        d.tech.torrentName && ["Torrent", d.tech.torrentName],
                        d.tech.sizeBytes > 0 && ["Mărime", formatBytes(d.tech.sizeBytes)],
                        d.tech.categoryName && ["Categorie", d.tech.categoryName],
                        (d.tech.freeleech || d.tech.internal) && [
                          "Steaguri",
                          [d.tech.freeleech && "freeleech", d.tech.internal && "internal"]
                            .filter(Boolean)
                            .join(", "),
                        ],
                        d.tech.savePath && ["Cale disk", d.tech.savePath],
                        d.tech.addedVia && ["Adăugat via", d.tech.addedVia],
                        d.tech.completedAt && [
                          "Finalizat",
                          addedDate(
                            Math.floor(
                              new Date(`${d.tech.completedAt.replace(" ", "T")}Z`).getTime() / 1000,
                            ),
                          ),
                        ],
                        d.tech.subtitleSource && ["Sursă subtitrare", d.tech.subtitleSource],
                        d.tech.subtitleDetail && ["Detaliu subtitrare", d.tech.subtitleDetail],
                        d.tech.subtitleCheckedAt && [
                          "Subtitrare verificată",
                          addedDate(
                            Math.floor(
                              new Date(`${d.tech.subtitleCheckedAt.replace(" ", "T")}Z`).getTime() /
                                1000,
                            ),
                          ),
                        ],
                        d.tech.plexRatingKey && ["Plex ratingKey", d.tech.plexRatingKey],
                        d.tech.imdbId && ["IMDb", d.tech.imdbId],
                        d.torrentHash && ["Torrent hash", d.torrentHash],
                      ]
                        .filter((row): row is [string, string] => !!row)
                        .map(([label, value]) => (
                          <div key={label} className="flex justify-between gap-3">
                            <span className="shrink-0 text-muted-foreground">{label}</span>
                            <span
                              className="min-w-0 truncate text-right text-foreground"
                              title={value}
                            >
                              {value}
                            </span>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}

              {d.type === "tv_show" && (
                <>
                  {/* Următorul episod — citit din `media`, nu cerut live:
                      show-watcher îl ține la zi din TMDB (data) + TVmaze (ora
                      exactă). Ora se redă în fusul browserului, deci apare
                      direct în ora României. */}
                  <NextEpisodeLine detail={d} />
                  {/* Urmărirea episoadelor noi. Ascunsă pentru serialele
                      încheiate — n-au ce episoade noi să primească — DAR nu și
                      când e deja pornită: un serial urmărit care se încheie
                      între timp ar rămâne altfel cu urmărirea activă și fără
                      niciun buton prin care s-o oprești. */}
                  {d.canManage && (d.tvStatus !== "Ended" || d.autoDownload) && (
                    <div
                      className={`rounded-xl border border-border bg-muted/30 p-3 space-y-2 ${d.autoDownload ? "border-flow" : ""}`}
                    >
                      <div className="flex items-center gap-2">
                        <Radar
                          className={`h-4 w-4 shrink-0 ${d.autoDownload ? "text-violet-400" : "text-muted-foreground"}`}
                        />
                        <span className="flex-1 text-xs font-medium">
                          {d.autoDownload ? "Urmărit" : "Urmărește episoade noi"}
                        </span>
                        {d.autoDownload ? (
                          <button
                            type="button"
                            onClick={() => toggleWatch(false)}
                            disabled={savingWatch}
                            className="rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 disabled:opacity-40"
                          >
                            Oprește
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setPickingWatch((v) => !v)}
                            disabled={savingWatch}
                            className="rounded-lg bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
                          >
                            Pornește
                          </button>
                        )}
                      </div>

                      {/* Alegerea punctului de pornire e explicită, nu
                          implicită: pentru un serial din care ai doar primele
                          sezoane, "recuperează tot" înseamnă zeci de episoade
                          descărcate deodată — trebuie să fie o decizie luată
                          în cunoștință de cauză, nu un efect secundar. */}
                      {pickingWatch && !d.autoDownload && (
                        <div className="space-y-1.5">
                          <button
                            type="button"
                            onClick={() => toggleWatch(true, "forward")}
                            className="w-full rounded-lg bg-muted/60 px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-muted"
                          >
                            <span className="block font-medium text-foreground">
                              Doar de acum înainte
                            </span>
                            <span className="block text-muted-foreground">
                              Descarcă episoadele care apar din acest moment
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleWatch(true, "backfill")}
                            className="w-full rounded-lg bg-muted/60 px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-muted"
                          >
                            <span className="block font-medium text-foreground">
                              Recuperează și ce lipsește
                            </span>
                            <span className="block text-muted-foreground">
                              Descarcă și episoadele difuzate pe care nu le ai
                            </span>
                          </button>
                        </div>
                      )}

                      {d.autoDownload && (
                        <>
                          <div className="flex items-center gap-1.5">
                            <span className="text-[11px] text-muted-foreground">Calitate</span>
                            <select
                              value={d.autoDownloadQuality ?? "1080p"}
                              onChange={(e) => setWatchQuality(e.target.value)}
                              disabled={savingWatch}
                              className="rounded-lg border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] outline-none focus:ring-1 focus:ring-primary"
                            >
                              {["4K HDR", "4K", "1080p", "720p", "SD"].map((q) => (
                                <option key={q} value={q}>
                                  {q}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              onClick={checkNow}
                              disabled={checkingNow}
                              className="ml-auto flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-muted/60 disabled:opacity-40"
                            >
                              {checkingNow ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <RefreshCw className="h-3 w-3" />
                              )}
                              Verifică acum
                            </button>
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            {d.autoDownloadFrom
                              ? `De după ${d.autoDownloadFrom}. `
                              : "Recuperează tot ce lipsește. "}
                            {d.watchLastCheckedAt
                              ? `Verificat ultima dată ${addedDate(Math.floor(new Date(`${d.watchLastCheckedAt.replace(" ", "T")}Z`).getTime() / 1000))}.`
                              : "Încă neverificat."}
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  <div className="space-y-1.5">
                    {groupBySeason(d.episodes).map((group) => (
                      <div key={group.season ?? "x"}>
                        <div className="mb-1 flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
                          {group.season != null ? `Sezonul ${group.season}` : "Fără sezon"}
                          <span className="text-[10px] font-normal">
                            {group.episodes.length}{" "}
                            {group.episodes.length === 1 ? "episod" : "episoade"}
                          </span>
                        </div>
                        <div className="space-y-1 stagger-in">
                          {group.episodes.map((ep) => (
                            <button
                              key={ep.mediaId}
                              type="button"
                              onClick={() =>
                                setOpenEpisode({ showId: mediaId!, episodeId: ep.mediaId })
                              }
                              className="flex w-full items-center gap-2 rounded-lg bg-muted/40 px-2 py-1.5 text-left transition-all hover:bg-muted/60 active:scale-[0.99]"
                            >
                              {ep.status === "in_library" ? (
                                ep.watchedByMe ? (
                                  <Eye className="h-3 w-3 shrink-0 text-emerald-400" />
                                ) : (
                                  <EyeOff className="h-3 w-3 shrink-0 text-muted-foreground" />
                                )
                              ) : (
                                <CircleDashed className="h-3 w-3 shrink-0 animate-pulse text-blue-400" />
                              )}
                              {/* Un pachet de sezon încă neterminat e un
                                  singur rând cu episode NULL — se desface în
                                  episoade abia după ce Plex îl indexează.
                                  Fără cazul ăsta, rândul afișa doar "—". */}
                              <span className="shrink-0 text-[11px] font-medium tabular-nums">
                                {episodeCode(ep.season, ep.episode) ??
                                  (ep.isSeasonPack && ep.season != null
                                    ? `Sezonul ${ep.season} — pachet complet`
                                    : "—")}
                              </span>
                              {/* Numele lipsește cât timp completarea din TMDB
                                  n-a ajuns la episodul ăsta — rândul rămâne
                                  valid, doar cu codul. */}
                              {displayEpisodeTitle(ep.episodeTitle) && (
                                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                                  {ep.episodeTitle}
                                </span>
                              )}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {d.type !== "tv_show" && (
                <div className="flex flex-col gap-2 pt-1 border-t border-border">
                  {d.torrentHash ? (
                    d.canManage ? (
                      d.status === "downloading" ? (
                        <button
                          type="button"
                          onClick={() =>
                            onRequestDelete({
                              mediaId: d.mediaId,
                              title: d.type === "movie" ? d.title : (d.show ?? d.title),
                              isSeasonPack: d.isSeasonPack,
                              isCancel: true,
                            })
                          }
                          className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-border bg-muted/40 py-2 text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors"
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          Anulare
                        </button>
                      ) : (
                        <>
                          <div className="flex gap-2 pt-2">
                            <button
                              type="button"
                              onClick={correctSubtitle}
                              disabled={correcting}
                              className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-border bg-muted/40 py-2 text-xs font-medium text-foreground hover:bg-muted/60 transition-colors disabled:opacity-40"
                            >
                              {correcting ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Captions className="h-3.5 w-3.5" />
                              )}
                              Corectează subtitrare
                            </button>
                            <button
                              type="button"
                              onClick={deleteSubtitle}
                              disabled={deletingSubtitle}
                              className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-border bg-muted/40 py-2 text-xs font-medium text-foreground hover:bg-muted/60 transition-colors disabled:opacity-40"
                            >
                              {deletingSubtitle ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <CaptionsOff className="h-3.5 w-3.5" />
                              )}
                              Șterge subtitrare
                            </button>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              onRequestDelete({
                                mediaId: d.mediaId,
                                title: d.type === "movie" ? d.title : (d.show ?? d.title),
                                isSeasonPack: d.isSeasonPack,
                                isCancel: false,
                              })
                            }
                            className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-border bg-muted/40 py-2 text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Șterge titlul complet
                          </button>
                        </>
                      )
                    ) : (
                      <div className="pt-2 text-[11px] text-muted-foreground">
                        Doar {d.addedByUsername ?? "cel care a adăugat titlul"} sau un admin poate
                        corecta/șterge subtitrarea sau șterge titlul.
                      </div>
                    )
                  ) : (
                    <div className="pt-2 text-[11px] text-muted-foreground">
                      Nu știm ce torrent corespunde acestui titlu (a fost adăugat manual în Plex,
                      sau torrentul nu mai există în qBittorrent) — corectarea/ștergerea subtitrării
                      și ștergerea completă nu sunt disponibile.
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function NextEpisodeLine({ detail }: { detail: PlexTitleDetail }) {
  const when = nextEpisodeWhen(detail.nextEpisodeAirDate, detail.nextEpisodeAirstamp);

  // Serial încheiat: spunem asta explicit, în loc să lăsăm un gol care ar
  // putea fi citit drept "încă n-am aflat".
  if (detail.tvStatus === "Ended" && !when) {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <CheckCheck className="h-3.5 w-3.5 shrink-0" />
        Serial încheiat — nu mai urmează episoade
      </div>
    );
  }

  if (!when || !detail.nextEpisode) {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <CalendarClock className="h-3.5 w-3.5 shrink-0" />
        Niciun episod nou anunțat încă
      </div>
    );
  }

  return (
    <div
      className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs ${
        when.soon ? "bg-primary/10 text-foreground" : "bg-muted/30 text-muted-foreground"
      }`}
    >
      <CalendarClock
        className={`h-3.5 w-3.5 shrink-0 ${when.soon ? "animate-pulse text-primary" : ""}`}
      />
      <span>
        Urmează <span className="font-medium text-foreground">{detail.nextEpisode}</span> ·{" "}
        {when.text}
      </span>
    </div>
  );
}
