// Verificare read-only: ce există în Plex dar lipsește din `media` (și invers).
// Exact tiparul care a ascuns o zi dispariția episoadelor Insula Iubirii.
//
//   node --env-file=.env scripts/run-check.mjs

import { getDb } from "../src/lib/db";
import { discoverPlexUrl } from "../src/lib/services/plex-shared";

const token = process.env.PLEX_TOKEN!;
const { url } = await discoverPlexUrl(token, process.env.PLEX_URL);
const headers = { Accept: "application/json", "X-Plex-Token": token };

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${url}${path}`, { headers });
  return res.json() as Promise<T>;
}

interface Section {
  key: string;
  type: string;
  title: string;
}
interface Item {
  ratingKey: string;
  title: string;
  year?: number;
  type: string;
  leafCount?: number;
}

const sections = (await api<{ MediaContainer: { Directory: Section[] } }>("/library/sections"))
  .MediaContainer.Directory;

const db = getDb();
const mediaKeys = new Set(
  (
    db
      .prepare("SELECT plex_rating_key FROM media WHERE plex_rating_key IS NOT NULL")
      .all() as Array<{
      plex_rating_key: string;
    }>
  ).map((r) => r.plex_rating_key),
);
const mediaTitles = new Set(
  (
    db.prepare("SELECT DISTINCT lower(title) t FROM media WHERE parent_id IS NULL").all() as Array<{
      t: string;
    }>
  ).map((r) => r.t),
);

for (const s of sections) {
  if (s.type !== "movie" && s.type !== "show") continue;
  const items =
    (await api<{ MediaContainer: { Metadata?: Item[] } }>(`/library/sections/${s.key}/all`))
      .MediaContainer.Metadata ?? [];

  const missing: string[] = [];
  for (const it of items) {
    if (s.type === "movie") {
      if (!mediaKeys.has(it.ratingKey))
        missing.push(`${it.title}${it.year ? ` (${it.year})` : ""}`);
    } else {
      // Pentru seriale comparăm la nivel de EPISOD, după ratingKey: titlul
      // rândului din `media` e cel românesc de la TMDB și diferă intenționat
      // de cel din Plex ("Viața mea cu băieții familiei Walter" vs "My Life
      // with the Walter Boys"), deci potrivirea pe titlu ar da alarme false.
      const eps =
        (
          await api<{ MediaContainer: { Metadata?: Item[] } }>(
            `/library/metadata/${it.ratingKey}/allLeaves`,
          )
        ).MediaContainer.Metadata ?? [];
      const lipsa = eps.filter((e) => !mediaKeys.has(e.ratingKey));
      if (lipsa.length > 0) {
        missing.push(`${it.title}: ${lipsa.length}/${eps.length} episoade lipsă`);
      }
    }
  }

  console.log(
    `\n### ${s.title} [${s.type}] — ${items.length} în Plex, ${missing.length} lipsă din Bibliotecă`,
  );
  for (const m of missing) console.log(`   · ${m}`);
}
