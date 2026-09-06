export default function () {
  import("../../src/lib/errors/console-capture").then(({ installConsoleErrorCapture }) =>
    installConsoleErrorCapture(),
  );

  const INTERVAL_MS = 30_000;

  async function poll() {
    const token = process.env.PLEX_TOKEN;
    const base = process.env.PLEX_URL?.replace(/\/$/, "");
    if (!token || !base) return;

    try {
      const { trackPlexSessions } = await import("../../src/lib/activity-log");

      const headers: Record<string, string> = {
        Accept: "application/json",
        "X-Plex-Token": token,
      };

      const res = await fetch(`${base}/status/sessions`, { headers });
      if (!res.ok) return;

      const json = (await res.json()) as {
        MediaContainer?: {
          Metadata?: Array<{
            duration?: number;
            viewOffset?: number;
            title?: string;
            grandparentTitle?: string;
            ratingKey?: string;
            User?: { title?: string };
            Player?: { title?: string };
          }>;
        };
      };
      const sessionsMd = json?.MediaContainer?.Metadata ?? [];

      await trackPlexSessions(
        sessionsMd.map((s) => {
          const dur = Number(s.duration ?? 0);
          // viewOffset de la Plex e mereu în milisecunde. Aici exista o
          // conversie care înmulțea cu 1000 orice offset sub 1000, presupunând
          // secunde — dar asta lovea exact cazul legitim al unei redări abia
          // pornite: 500 ms (o jumătate de secundă) devenea 500 000 ms, adică
          // 8 minute. Peste pragul MIN_PROGRESS_MS din activity-log.ts, deci o
          // vizionare pornită și oprită imediat scria în "Vizionări recente" o
          // intrare falsă, cu progres inventat.
          const off = Number(s.viewOffset ?? 0);
          return {
            user: s.User?.title ?? "unknown",
            title: s.title ?? "",
            grandparentTitle: s.grandparentTitle || undefined,
            ratingKey: s.ratingKey || undefined,
            player: s.Player?.title || undefined,
            viewOffsetMs: off,
            durationMs: dur,
          };
        }),
      );
    } catch {
      // Plex poate fi offline — ignorăm
    }
  }

  setInterval(poll, INTERVAL_MS);
}
