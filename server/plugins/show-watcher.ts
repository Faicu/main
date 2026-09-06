// ---------------------------------------------------------------------------
// Plugin: urmărirea serialelor — verifică periodic ce episoade difuzate
// lipsesc din bibliotecă și le descarcă (vezi src/lib/media/show-watch.ts
// pentru logica propriu-zisă și pentru ce a mers prost la prima încercare).
//
// Bucla de aici rulează des, dar cadența reală per serial (3 ore) e ținută în
// DB, pe `media.watch_last_checked_at` — nu într-un timer în memorie, care
// s-ar reseta la fiecare restart al serviciului.
//
// Plugin explicit, nu efect secundar de modul: aceeași lecție ca la
// activity-boot.ts și filelist-resume.ts — munca de la pornire făcută într-un
// `setTimeout` la nivel de modul funcționează doar cât timp cineva mai
// importă static modulul respectiv, și încetează silențios când nu.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 min — cât de des vedem cine a expirat

async function run(): Promise<void> {
  try {
    const { checkDueShows } = await import("../../src/lib/media/show-watch");
    await checkDueShows();
  } catch (e) {
    console.warn("[show-watcher] Rulare eșuată:", e);
  }
}

export default function () {
  // 45s: după filelist-resume (15s), ca reluarea descărcărilor întrerupte să
  // apuce să repopuleze starea înainte să ne apucăm să căutăm ce lipsește —
  // altfel un episod deja în curs ar putea părea lipsă.
  setTimeout(run, 45_000);
  setInterval(run, POLL_INTERVAL_MS);
}
