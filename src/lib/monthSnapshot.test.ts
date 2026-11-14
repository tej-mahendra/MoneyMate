import { describe, it, expect } from "vitest";
import { buildMonthSnapshot } from "./monthSnapshot";
import type { Bracket, Category, Transaction } from "../db/db";

const brackets: Bracket[] = [
  { id: 1, name: "Expenditure", icon: "💳", color: "#111", kind: "spend" },
  { id: 2, name: "Savings", icon: "💰", color: "#222", kind: "allocation" },
  { id: 3, name: "Income", icon: "💼", color: "#333", kind: "income" },
];
const cats: Category[] = [
  { id: 10, name: "Food", icon: "🍲", color: "#a", budget: 0, bracketId: 1 },
  { id: 20, name: "Emergency fund", icon: "🛟", color: "#b", budget: 0, bracketId: 2 },
  { id: 30, name: "Salary", icon: "💼", color: "#c", budget: 0, bracketId: 3 },
];
const tx = (id: number, type: "expense" | "income", categoryId: number, amount: number, date: string): Transaction => ({
  id, type, categoryId, amount, date, createdAt: id,
});

describe("buildMonthSnapshot", () => {
  const txs = [
    tx(1, "income", 30, 50000, "2026-11-01"),
    tx(2, "expense", 10, 12000, "2026-11-05"),
    tx(3, "expense", 20, 8000, "2026-11-06"),
    tx(4, "expense", 99, 500, "2026-11-07"), // deleted category
    tx(5, "expense", 10, 999, "2026-10-30"), // other month
  ];
  it("splits income, spend and savings, and computes what is left", () => {
    const s = buildMonthSnapshot("2026-11", txs, cats, brackets);
    expect(s.income).toBe(50000);
    expect(s.spent).toBe(12500); // uncategorized counts as spend
    expect(s.saved).toBe(8000);
    expect(s.left).toBe(29500);
    expect(s.savingsRate).toBe(16);
    expect(s.txCount).toBe(4);
  });
  it("never counts savings transfers as spend", () => {
    const s = buildMonthSnapshot("2026-11", txs, cats, brackets);
    expect(s.spendLines.map((l) => l.name)).not.toContain("Emergency fund");
    expect(s.savedLines.map((l) => l.name)).toEqual(["Emergency fund"]);
  });
  it("has a 0 savings rate and no NaN when there is no income", () => {
    const s = buildMonthSnapshot("2026-10", txs, cats, brackets);
    expect(s.income).toBe(0);
    expect(s.savingsRate).toBe(0);
    expect(s.left).toBe(-999);
  });
});
