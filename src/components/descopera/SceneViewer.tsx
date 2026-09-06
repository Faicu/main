import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ExternalLink, Shuffle, Plus } from "lucide-react";

import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { getTmdbVideos } from "@/lib/tmdb/tmdb.discover.functions";
import type { DiscoverTitle } from "@/lib/tmdb/tmdb.discover.functions";
import { getTmdbDetails } from "@/lib/tmdb/tmdb.functions";
import { AddMediaWizard } from "@/components/principala/AddMediaWizard";

export function SceneViewer({ item, onClose }: { item: DiscoverTitle; onClose: () => void }) {
  const videosFn = useServerFn(getTmdbVideos);
  const detailsFn = useServerFn(getTmdbDetails);
  const [videoIndex, setVideoIndex] = useState(0);
  const [wizardOpen, setWizardOpen] = useState(false);

  const videosQuery = useQuery({
    queryKey: ["tmdbVideos", item.mediaType, item.id],
    queryFn: () => videosFn({ data: { id: item.id, mediaType: item.mediaType } }),
  });
  const detailsQuery = useQuery({
    queryKey: ["tmdbDetails", item.mediaType, item.id],
    queryFn: () => detailsFn({ data: { id: item.id, mediaType: item.mediaType } }),
  });

  const videos = videosQuery.data ?? [];
  const current = videos[videoIndex] ?? null;
  const imdbId = detailsQuery.data?.imdbId ?? null;
  const releaseDate = detailsQuery.data?.releaseDate ?? null;
  const releaseDateLabel = releaseDate
    ? new Date(releaseDate).toLocaleDateString("ro-RO", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : null;

  // Fără useMemo: `videos` e o listă nouă la fiecare randare cât timp
  // query-ul n-a răspuns (`?? []`), deci memo-ul se invalida oricum de
  // fiecare dată — plătea contabilitatea fără să sară vreun calcul.
  const otherVideosCount = Math.max(0, videos.length - 1);

  return (
    <>
      {/* Ascuns (nu demontat) cât timp wizard-ul e deschis — două overlay-uri
          (Drawer + Dialog) simultan deschise au înghețat ecranul, vezi
          commit c76ce30. Rămâne montat ca să-și păstreze starea query-urilor. */}
      <Drawer
        open={!wizardOpen}
        onOpenChange={(open) => {
          if (!open && !wizardOpen) onClose();
        }}
      >
        <DrawerContent className="max-h-[90vh]">
          <DrawerHeader className="text-left pb-0">
            <DrawerTitle>{item.title}</DrawerTitle>
            {releaseDateLabel && (
              <p className="text-xs text-muted-foreground">{releaseDateLabel}</p>
            )}
          </DrawerHeader>
          <div className="space-y-3 overflow-y-auto px-4 pb-6 pt-3">
            {videosQuery.isLoading ? (
              <div className="aspect-video skeleton-sweep rounded-xl" />
            ) : current ? (
              <div className="aspect-video overflow-hidden rounded-xl bg-black">
                <iframe
                  key={current.key}
                  src={`https://www.youtube.com/embed/${current.key}?autoplay=1`}
                  title={current.name || item.title}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  className="h-full w-full"
                />
              </div>
            ) : (
              <div className="rounded-xl glass-card p-6 text-center text-sm text-muted-foreground">
                Niciun clip disponibil pentru acest titlu.
              </div>
            )}

            {detailsQuery.isLoading ? (
              <div className="h-12 skeleton-sweep rounded-lg" />
            ) : detailsQuery.data?.overview ? (
              <p className="text-sm leading-relaxed text-muted-foreground">
                {detailsQuery.data.overview}
              </p>
            ) : null}

            <div className="flex items-center justify-between gap-2">
              {otherVideosCount > 0 ? (
                <button
                  type="button"
                  onClick={() => setVideoIndex((i) => (i + 1) % videos.length)}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-xs font-medium text-foreground transition-transform hover:bg-muted/60 active:scale-[0.97]"
                >
                  <Shuffle className="h-3.5 w-3.5" /> Alt clip ({otherVideosCount} altele)
                </button>
              ) : (
                <span />
              )}
              {imdbId && (
                <a
                  href={`https://www.imdb.com/title/${imdbId}/`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  IMDb <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>

            {!detailsQuery.isLoading && (
              <button
                type="button"
                onClick={() => setWizardOpen(true)}
                className="border-flow flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-3 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition-transform hover:bg-primary/90 active:scale-[0.99]"
              >
                <Plus className="h-4 w-4" /> Adaugă film/serial
              </button>
            )}
          </div>
        </DrawerContent>
      </Drawer>

      <AddMediaWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        initialItem={{
          id: item.id,
          mediaType: item.mediaType,
          title: item.title,
          originalTitle: detailsQuery.data?.originalTitle ?? item.title,
          year: item.year,
          posterUrl: item.posterUrl,
        }}
      />
    </>
  );
}
