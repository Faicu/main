import { createServerFn } from "@tanstack/react-start";

import { fetchJson } from "../services/shared";

// ---------------------------------------------------------------------------
// TVmaze e folosit doar ca supliment la TMDB pentru ora exactă de lansare a
// unui episod — TMDB oferă doar data (air_date), fără oră. API public, fără
// cheie. Dacă TVmaze nu are serialul (imdbId necunoscut) sau e indisponibil,
// întoarcem listă goală — restul UI-ului cade elegant pe data-only din TMDB.
// ---------------------------------------------------------------------------

export interface TvmazeAirstamp {
  seasonNumber: number;
  episodeNum: number;
  airstamp: string | null;
}

interface TvmazeLookupShow {
  id: number;
}

interface TvmazeEpisodeRaw {
  season: number;
  number: number;
  airstamp: string | null;
}

// Exportată și pentru cod server-side (show-watch.ts, care salvează ora
// următorului episod în `media`), nu doar pentru server function-ul de mai jos.
export async function getTvmazeAirstampsInternal(imdbId: string): Promise<TvmazeAirstamp[]> {
  try {
    const show = await fetchJson<TvmazeLookupShow>(
      `https://api.tvmaze.com/lookup/shows?imdb=${encodeURIComponent(imdbId)}`,
    );
    if (!show?.id) return [];
    const episodes = await fetchJson<TvmazeEpisodeRaw[]>(
      `https://api.tvmaze.com/shows/${show.id}/episodes`,
    );
    return episodes.map((e) => ({
      seasonNumber: e.season,
      episodeNum: e.number,
      airstamp: e.airstamp ?? null,
    }));
  } catch {
    return [];
  }
}

export const getTvmazeAirstamps = createServerFn({ method: "GET" })
  .validator((data: { imdbId: string }) => data)
  .handler(async ({ data }): Promise<TvmazeAirstamp[]> => {
    const { requireAuth } = await import("../auth/admin.server");
    await requireAuth();
    return getTvmazeAirstampsInternal(data.imdbId);
  });
