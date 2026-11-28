import { describe, it, expect } from "vitest";
import { computeBalance } from "./balance";
import type { SplitShare, Transaction } from "../db/db";

const tx = (id: number, type: "income" | "expense", amount: number, date: string, createdAt = id): Transaction => ({
  id, type, amount, date, categoryId: 1, createdAt,
});
const base = { splitShares: [] as SplitShare[], monthlyIncome: 0, today: "2026-11-20" };

describe("computeBalance — this month left", () => {
  it("is fixed monthly income + logged income − everything paid out so far", () => {
    const r = computeBalance({
      ...base,
      monthlyIncome: 50000,
      transactions: [
        tx(1, "income", 5000, "2026-11-02"),
        tx(2, "expense", 12000, "2026-11-03"), // spending
        tx(3, "expense", 8000, "2026-11-04"), // savings/investment (also an expense row)
        tx(4, "expense", 25000, "2026-11-10"), // one-off purchase
        tx(5, "expense", 999, "2026-10-30"), // another month — ignored
      ],
    });
    expect(r.monthLeft).toBe(50000 + 5000 - 12000 - 8000 - 25000);
  });

  it("ignores future-dated entries until their day arrives", () => {
    const r = computeBalance({
      ...base,
      monthlyIncome: 1000,
      transactions: [tx(1, "expense", 400, "2026-11-25"), tx(2, "income", 900, "2026-11-30")],
    });
    expect(r.monthLeft).toBe(1000);
  });

  it("counts what friends still owe on a split bill as money out", () => {
    const shares: SplitShare[] = [
      { id: 1, transactionId: 1, personName: "A", amountOwed: 600, amountSettled: 100, createdAt: 1 },
      { id: 2, transactionId: 1, personName: "B", amountOwed: 600, amountSettled: 600, createdAt: 1 },
    ];
    const r = computeBalance({
      ...base,
      monthlyIncome: 5000,
      splitShares: shares,
      transactions: [tx(1, "expense", 300, "2026-11-05")], // your share only
    });
    expect(r.monthLeft).toBe(5000 - 300 - 500);
  });

  it("can go negative", () => {
    expect(computeBalance({ ...base, transactions: [tx(1, "expense", 700, "2026-11-02")] }).monthLeft).toBe(-700);
  });
});

describe("computeBalance — total left", () => {
  it("is null until the balance has been confirmed once", () => {
    expect(computeBalance({ ...base, transactions: [] }).totalLeft).toBeNull();
  });

  it("is the confirmed balance plus everything logged after it", () => {
    const r = computeBalance({
      ...base,
      anchorAmount: 40000,
      anchorDate: "2026-11-10",
      anchorAt: 1000,
      transactions: [
        tx(1, "expense", 9999, "2026-11-05"), // before the anchor — already in the 40,000
        tx(2, "expense", 2000, "2026-11-12"),
        tx(3, "income", 500, "2026-11-15"),
        tx(4, "expense", 700, "2026-11-28"), // future — ignored
      ],
    });
    expect(r.totalLeft).toBe(40000 - 2000 + 500);
  });

  it("counts an entry logged later on the same day as the confirmation, not one logged before it", () => {
    const r = computeBalance({
      ...base,
      anchorAmount: 10000,
      anchorDate: "2026-11-20",
      anchorAt: 5000,
      transactions: [tx(1, "expense", 300, "2026-11-20", 4000), tx(2, "expense", 200, "2026-11-20", 6000)],
    });
    expect(r.totalLeft).toBe(10000 - 200);
  });

  it("adds fixed monthly income once for each month that began after the anchor", () => {
    const r = computeBalance({
      ...base,
      monthlyIncome: 30000,
      anchorAmount: 5000,
      anchorDate: "2026-09-15",
      anchorAt: 1,
      transactions: [],
      today: "2026-11-20",
    });
    expect(r.totalLeft).toBe(5000 + 30000 * 2); // October and November
  });

  it("adds no fixed income in the month the balance was confirmed", () => {
    const r = computeBalance({ ...base, monthlyIncome: 30000, anchorAmount: 5000, anchorDate: "2026-11-02", anchorAt: 1, transactions: [] });
    expect(r.totalLeft).toBe(5000);
  });
});
