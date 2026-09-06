import { useEffect, useRef, useState } from "react";

// Micro-flash pe o valoare care tocmai s-a schimbat: întoarce `true` pentru
// scurt timp după fiecare schimbare a cheii, ca apelantul să pună clasa
// `tick-flash`.
//
// Nu se declanșează la prima randare — altfel fiecare valoare ar clipi la
// deschiderea ecranului, iar clipitul ar înceta să mai însemne "asta tocmai
// s-a schimbat".
//
// Trăia doar în StatCard; a fost extras când aceeași nevoie a apărut și în
// drawer-ul de plugin, ca să existe un singur loc care decide cât ține
// flash-ul și ce anume îl declanșează.
export function useFlashOnChange(key: string | number | null | undefined): boolean {
  const first = useRef(true);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setFlash(true);
    // 700ms = durata animației data-tick din styles.css.
    const t = setTimeout(() => setFlash(false), 700);
    return () => clearTimeout(t);
  }, [key]);
  return flash;
}
