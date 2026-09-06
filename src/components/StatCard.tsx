import { type ReactNode } from "react";

import { useFlashOnChange } from "@/hooks/use-flash-on-change";

interface Props {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  accent?: string;
}

export function StatCard({ label, value, sub, icon, accent }: Props) {
  // Micro-flash whenever the displayed value changes
  const flash = useFlashOnChange(
    typeof value === "string" || typeof value === "number" ? String(value) : undefined,
  );
  return (
    <div className="glass-card glass-card-hover relative overflow-hidden rounded-2xl p-3">
      <div className="relative z-10 flex items-center justify-between text-xs text-muted-foreground">
        <span className="uppercase tracking-wide">{label}</span>
        {icon && <span className={accent}>{icon}</span>}
      </div>
      <div
        className={`relative z-10 mt-1 text-xl font-semibold tabular-nums text-foreground ${flash ? "tick-flash" : ""}`}
      >
        {value}
      </div>
      {sub && (
        <div className="relative z-10 mt-0.5 text-xs text-muted-foreground tabular-nums">{sub}</div>
      )}
    </div>
  );
}
