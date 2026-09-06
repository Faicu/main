import { useEffect, useRef } from "react";
import { emitUpdateDetected } from "@/lib/system/update-signal";

export function useAutoReload() {
  const deployedShaRef = useRef<string | null>(null);
  const firedRef = useRef(false);

  useEffect(() => {
    let es: EventSource | null = null;
    // Reconectarea e amânată cu setTimeout, deci poate rămâne în așteptare
    // când efectul se curăță. Fără să-l reținem, timeout-ul deschidea după
    // demontare un EventSource nou pe care cleanup-ul (care capturase deja
    // instanța veche) nu-l mai putea închide — o conexiune SSE scursă, care
    // ține și serverul să nu se oprească curat.
    let reconnectId: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    function connect() {
      if (firedRef.current || cancelled) return;
      es = new EventSource("/api/deploy-sha");

      es.onmessage = (ev) => {
        const sha = ev.data.trim();
        if (!sha || firedRef.current) return;

        if (deployedShaRef.current === null) {
          deployedShaRef.current = sha;
          return;
        }

        if (deployedShaRef.current !== sha) {
          firedRef.current = true;
          es?.close();
          emitUpdateDetected();
        }
      };

      es.onerror = () => {
        es?.close();
        if (cancelled) return;
        reconnectId = setTimeout(connect, 2000);
      };
    }

    connect();
    return () => {
      cancelled = true;
      if (reconnectId !== undefined) clearTimeout(reconnectId);
      es?.close();
    };
  }, []);
}
