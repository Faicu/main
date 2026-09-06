import type { ReactNode } from "react";
import {
  GitCommitHorizontal,
  PlayCircle,
  Radar,
  Link2,
  RotateCcw,
  Power,
  PlugZap,
} from "lucide-react";

// Catalogul plugin-urilor de fundal — sursă unică pentru lista din Tehnic și
// pentru drawer-ul de detalii. Reflectă exact fișierele din server/plugins/:
// un rând per proces care rulează, nu per funcționalitate. Completarea
// numelor de episoade, de exemplu, n-are intrare proprie — e un pas dintr-un
// tic al lui show-watcher, iar o intrare separată ar putea arăta "activ"
// chiar dacă plugin-ul e mort.
export interface PluginInfo {
  // Identic cu numele fișierului din server/plugins/, fără extensie.
  id: string;
  label: string;
  description: string;
  cadence: string;
  // De ce există plugin-ul, pe scurt — aproape toate au apărut ca reacție la
  // un bug concret, iar contextul ăla e cel mai util lucru de citit când te
  // întrebi peste un an de ce e acolo.
  details: string;
  icon: ReactNode;
  // Tipul de intrare din jurnal care dovedește că a făcut ceva. Null pentru
  // cele care lucrează doar la pornire sau care nu loghează când n-au găsit
  // nimic de făcut — atunci rândul rămâne fără timestamp, ceea ce e onest.
  activityType: string | null;
}

export const PLUGINS: PluginInfo[] = [
  {
    id: "show-watcher",
    label: "Urmărire Seriale",
    description: "Descărcare automată episoade noi",
    cadence: "la 3h per serial · metadate la 12h · verificat din 10 în 10 min",
    details:
      "Face trei lucruri la fiecare tic, fiecare cu ritmul lui.\n\n1. Descărcarea episoadelor noi, la 3h per serial urmărit: compară ce s-a difuzat (TMDB) cu ce ai deja în bibliotecă și aduce diferența de pe Filelist, strict după IMDb ID. Nu ține minte ce a văzut ultima dată — întreabă de fiecare dată realitatea, deci se poate relua oricând, se repară singur după un restart și nu poate descărca de două ori.\n\n2. Numele episoadelor, pentru cele care încă n-au unul.\n\n3. Metadatele fiecărui serial, la 12h — inclusiv ale celor neurmărite: status (încheiat / în producție), titlul românesc și cel original, anul, și următorul episod anunțat. Contează că merge și pentru serialele neurmărite: statusul decide dacă ți se oferă butonul de urmărire, deci trebuie corect tocmai acolo unde încă n-ai pornit-o.",
    icon: <Radar className="h-4 w-4 text-violet-400" />,
    activityType: null,
  },
  {
    id: "plex-session-tracker",
    label: "Plex Session Tracker",
    description: "Urmărire sesiuni & vizionări",
    cadence: "la 30s",
    details:
      "Întreabă Plex ce se redă chiar acum și scrie în jurnal începutul și sfârșitul fiecărei vizionări. De aici vin secțiunea „Se vizionează acum” de pe Acasă și istoricul „cine a văzut” din Bibliotecă.",
    icon: <PlayCircle className="h-4 w-4 text-amber-400" />,
    activityType: "plex_watch_start",
  },
  {
    id: "plex-link-reconciler",
    label: "Reconciliere Plex",
    description: "Leagă descărcările rămase fără Plex",
    cadence: "la 10 min",
    details:
      "Un titlu descărcat complet, dar prins de un restart înainte ca Plex să-l indexeze, rămâne fără plex_rating_key — adică blocat pe „se procesează” la nesfârșit. Plugin-ul reia legarea pentru toate rândurile rămase așa. Nu atinge Plex decât dacă chiar există ceva nelegat.",
    icon: <Link2 className="h-4 w-4 text-emerald-400" />,
    activityType: null,
  },
  {
    id: "filelist-resume",
    label: "Reluare Descărcări",
    description: "Repornește polling-ul întrerupt de un restart",
    cadence: "la pornire (după 15s)",
    details:
      "Fiecare descărcare are o buclă de urmărire care trăiește în proces; un restart o omoară. Fără reluare, torrentul se termină în qBittorrent, dar aplicația nu află niciodată: fără subtitrare RO, fără completed_at, fără notificare, fără legare la Plex. A existat cândva ca efect secundar de modul și a încetat silențios să mai ruleze când modulul a devenit import leneș — de-aia e plugin explicit acum.",
    icon: <RotateCcw className="h-4 w-4 text-blue-400" />,
    activityType: null,
  },
  {
    id: "github-commit-tracker",
    label: "GitHub Commit Tracker",
    description: "Sincronizare commit-uri din GitHub",
    cadence: "la pornire (după 6s)",
    details:
      "Aduce ultimele commit-uri din GitHub și trimite notificare pentru cele noi față de ce e în DB. Acoperă cazul în care webhook-ul a picat exact în timpul unui restart.",
    icon: <GitCommitHorizontal className="h-4 w-4 text-purple-400" />,
    activityType: null,
  },
  {
    id: "activity-boot",
    label: "Jurnal Pornire/Oprire",
    description: "Înregistrează ciclul de viață al serverului",
    cadence: "la pornire",
    details:
      "Logarea pornirii/opririi rula ca efect secundar de modul, deci se executa abia la prima cerere HTTP: după un restart, jurnalul rămânea gol până deschidea cineva aplicația, iar atunci „Serverul a pornit” se scria cu ora greșită și cu cauza greșită. Dacă serviciul era oprit înainte de vreo cerere, oprirea nu se loga deloc.",
    icon: <PlugZap className="h-4 w-4 text-sky-400" />,
    activityType: "server_start",
  },
  {
    id: "fast-shutdown",
    label: "Oprire Controlată",
    description: "Închide curat la SIGTERM, înainte de SIGKILL",
    cadence: "la oprire",
    details:
      "Fără el, oprirea aștepta drenarea tuturor conexiunilor HTTP — inclusiv SSE-ul de auto-reload, deschis cât timp orice tab are dashboard-ul deschis. Asta depășea mereu TimeoutStopSec=5, iar systemd termina procesul cu SIGKILL, fără nicio șansă pentru logarea opririi. Aici dăm celorlalte listenere o fereastră scurtă, apoi ieșim controlat.",
    icon: <Power className="h-4 w-4 text-rose-400" />,
    activityType: "server_stop",
  },
];
