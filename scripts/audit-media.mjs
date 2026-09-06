// Audit read-only al tabelei `media`: caută stări inconsistente care ar face
// un titlu să dispară din Bibliotecă, să rămână blocat, sau să nu poată fi
// urmărit. Scris după incidentul Insula Iubirii (6 sep 2026), unde două
// episoade au lipsit o zi fără ca nimic să semnaleze.
//
//   node scripts/audit-media.mjs

import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.env.FAIKKITBOX_DB_PATH ?? "data/faikkitbox.db", {
  readOnly: true,
});

const checks = [
  [
    "Episoade fără sezon/episod (nu se pot potrivi cu Plex sau cu TMDB)",
    `SELECT id, title, torrent_name, is_season_pack FROM media
      WHERE media_type = 'episode' AND (season IS NULL OR episode IS NULL)`,
  ],
  [
    "Rânduri fără tmdb_id (nu pot primi metadate, nume de episod sau urmărire)",
    `SELECT id, media_type, title, added_via FROM media WHERE tmdb_id IS NULL`,
  ],
  [
    "Seriale fără imdb_id (urmărirea nu poate căuta pe Filelist — e strict pe IMDb)",
    `SELECT id, title, tmdb_id, auto_download FROM media
      WHERE media_type = 'tv_show' AND imdb_id IS NULL`,
  ],
  [
    "Același episod de mai multe ori sub același serial",
    `SELECT parent_id, season, episode, COUNT(*) n FROM media
      WHERE media_type = 'episode' GROUP BY parent_id, season, episode HAVING n > 1`,
  ],
  [
    // Doar rândurile venite dintr-o descărcare reală: cele de backfill nu au
    // avut niciodată un moment de "finalizare" (au fost importate din Plex),
    // deci completed_at NULL e corect acolo, nu o inconsistență.
    "Legat la Plex dar nemarcat complet (stare contradictorie)",
    `SELECT id, title, season, episode FROM media
      WHERE plex_rating_key IS NOT NULL AND completed_at IS NULL
        AND torrent_hash IS NOT NULL AND added_via != 'backfill'`,
  ],
  [
    "Blocate în „se descarcă” de peste 2 zile",
    `SELECT id, title, season, episode, added_at FROM media
      WHERE plex_rating_key IS NULL AND torrent_hash IS NOT NULL
        AND added_at < datetime('now', '-2 days')`,
  ],
  [
    "Episoade orfane (părinte inexistent)",
    `SELECT id, title, season, episode FROM media
      WHERE media_type = 'episode'
        AND (parent_id IS NULL OR parent_id NOT IN (SELECT id FROM media))`,
  ],
  [
    "Seriale fără niciun episod (invizibile în Bibliotecă)",
    `SELECT id, title FROM media WHERE media_type = 'tv_show'
       AND id NOT IN (SELECT parent_id FROM media WHERE parent_id IS NOT NULL)`,
  ],
  [
    "Același imdb_id pe mai multe rânduri-rădăcină (legare greșită, ca Reuniuni)",
    `SELECT imdb_id, COUNT(*) n, group_concat(title, ' | ') titluri FROM media
      WHERE parent_id IS NULL AND imdb_id IS NOT NULL GROUP BY imdb_id HAVING n > 1`,
  ],
  [
    "Același tmdb_id pe mai multe rânduri-rădăcină",
    `SELECT tmdb_id, COUNT(*) n, group_concat(title, ' | ') titluri FROM media
      WHERE parent_id IS NULL AND tmdb_id IS NOT NULL GROUP BY tmdb_id HAVING n > 1`,
  ],
  [
    // Doar descărcările de după apariția tabelei `media` — cele dinainte n-au
    // avut niciodată cum să producă un rând, iar backfill-ul din Plex le-a
    // preluat doar pe cele încă prezente acolo. Fără filtrul ăsta, verificarea
    // raportează permanent 25 de intrări din iulie-august, adică zgomot care
    // ar ascunde exact cazul real pe care îl căutăm.
    "Descărcări din jurnal fără rând în media (conținut invizibil în Bibliotecă)",
    `SELECT d.id, d.name, d.completed_at FROM downloads d
      WHERE d.torrent_hash IS NOT NULL
        AND d.downloaded_at > (SELECT MIN(added_at) FROM media)
        AND NOT EXISTS (SELECT 1 FROM media m WHERE m.torrent_hash = d.torrent_hash)
      ORDER BY d.downloaded_at DESC`,
  ],
  [
    "Urmărire pornită pe seriale încheiate (nu vor mai veni episoade)",
    `SELECT id, title, tv_status FROM media
      WHERE auto_download = 1 AND tv_status = 'Ended'`,
  ],
  [
    "Urmărire pornită fără calitate setată",
    `SELECT id, title FROM media WHERE auto_download = 1 AND auto_download_quality IS NULL`,
  ],
  [
    // Difuzate de peste 30 de zile: sub pragul ăsta e normal să lipsească —
    // show-watch reîncearcă până TMDB completează, iar după 14 zile acceptă
    // placeholder-ul generic. Ce rămâne aici e chestie care chiar s-a blocat.
    "Episoade difuzate demult, încă fără nume (completarea pare blocată)",
    `SELECT e.id, p.title, e.season, e.episode FROM media e JOIN media p ON p.id = e.parent_id
      WHERE e.media_type = 'episode' AND e.episode_title IS NULL
        AND e.season IS NOT NULL AND e.episode IS NOT NULL AND p.tmdb_id IS NOT NULL
        AND e.added_at < datetime('now', '-30 days')`,
  ],
];

let problems = 0;
for (const [label, sql] of checks) {
  const rows = db.prepare(sql).all();
  if (rows.length === 0) {
    console.log(`  ok   ${label}`);
    continue;
  }
  problems += rows.length;
  console.log(`\n  !!   ${label} — ${rows.length}`);
  for (const r of rows.slice(0, 10)) console.log(`         ${JSON.stringify(r)}`);
  if (rows.length > 10) console.log(`         … încă ${rows.length - 10}`);
  console.log();
}
console.log(`\n${problems === 0 ? "Nicio problemă." : `Total rânduri semnalate: ${problems}`}`);
