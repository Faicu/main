interface Props {
  value: number;
  label?: string;
  right?: string;
  tone?: "default" | "warn" | "danger" | "success" | "sky" | "muted";
  /**
   * Bară în lucru — gradient care curge, în locul culorii plate.
   * "down" = descărcare (albastru), "up" = seeding (verde, mai lent, invers).
   */
  active?: boolean | "down" | "up";
}

export function Meter({ value, label, right, tone, active }: Props) {
  const flow = active === "up" ? "progress-flow progress-flow-up" : active ? "progress-flow" : null;
  const pct = Math.min(100, Math.max(0, value));
  const auto: Props["tone"] = pct >= 90 ? "danger" : pct >= 75 ? "warn" : "default";
  const t = tone ?? auto;
  const color =
    t === "danger"
      ? "bg-red-500"
      : t === "warn"
        ? "bg-amber-500"
        : t === "success"
          ? "bg-emerald-500"
          : t === "sky"
            ? "bg-sky-500"
            : t === "muted"
              ? "bg-muted-foreground/40"
              : "bg-primary";
  return (
    <div>
      {(label || right) && (
        <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
          {label && <span>{label}</span>}
          {right && <span className="tabular-nums">{right}</span>}
        </div>
      )}
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted/60">
        <div
          className={`relative h-full overflow-hidden transition-[width] duration-700 ease-out ${
            flow ?? color
          }`}
          style={{
            width: `${pct}%`,
            boxShadow: "0 0 12px color-mix(in oklab, currentColor 60%, transparent)",
          }}
        >
          <span className="shimmer-sweep" />
        </div>
      </div>
    </div>
  );
}
