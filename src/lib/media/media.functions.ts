// ---------------------------------------------------------------------------
// Server functions pentru `media`, separate intenționat de media.ts.
//
// media.ts are `import { getDb } from "../db"` static la vârf, iar db.ts
// conține schema SQLite completă și hashing-ul de parole. Cât timp componente
// client importau server functions DIN media.ts, tot graful ajungea în
// bundle-ul public: /assets/db-*.js era servit cu 200 către orice browser
// (verificat — fără valori secrete din .env, care sunt înlocuite la build, dar
// cu schema și structura internă la vedere).
//
// Fișierul ăsta e subțire și fără importuri server statice: corpul unui
// handler de server function e eliminat din bundle-ul de client, deci
// `await import("./media")` de mai jos rămâne exclusiv pe server.
//
// Regulă generală: orice modul importat de componente client trebuie să nu
// aibă importuri statice server-only.
// ---------------------------------------------------------------------------

import { createServerFn } from "@tanstack/react-start";

// Doar tipuri — se șterg la compilare, nu trag nimic în bundle.
export type { LibraryTitleMatch, DownloadingMediaEntry } from "./media";
import type { LibraryTitleMatch, DownloadingMediaEntry } from "./media";
export type { ShowWatchOutcome, SetShowWatchInput } from "./show-watch";
import type { ShowWatchOutcome, SetShowWatchInput } from "./show-watch";

// Căutare de titluri deja existente în bibliotecă (rânduri-rădăcină, fără
// parent_id) — folosită la descărcarea manuală de pe Filelist.
export const searchLibraryTitles = createServerFn({ method: "GET" })
  .validator((data: { query: string }) => data)
  .handler(async ({ data }): Promise<LibraryTitleMatch[]> => {
    const { requireAdmin } = await import("../auth/admin.server");
    await requireAdmin();
    const { searchLibraryTitlesCore } = await import("./media");
    return searchLibraryTitlesCore(data.query);
  });

// Ce e deja în curs de descărcare pentru un titlu (torrent pornit, dar încă
// neindexat de Plex) — folosit de wizard ca să blocheze acțiuni duplicate.
export const getDownloadingMediaForTmdbId = createServerFn({ method: "GET" })
  .validator((data: { tmdbId: number; mediaType: "movie" | "tv" }) => data)
  .handler(async ({ data }): Promise<DownloadingMediaEntry[]> => {
    const { requireAuth } = await import("../auth/admin.server");
    await requireAuth();
    const { getDownloadingMediaForTmdbIdCore } = await import("./media");
    return getDownloadingMediaForTmdbIdCore(data.tmdbId, data.mediaType);
  });

// ---------------------------------------------------------------------------
// Urmărirea serialelor (vezi show-watch.ts)
// ---------------------------------------------------------------------------

// Aceeași regulă de permisiune ca la ștergere/corectare din drawer: cine a
// adăugat serialul, sau un admin. Urmărirea pornește descărcări reale, deci
// n-are ce căuta la îndemâna oricui e logat.
async function requireShowManage(mediaId: number) {
  const { requireAuth, isAdminOrOwner } = await import("../auth/admin.server");
  const session = await requireAuth();
  const { getDb } = await import("../db");
  const row = getDb()
    .prepare("SELECT requested_by_user_id FROM media WHERE id = ? AND media_type = 'tv_show'")
    .get(mediaId) as { requested_by_user_id: number | null } | undefined;
  if (!row) throw new Error("Serialul nu există");
  if (!isAdminOrOwner(session, row.requested_by_user_id)) {
    throw new Error("Nu ai drepturi pentru serialul ăsta");
  }
}

export const setShowWatch = createServerFn({ method: "POST" })
  .validator((data: SetShowWatchInput) => data)
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      await requireShowManage(data.mediaId);
      const { setShowWatchCore } = await import("./show-watch");
      await setShowWatchCore(data);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

// "Verifică acum" din drawer — ignoră cadența de 3 ore pentru serialul
// deschis. Depanarea tipică e "de ce n-a descărcat episodul?", iar fără
// butonul ăsta răspunsul ar fi "așteaptă 3 ore și vezi".
export const checkShowNow = createServerFn({ method: "POST" })
  .validator((data: { mediaId: number }) => data)
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; outcome: ShowWatchOutcome } | { ok: false; error: string }> => {
      try {
        await requireShowManage(data.mediaId);
        const { checkShow } = await import("./show-watch");
        return { ok: true, outcome: await checkShow(data.mediaId) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

// Starea urmăririi, pentru panoul "Plugin-uri active" din Tehnic: câte
// seriale sunt urmărite și când a verificat plugin-ul ultima dată. Timestamp-ul
// vine din `media`, nu din jurnalul de activitate — o verificare care n-a găsit
// nimic nu loghează nimic (corect, altfel ar umple jurnalul la fiecare 3 ore),
// deci jurnalul n-ar arăta niciodată că plugin-ul e viu.
export const getShowWatchStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ watchedShows: number; lastCheckedAt: string | null }> => {
    const { requireAuth } = await import("../auth/admin.server");
    await requireAuth();
    const { getDb } = await import("../db");
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS n, MAX(watch_last_checked_at) AS last
           FROM media WHERE media_type = 'tv_show' AND auto_download = 1`,
      )
      .get() as { n: number; last: string | null };
    return { watchedShows: row?.n ?? 0, lastCheckedAt: row?.last ?? null };
  },
);
