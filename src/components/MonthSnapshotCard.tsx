import { fmtMoney } from "../lib/format";
import type { MonthSnapshot, SnapshotKind } from "../lib/monthSnapshot";

/** Whole-picture card: income, spent, saved/invested and what's left. Used by
 *  History (one month) and Analytics (month or range). When `onSelect` is
 *  given, the Income / Spent / Saved blocks are tappable and open that kind of
 *  entry; "Left over" is a calculation, not a list, so it never is. */
export default function MonthSnapshotCard({
  snapshot,
  currency,
  title = "Snapshot",
  caption,
  activeKind,
  onSelect,
}: {
  snapshot: MonthSnapshot;
  currency: string;
  title?: string;
  caption?: string;
  activeKind?: SnapshotKind | null;
  onSelect?: (kind: SnapshotKind) => void;
}) {
  const s = snapshot;
  const empty = s.txCount === 0;
  // Bar shows where income went; only meaningful when there is income and
  // nothing overdrew it.
  const base = Math.max(s.income, s.spent + s.saved);
  const pct = (n: number) => (base > 0 ? Math.max(0, (n / base) * 100) : 0);
  const pick = (kind: SnapshotKind, amount: number) =>
    onSelect && amount > 0 ? () => onSelect(kind) : undefined;

  return (
    <div className="card" data-testid="month-snapshot">
      <h2>
        {title}
        {caption && (
          <span className="muted" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
            {caption}
          </span>
        )}
      </h2>
      {empty ? (
        <div className="muted">Nothing logged for this period.</div>
      ) : (
        <>
          <div className="grid-3" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 0 }}>
            <Stat
              label="Income"
              value={fmtMoney(s.income, currency)}
              tone="pos"
              active={activeKind === "income"}
              onClick={pick("income", s.income)}
            />
            <Stat
              label="Spent"
              value={fmtMoney(s.spent, currency)}
              active={activeKind === "spent"}
              onClick={pick("spent", s.spent)}
            />
            <Stat
              label="Saved & invested"
              value={fmtMoney(s.saved, currency)}
              active={activeKind === "saved"}
              onClick={pick("saved", s.saved)}
            />
            {/* "Left over" only means something against logged income. */}
            {s.income > 0 ? (
              <Stat
                label={s.left < 0 ? "Overdrawn" : "Left over"}
                value={fmtMoney(Math.abs(s.left), currency)}
                tone={s.left < 0 ? "neg" : "pos"}
              />
            ) : (
              <Stat label="Left over" value="—" />
            )}
          </div>
          {base > 0 && (
            <div
              role="img"
              aria-label={`Of your money: ${pct(s.spent).toFixed(0)}% spent, ${pct(s.saved).toFixed(0)}% saved`}
              style={{
                display: "flex",
                height: 8,
                borderRadius: 4,
                overflow: "hidden",
                background: "var(--surface-strong)",
                marginTop: 14,
              }}
            >
              <span style={{ width: `${pct(s.spent)}%`, background: "var(--gold)" }} />
              <span style={{ width: `${pct(s.saved)}%`, background: "var(--good)" }} />
            </div>
          )}
          {s.income > 0 && (
            <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
              {s.savingsRate.toFixed(0)}% of income saved or invested ·{" "}
              {s.txCount} {s.txCount === 1 ? "entry" : "entries"}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  active,
  onClick,
}: {
  label: string;
  value: string;
  tone?: "pos" | "neg";
  active?: boolean;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </>
  );
  if (!onClick) return <div className={tone}>{inner}</div>;
  return (
    <div
      className={tone}
      role="button"
      tabIndex={0}
      aria-label={`${label}: ${value}. Show entries`}
      aria-pressed={active ?? false}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      style={{ cursor: "pointer", outline: active ? "2px solid var(--accent, currentColor)" : undefined }}
    >
      {inner}
    </div>
  );
}
