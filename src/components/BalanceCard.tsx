import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Eye, EyeOff, Landmark } from "lucide-react";
import { db, updateSettings } from "../db/db";
import { EMPTY_LIST } from "../lib/stable";
import { fmtMoney, roundMoney, todayISO } from "../lib/format";
import { computeBalance } from "../lib/balance";
import { useUIStore } from "../store/useUIStore";

/** Figures stay hidden until asked for — this is the one number on Home that
 *  is the whole of what a person has, so it is never on show by default. */
const MASK = "••••••";
const AUTO_HIDE_MS = 12000;

export default function BalanceCard({
  currency,
  monthlyIncome,
}: {
  currency: string;
  monthlyIncome: number;
}) {
  const showToast = useUIStore((s) => s.showToast);
  const transactions = useLiveQuery(() => db.transactions.toArray(), []) ?? EMPTY_LIST;
  const splitShares = useLiveQuery(() => db.splitShares.toArray(), []) ?? EMPTY_LIST;
  const settings = useLiveQuery(() => db.settings.get(1), []);

  const [revealed, setRevealed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  // Re-hide on its own, and the instant the app goes to the background.
  useEffect(() => {
    if (!revealed) return;
    const hide = () => {
      setRevealed(false);
      setEditing(false);
    };
    const timer = window.setTimeout(hide, AUTO_HIDE_MS);
    const onVisibility = () => {
      if (document.hidden) hide();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", hide);
    };
  }, [revealed, editing]);

  const { monthLeft, totalLeft } = computeBalance({
    transactions,
    splitShares,
    monthlyIncome,
    today: todayISO(),
    anchorAmount: settings?.balanceAnchorAmount,
    anchorDate: settings?.balanceAnchorDate,
    anchorAt: settings?.balanceAnchorAt,
  });

  async function saveBalance() {
    const val = parseFloat(draft);
    if (!Number.isFinite(val)) {
      showToast("Enter the balance in your account.");
      return;
    }
    await updateSettings({
      balanceAnchorAmount: roundMoney(val),
      balanceAnchorDate: todayISO(),
      balanceAnchorAt: Date.now(),
    });
    setEditing(false);
    showToast("Balance saved.");
  }

  const tone = (n: number) => (n < 0 ? "var(--over)" : undefined);
  const row = (label: string, value: React.ReactNode) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "6px 0" }}>
      <span className="muted">{label}</span>
      <b style={{ fontVariantNumeric: "tabular-nums" }}>{value}</b>
    </div>
  );

  return (
    <div className="card" aria-label="Money in hand">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <Landmark size={18} />
          In hand
        </h2>
        <button
          className="icon-btn"
          aria-label={revealed ? "Hide balance" : "Show balance"}
          aria-pressed={revealed}
          onClick={() => {
            setRevealed((r) => !r);
            setEditing(false);
          }}
        >
          {revealed ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </div>

      {row(
        "This month left",
        revealed ? (
          <span style={{ color: tone(monthLeft) }}>{fmtMoney(monthLeft, currency)}</span>
        ) : (
          <span aria-label="hidden">{MASK}</span>
        ),
      )}
      {row(
        "Total left",
        !revealed ? (
          <span aria-label="hidden">{MASK}</span>
        ) : totalLeft === null ? (
          <span className="muted" style={{ fontWeight: 400 }}>not set</span>
        ) : (
          <span style={{ color: tone(totalLeft) }}>{fmtMoney(totalLeft, currency)}</span>
        ),
      )}

      {revealed && !editing && (
        <button
          className="btn secondary"
          style={{ marginTop: 8 }}
          onClick={() => {
            setDraft(totalLeft === null ? "" : String(totalLeft));
            setEditing(true);
          }}
        >
          {totalLeft === null ? "Set my balance" : "Adjust balance"}
        </button>
      )}

      {revealed && editing && (
        <div style={{ marginTop: 8 }}>
          <label htmlFor="balance-now">Balance in your account right now</label>
          <input
            id="balance-now"
            type="number"
            inputMode="decimal"
            placeholder="0.00"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onWheel={(e) => e.currentTarget.blur()}
          />
          <p className="muted" style={{ marginTop: 8 }}>
            Everything you log from now on is added to or taken from this, so
            the total keeps up with your real account. Enter it again any time
            to correct drift.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={saveBalance}>Save</button>
            <button className="btn secondary" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
