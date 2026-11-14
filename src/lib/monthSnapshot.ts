import type { Bracket, Category, Transaction } from "../db/db";
import { monthKey } from "./format";

/** The whole-month picture: what came in, what was spent, what was moved
 *  into savings/investments, and what is left. Pure — shared by History and
 *  Analytics so both always tell the same story.
 *
 *  Definitions (same split the Budget screen uses):
 *  - income  = income-type transactions
 *  - saved   = expense-type transactions in 'allocation' brackets
 *              (Savings, Investments, EMI…) — moved, not spent
 *  - spent   = every other expense-type transaction (uncategorized included)
 *  - left    = income − spent − saved
 *  Works on any set of transactions, so a range (3 months, all time) uses the
 *  same function as a single month. */
export interface SnapshotLine {
  categoryId: number;
  name: string;
  icon: string;
  color: string;
  amount: number;
}

export interface MonthSnapshot {
  income: number;
  spent: number;
  saved: number;
  left: number;
  /** saved / income as a percentage; 0 when there is no income. */
  savingsRate: number;
  txCount: number;
  incomeLines: SnapshotLine[];
  spendLines: SnapshotLine[];
  savedLines: SnapshotLine[];
}

export function buildSnapshot(
  transactions: Transaction[],
  categories: Category[],
  brackets: Bracket[],
): MonthSnapshot {
  const allocationBrackets = new Set(
    brackets.filter((b) => b.kind === "allocation").map((b) => b.id),
  );
  const catById = new Map(categories.map((c) => [c.id, c]));

  const income = new Map<number, number>();
  const spend = new Map<number, number>();
  const saved = new Map<number, number>();
  const bump = (m: Map<number, number>, id: number, n: number) =>
    m.set(id, (m.get(id) ?? 0) + n);

  for (const t of transactions) {
    if (t.type === "income") {
      bump(income, t.categoryId, t.amount);
      continue;
    }
    const cat = catById.get(t.categoryId);
    if (cat && allocationBrackets.has(cat.bracketId)) bump(saved, t.categoryId, t.amount);
    else bump(spend, t.categoryId, t.amount);
  }

  const toLines = (m: Map<number, number>): SnapshotLine[] =>
    [...m.entries()]
      .map(([id, amount]) => {
        const c = catById.get(id);
        return {
          categoryId: id,
          name: c?.name ?? "Uncategorized",
          icon: c?.icon ?? "＊",
          color: c?.color ?? "#888888",
          amount,
        };
      })
      .sort((a, b) => b.amount - a.amount);
  const sum = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0);

  const inc = sum(income);
  const sp = sum(spend);
  const sv = sum(saved);
  return {
    income: inc,
    spent: sp,
    saved: sv,
    left: inc - sp - sv,
    savingsRate: inc > 0 ? (sv / inc) * 100 : 0,
    txCount: transactions.length,
    incomeLines: toLines(income),
    spendLines: toLines(spend),
    savedLines: toLines(saved),
  };
}

export function buildMonthSnapshot(
  month: string,
  transactions: Transaction[],
  categories: Category[],
  brackets: Bracket[],
): MonthSnapshot {
  return buildSnapshot(
    transactions.filter((t) => monthKey(t.date) === month),
    categories,
    brackets,
  );
}

export type SnapshotKind = "income" | "spent" | "saved";

/** Which snapshot block a transaction counts toward — same rule as
 *  buildSnapshot, so a block's total always equals the sum of its entries. */
export function classifyTransaction(
  t: Transaction,
  categories: Category[],
  brackets: Bracket[],
): SnapshotKind {
  if (t.type === "income") return "income";
  const cat = categories.find((c) => c.id === t.categoryId);
  const b = cat && brackets.find((x) => x.id === cat.bracketId);
  return b?.kind === "allocation" ? "saved" : "spent";
}
