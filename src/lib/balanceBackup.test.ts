import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../db/db";
import { exportFullBackup, importFullBackup } from "./csv";

describe("money-in-hand anchor survives backup and restore", () => {
  beforeEach(async () => {
    await db.transactions.clear();
    await db.categories.clear();
    await db.brackets.clear();
    await db.recurring.clear();
    await db.settings.clear();
  });

  it("restores the confirmed balance, its day and time", async () => {
    await db.settings.put({
      id: 1, onboarded: true, currency: "₹", theme: "dark", monthlyIncome: 0, carryForward: false,
      balanceAnchorAmount: 91234.5, balanceAnchorDate: "2026-11-24", balanceAnchorAt: 1795000000000,
    });
    const backup = await exportFullBackup();
    await db.settings.clear();
    await importFullBackup(backup);
    const s = await db.settings.get(1);
    expect(s?.balanceAnchorAmount).toBe(91234.5);
    expect(s?.balanceAnchorDate).toBe("2026-11-24");
    expect(s?.balanceAnchorAt).toBe(1795000000000);
  });

  it("drops a half-written anchor instead of inventing a total", async () => {
    await db.settings.put({
      id: 1, onboarded: true, currency: "₹", theme: "dark", monthlyIncome: 0, carryForward: false,
      balanceAnchorAmount: 500,
    });
    const backup = await exportFullBackup();
    await db.settings.clear();
    await importFullBackup(backup);
    expect((await db.settings.get(1))?.balanceAnchorAmount).toBeUndefined();
  });
});
