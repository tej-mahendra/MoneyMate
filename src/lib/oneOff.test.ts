import { describe, it, expect, beforeEach } from "vitest";
import Papa from "papaparse";
import { db } from "../db/db";
import type { Bracket, Category, Transaction } from "../db/db";
import { buildMonthSnapshot, classifyTransaction } from "./monthSnapshot";
import { buildMonthReport } from "./monthReport";
import { buildAnalyticsFiles, TABLES, type AnalyticsInput } from "./analyticsExport";
import { exportFullBackup, importFullBackup } from "./csv";

const brackets: Bracket[] = [
  { id: 1, name: "Expenditure", icon: "💳", color: "#111111", kind: "spend" },
  { id: 2, name: "Savings", icon: "💰", color: "#222222", kind: "allocation" },
  { id: 3, name: "Income", icon: "💼", color: "#333333", kind: "income" },
  { id: 4, name: "Big Purchases", icon: "🛍️", color: "#444444", kind: "one_off" },
];
const cats: Category[] = [
  { id: 10, name: "Food", icon: "🍲", color: "#aa0000", budget: 8000, bracketId: 1 },
  { id: 20, name: "Emergency fund", icon: "🛟", color: "#0000aa", budget: 5000, bracketId: 2 },
  { id: 30, name: "Salary", icon: "💼", color: "#aaaa00", budget: 0, bracketId: 3 },
  { id: 40, name: "Phone", icon: "📱", color: "#00aaaa", budget: 0, bracketId: 4 },
];
const tx = (id: number, type: "expense" | "income", categoryId: number, amount: number, date: string): Transaction => ({
  id, type, categoryId, amount, date, createdAt: id,
});
const txs = [
  tx(1, "income", 30, 60000, "2026-11-01"),
  tx(2, "expense", 10, 3000, "2026-11-05"),
  tx(3, "expense", 20, 5000, "2026-11-06"),
  tx(4, "expense", 40, 25000, "2026-11-10"), // the phone
];

describe("one_off bracket — month snapshot", () => {
  it("keeps the purchase out of Spent but takes it off what is left", () => {
    const s = buildMonthSnapshot("2026-11", txs, cats, brackets);
    expect(s.spent).toBe(3000);
    expect(s.saved).toBe(5000);
    expect(s.oneOff).toBe(25000);
    expect(s.left).toBe(60000 - 3000 - 5000 - 25000);
    expect(s.oneOffLines.map((l) => l.name)).toEqual(["Phone"]);
    expect(s.spendLines.map((l) => l.name)).not.toContain("Phone");
  });
  it("classifies the purchase as its own kind, so History's filter lists exactly these entries", () => {
    expect(classifyTransaction(txs[3], cats, brackets)).toBe("oneoff");
    expect(classifyTransaction(txs[1], cats, brackets)).toBe("spent");
  });
  it("changes nothing when there are no one-off purchases", () => {
    const without = buildMonthSnapshot("2026-11", txs.slice(0, 3), cats, brackets);
    expect(without.oneOff).toBe(0);
    expect(without.left).toBe(52000);
  });
});

describe("one_off bracket — budget cap", () => {
  it("never changes the monthly spent, budgeted or remaining figures", () => {
    const input = { brackets, categories: cats, history: [], today: "2026-11-20" };
    const base = buildMonthReport("2026-11", { ...input, transactions: txs.slice(0, 3) });
    const withPhone = buildMonthReport("2026-11", { ...input, transactions: txs });
    expect(withPhone.spent).toBe(base.spent);
    expect(withPhone.budgeted).toBe(base.budgeted);
    expect(withPhone.remaining).toBe(base.remaining);
    expect(withPhone.unbudgetedSpent).toBe(base.unbudgetedSpent);
    expect(withPhone.allocations.map((a) => a.name)).not.toContain("Phone");
  });
});

describe("one_off bracket — analytics export", () => {
  const input: AnalyticsInput = {
    transactions: txs, categories: cats, brackets, splitShares: [], budgetHistory: [],
    currency: "₹", today: "2026-11-20", now: Date.UTC(2026, 10, 20, 8, 0, 0),
  };
  const table = (name: string) => {
    const f = buildAnalyticsFiles(input).find((x) => x.name === TABLES[name].file)!;
    return Papa.parse<Record<string, string>>(f.content.replace(/^\uFEFF/, ""), { header: true, skipEmptyLines: true }).data;
  };
  it("tags the purchase Flow = OneOff so run-rate analysis (Flow = Spend) never sees it", () => {
    const rows = table("fact_transactions");
    expect(rows.find((r) => Number(r.Amount) === 25000)!.Flow).toBe("OneOff");
    expect(rows.find((r) => Number(r.Amount) === 3000)!.Flow).toBe("Spend");
    const cat = table("dim_category").find((r) => r.Category === "Phone")!;
    expect(cat.Kind).toBe("one_off");
    expect(cat.Flow).toBe("OneOff");
  });
  it("adds a OneOff column at the end of the monthly summary, outside Spent", () => {
    const fields = TABLES.fact_month_summary.columns.map((c) => c[0]);
    expect(fields[fields.length - 1]).toBe("OneOff");
    const nov = table("fact_month_summary").find((r) => r.YearMonth === "2026-11")!;
    expect(Number(nov.Spent)).toBe(3000);
    expect(Number(nov.OneOff)).toBe(25000);
    expect(Number(nov.LeftOver)).toBe(27000);
  });
});

describe("one_off bracket — backup and restore", () => {
  beforeEach(async () => {
    await db.transactions.clear();
    await db.categories.clear();
    await db.brackets.clear();
    await db.recurring.clear();
    await db.settings.clear();
  });
  it("keeps the bracket's kind through a full backup round-trip (not collapsed to spend)", async () => {
    const bid = await db.brackets.add({ name: "Big Purchases", icon: "🛍️", color: "#444444", kind: "one_off" });
    await db.categories.add({ name: "Bike", icon: "🏍️", color: "#00aaaa", budget: 0, bracketId: bid });
    const backup = await exportFullBackup();
    await db.categories.clear();
    await db.brackets.clear();
    await importFullBackup(backup);
    const restored = (await db.brackets.toArray()).find((b) => b.name === "Big Purchases");
    expect(restored?.kind).toBe("one_off");
  });
});
