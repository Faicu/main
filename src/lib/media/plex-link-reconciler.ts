// ---------------------------------------------------------------------------
// Reconciliere periodică: titluri descărcate complet, dar nelegate încă la Plex.
//
// După ce un torrent se termină, download.ts încearcă legarea într-o buclă de
// 30 de minute (180 × 10s). Problema: bucla trăiește în procesul serverului, iar
// resumeOrphanedPolls reia la pornire DOAR descărcările cu completedAt === null
// — adică exact cele care încă se descarcă. Un titlu deja marcat complet, prins
// de un restart în fereastra aceea de 30 de minute, nu mai era reluat de nimeni
// (comentariul din download.ts o spunea explicit: "nu mai există job periodic de
// backfill ca plasă de siguranță, deci fereastra asta e singura șansă").
//
// Cum workflow-ul de deploy repornește serviciul la fiecare modificare de cod,
// scenariul nu e teoretic: rândul rămânea permanent cu plex_rating_key NULL,
// blocat pe "Se procesează în Plex" în Bibliotecă.
//
// Jobul de aici e plasa de siguranță lipsă: la pornire și apoi periodic, caută
// rândurile în starea asta și reîncearcă legarea.
// ---------------------------------------------------------------------------

import { getDb } from "../db";
import { resolveMediaPlexLinkByTorrentHash, resolveSeasonPackPlexLinks } from "./media";

// Cât timp după completare mai merită reîncercat. Peste asta, fie fișierul nu a
// ajuns niciodată în bibliotecă (șters manual, mutat, respins de Plex), fie e
// nevoie de intervenție — reîncercarea la nesfârșit ar fi doar zgomot.
const MAX_AGE_HOURS = 72;

export interface ReconcileResult {
  checked: number;
  linked: number;
}

export async function reconcilePlexLinks(): Promise<ReconcileResult> {
  const db = getDb();

  // Un hash poate acoperi mai multe rânduri (pachet de sezon), de aceea DISTINCT
  // — funcțiile de legare lucrează oricum la nivel de hash.
  const rows = db
    .prepare(
      `SELECT DISTINCT torrent_hash FROM media
       WHERE torrent_hash IS NOT NULL
         AND plex_rating_key IS NULL
         AND completed_at IS NOT NULL
         AND completed_at > datetime('now', ?)`,
    )
    .all(`-${MAX_AGE_HOURS} hours`) as Array<{ torrent_hash: string }>;

  if (rows.length === 0) return { checked: 0, linked: 0 };

  let linked = 0;
  for (const { torrent_hash } of rows) {
    try {
      const ok = await resolveMediaPlexLinkByTorrentHash(torrent_hash);
      const okPack = ok ? false : await resolveSeasonPackPlexLinks(torrent_hash);
      if (ok || okPack) {
        linked++;
        console.log(`[plex-reconcile] Legat la Plex: ${torrent_hash}`);
      }
    } catch (e) {
      console.warn(`[plex-reconcile] Eroare la ${torrent_hash}:`, e);
    }
  }

  // rows.length > 0 e garantat aici (ieșirea devreme de mai sus acoperă
  // restul), deci logăm doar când chiar s-a legat ceva — altfel linia asta
  // apărea la fiecare 10 minute cât timp exista măcar un titlu în așteptare.
  if (linked > 0) {
    console.log(
      `[plex-reconcile] ${rows.length} titluri nelegate verificate, ${linked} legate acum`,
    );
  }
  return { checked: rows.length, linked };
}
