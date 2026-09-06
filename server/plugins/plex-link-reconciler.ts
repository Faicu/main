// ---------------------------------------------------------------------------
// Plugin: reconciliere periodică a titlurilor descărcate dar nelegate la Plex.
// Vezi src/lib/media/plex-link-reconciler.ts pentru motivul existenței.
// ---------------------------------------------------------------------------

export default function () {
  // La 10 minute: destul de des cât un titlu prins de un restart să se lege în
  // câteva minute, destul de rar cât să nu conteze (interogarea nu atinge Plex
  // decât dacă chiar există rânduri nelegate).
  const INTERVAL_MS = 10 * 60_000;

  // Gardă de suprapunere: fiecare hash nelegat înseamnă câteva cereri către
  // Plex, deci o rulare cu multe rânduri în așteptare poate depăși intervalul.
  // Două rulări simultane ar încerca să desfacă același pachet de sezon în
  // paralel, dublând rândurile de episod pe care le creează.
  let running = false;

  async function run() {
    if (running) return;
    running = true;
    try {
      const { reconcilePlexLinks } = await import("../../src/lib/media/plex-link-reconciler");
      await reconcilePlexLinks();
    } catch (e) {
      console.warn("[plex-reconcile] Rulare eșuată:", e);
    } finally {
      running = false;
    }
  }

  // Prima rulare la 45s după pornire — după ce Plex și qBittorrent au avut timp
  // să răspundă, și după fereastra în care resumeOrphanedPolls (15s) își reia
  // propriile polling-uri, ca să nu se calce reciproc pe același hash.
  setTimeout(run, 45_000);
  setInterval(run, INTERVAL_MS);
}
