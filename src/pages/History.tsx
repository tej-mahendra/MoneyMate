import { useMemo, useState } from "react";
import { EMPTY_LIST } from "../lib/stable";
import { useLiveQuery } from "dexie-react-hooks";
import { useSearchParams } from "react-router-dom";
import { db, type Transaction, type SplitShare } from "../db/db";
import {
  fmtMoney,
  monthKey,
  monthLabel,
  shortDate,
  todayISO,
  iconBadgeStyle,
  daysInMonth,
} from "../lib/format";
import { loggedMonthsFromDates } from "../lib/loggedMonths";
import { buildMonthSnapshot, classifyTransaction, type SnapshotKind } from "../lib/monthSnapshot";
import MonthSnapshotCard from "../components/MonthSnapshotCard";
import { useUIStore } from "../store/useUIStore";
import CalendarHeatmap from "../components/CalendarHeatmap";
import { List, CalendarDays, Inbox, X, Plus } from "lucide-react";
import Dropdown from "../components/Dropdown";
import { useNavigate } from "react-router-dom";

export default function History({ currency }: { currency: string }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const showToast = useUIStore((s) => s.showToast);
  const showConfirm = useUIStore((s) => s.showConfirm);
  const allTx = useLiveQuery(() => db.transactions.toArray(), []) ?? EMPTY_LIST;
  const categories = useLiveQuery(() => db.categories.toArray(), []) ?? EMPTY_LIST;
  const brackets = useLiveQuery(() => db.brackets.toArray(), []) ?? EMPTY_LIST;
  // One-off purchases are shown by the item's own name, not "Purchases · name".
  const oneOffBracketIds = new Set(brackets.filter((b) => b.kind === "one_off").map((b) => b.id));
  const oneOffCategoryIds = new Set(
    categories.filter((c) => oneOffBracketIds.has(c.bracketId)).map((c) => c.id),
  );
  const catMap = new Map(categories.map((c) => [c.id, c]));
  const curMonth = monthKey(todayISO());

  const requestedMonth = params.get("month");
  const [selectedMonth, setMonth] = useState(
    requestedMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth)
      ? requestedMonth
      : monthKey(todayISO()),
  );
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"list" | "calendar">("list");
  const [dayFilter, setDayFilter] = useState<string | null>(null);
  const catFilter = params.get("cat") ? Number(params.get("cat")) : null;
  const kindParam = params.get("kind");
  const kindFilter: SnapshotKind | null =
    kindParam === "income" || kindParam === "spent" || kindParam === "saved" || kindParam === "oneoff"
      ? kindParam
      : null;
  const [lastDeleted, setLastDeleted] = useState<{ transaction: Transaction; shares: SplitShare[] } | null>(null);

  // Only months that have something logged (plus the current one), newest
  // first — months before logging began never appear.
  const months = useMemo(
    () => loggedMonthsFromDates(allTx.map((t) => t.date), curMonth).reverse(),
    [allTx, curMonth],
  );
  // If the selected month has since emptied (its last entry was deleted),
  // fall back to the newest logged month instead of showing a ghost month.
  const month = months.includes(selectedMonth) ? selectedMonth : months[0];

  const filtered = allTx
    .filter((t) => monthKey(t.date) === month)
    .filter((t) => (catFilter ? t.categoryId === catFilter : true))
    .filter((t) => (dayFilter ? t.date === dayFilter : true))
    .filter((t) => (kindFilter ? classifyTransaction(t, categories, brackets) === kindFilter : true))
    .filter((t) => {
      if (!query.trim()) return true;
      const q = query.toLowerCase();
      const cat = catMap.get(t.categoryId);
      return (
        (t.note || "").toLowerCase().includes(q) ||
        (t.merchant || "").toLowerCase().includes(q) ||
        (cat?.name || "").toLowerCase().includes(q) ||
        String(t.amount).includes(q)
      );
    })
    .sort((a, b) =>
      a.date === b.date ? b.createdAt - a.createdAt : a.date < b.date ? 1 : -1,
    );

  const monthTotal = filtered
    .filter((t) => t.type === "expense")
    .reduce((s, t) => s + t.amount, 0);
  const snapshot = buildMonthSnapshot(month, allTx, categories, brackets);
  const monthHasTx = snapshot.txCount > 0;
  const isPast = month < curMonth;

  // Tapping a snapshot block filters the list below to its entries; tapping
  // it again clears the filter.
  function toggleKind(k: SnapshotKind) {
    const next = new URLSearchParams(params);
    if (kindFilter === k) next.delete("kind");
    else next.set("kind", k);
    setParams(next, { replace: true });
    setView("list");
    setDayFilter(null);
  }

  async function del(t: Transaction) {
    // Closed months are history people rely on — ask first. The current
    // month stays one-tap with Undo.
    if (monthKey(t.date) < curMonth) {
      const ok = await showConfirm({
        title: "Delete this entry?",
        message: `It will be removed from ${monthLabel(monthKey(t.date))}'s totals.`,
        confirmLabel: "Delete",
        cancelLabel: "Keep it",
        danger: true,
      });
      if (!ok) return;
    }
    // A split expense's IOU rows point at this transaction — deleting it
    // without them leaves debris that no longer traces back to any real
    // expense. Captured alongside the transaction here so Undo can restore
    // both together, not just the transaction with its split history gone.
    const shares = t.id != null ? await db.splitShares.where("transactionId").equals(t.id).toArray() : [];
    await db.transaction("rw", db.transactions, db.splitShares, async () => {
      if (shares.length) await db.splitShares.bulkDelete(shares.map((s) => s.id!));
      await db.transactions.delete(t.id!);
    });
    setLastDeleted({ transaction: t, shares });
    showToast("Deleted — tap Undo to restore");
  }
  async function undo() {
    if (!lastDeleted) return;
    const { transaction, shares } = lastDeleted;
    const { id: _id, ...rest } = transaction;
    const newId = await db.transactions.add(rest);
    if (shares.length) {
      await db.splitShares.bulkAdd(shares.map(({ id: _id, ...s }) => ({ ...s, transactionId: newId })));
    }
    setLastDeleted(null);
    showToast("Restored.");
  }

  return (
    <>
      <header className="topbar">
        <div className="eyebrow">History</div>
        <h1>Transactions</h1>
        <div className="sub">
          {fmtMoney(monthTotal, currency)} spent this view
        </div>
      </header>
      <div className="content">
        <div className="card">
          <div className="row2">
            <Dropdown
              value={month}
              onChange={(v) => {
                setMonth(v);
                setDayFilter(null);
              }}
              options={months.map((m) => ({ value: m, label: monthLabel(m) }))}
            />
            <input
              type="text"
              placeholder="Search…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="chip-row">
            <button
              className={"chip" + (view === "list" ? " active" : "")}
              onClick={() => setView("list")}
            >
              <span
                style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
              >
                <List size={13} /> List
              </span>
            </button>
            <button
              className={"chip" + (view === "calendar" ? " active" : "")}
              onClick={() => setView("calendar")}
            >
              <span
                style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
              >
                <CalendarDays size={13} /> Calendar
              </span>
            </button>
          </div>
          {kindFilter && (
            <div className="chip-row">
              <button
                className="chip active"
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.delete("kind");
                  setParams(next, { replace: true });
                }}
              >
                {kindFilter === "income"
                  ? "Income"
                  : kindFilter === "saved"
                    ? "Saved & invested"
                    : kindFilter === "oneoff"
                      ? "One-off"
                      : "Spent"}{" "}
                <X size={12} style={{ display: "inline", verticalAlign: "middle" }} />
              </button>
            </div>
          )}
          {catFilter && (
            <div className="chip-row">
              <button className="chip active" onClick={() => setParams({})}>
                {catMap.get(catFilter)?.name || "Category"}{" "}
                <X
                  size={12}
                  style={{ display: "inline", verticalAlign: "middle" }}
                />
              </button>
            </div>
          )}
          {dayFilter && (
            <div className="chip-row">
              <button
                className="chip active"
                onClick={() => setDayFilter(null)}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  {dayFilter} <X size={12} />
                </span>
              </button>
            </div>
          )}
        </div>

        {monthHasTx && (
          <MonthSnapshotCard
            snapshot={snapshot}
            currency={currency}
            title="Month snapshot"
            caption={monthLabel(month)}
            onSelect={toggleKind}
            activeKind={kindFilter}
          />
        )}

        {isPast && (
          <button
            className="btn small secondary"
            style={{ marginBottom: 12, width: "100%" }}
            onClick={() => navigate(`/add?date=${month}-${String(daysInMonth(month)).padStart(2, "0")}`)}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Plus size={14} /> Add entry to {monthLabel(month)}
            </span>
          </button>
        )}

        {view === "calendar" && (
          <div className="card">
            <h2>Spending heatmap</h2>
            <CalendarHeatmap
              month={month}
              transactions={allTx}
              currency={currency}
              onSelectDay={setDayFilter}
            />
          </div>
        )}

        {monthHasTx && (
          <button
            className="btn small secondary"
            style={{ marginBottom: 12, width: "100%" }}
            onClick={() => navigate(`/budget?month=${month}`)}
          >
            {monthLabel(month)} budget review →
          </button>
        )}

        <div className="card" data-testid="transaction-list">
          {filtered.length === 0 ? (
            <div className="empty">
              <div className="glyph">
                <Inbox size={30} strokeWidth={1.5} />
              </div>
              Nothing here yet.
            </div>
          ) : (
            filtered.map((t) => {
              const c = catMap.get(t.categoryId);
              return (
                <div
                  className="tx tx-link"
                  key={t.id}
                  onClick={() => navigate(`/transaction/${t.id}`)}
                >
                  <div className="tx-left">
                    <div
                      className="tx-icon"
                      style={iconBadgeStyle(c?.color)}
                    >
                      {c?.icon || "＊"}
                    </div>
                    <div className="tx-meta">
                      <div className="tx-cat">
                        {oneOffCategoryIds.has(t.categoryId) && t.merchant
                          ? t.merchant
                          : (c?.name || "Uncategorized") + (t.merchant ? " · " + t.merchant : "")}
                      </div>
                      {t.note && <div className="tx-note">{t.note}</div>}
                      <div className="tx-date">
                        {shortDate(t.date)}
                        {t.paymentMethod ? " · " + t.paymentMethod : ""}
                      </div>
                    </div>
                  </div>
                  <div className="tx-right">
                    <span
                      className={
                        "tx-amt" + (t.type === "income" ? " income" : "")
                      }
                    >
                      {t.type === "income" ? "+" : "−"}
                      {fmtMoney(t.amount, currency)}
                    </span>
                    <button
                      className="icon-btn danger"
                      aria-label="Delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        del(t);
                      }}
                    >
                      <X size={15} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {lastDeleted && (
          <button className="btn secondary" onClick={undo}>
            Undo delete
          </button>
        )}
      </div>
    </>
  );
}
