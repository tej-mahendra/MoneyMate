import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BalanceCard from "./BalanceCard";
import Toast from "./Toast";
import { db } from "../db/db";
import { todayISO } from "../lib/format";

async function seed(anchor = true) {
  await db.transactions.clear();
  await db.settings.clear();
  await db.splitShares.clear();
  await db.settings.put({
    id: 1, onboarded: true, currency: "₹", theme: "dark", monthlyIncome: 0, carryForward: false,
    ...(anchor ? { balanceAnchorAmount: 40000, balanceAnchorDate: "2020-01-01", balanceAnchorAt: 1 } : {}),
  });
  await db.transactions.add({ type: "income", amount: 60000, categoryId: 1, date: todayISO(), createdAt: 1 });
  await db.transactions.add({ type: "expense", amount: 15000, categoryId: 1, date: todayISO(), createdAt: 2 });
}

function renderCard() {
  return render(
    <>
      <BalanceCard currency="₹" monthlyIncome={0} />
      <Toast />
    </>,
  );
}

beforeEach(() => seed());
afterEach(() => vi.useRealTimers());

describe("BalanceCard", () => {
  it("shows no figures until asked", async () => {
    renderCard();
    await screen.findByText("This month left");
    expect(screen.queryByText(/45,000/)).not.toBeInTheDocument();
    expect(screen.getAllByLabelText("hidden")).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/\d{2},\d{3}/);
  });

  it("reveals this month's and the total balance, and hides them again on request", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Show balance" }));
    expect(await screen.findByText("₹45,000")).toBeInTheDocument(); // 60,000 − 15,000 this month
    expect(screen.getByText(/₹[\d,]*85,000/)).toBeInTheDocument(); // 40,000 + 45,000 since the anchor
    await user.click(screen.getByRole("button", { name: "Hide balance" }));
    expect(screen.queryByText("₹45,000")).not.toBeInTheDocument();
  });

  it("hides itself after a few seconds", async () => {
    renderCard();
    const show = await screen.findByRole("button", { name: "Show balance" });
    await screen.findByText("This month left");
    vi.useFakeTimers();
    fireEvent.click(show);
    expect(screen.getByText("₹45,000")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(12500);
    });
    expect(screen.queryByText("₹45,000")).not.toBeInTheDocument();
  });

  it("hides the moment the app goes to the background", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Show balance" }));
    await screen.findByText("₹45,000");
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.queryByText("₹45,000")).not.toBeInTheDocument();
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });

  it("asks for the balance once, then keeps the total up to date from it", async () => {
    await seed(false);
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Show balance" }));
    expect(await screen.findByText("not set")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Set my balance" }));
    await user.type(screen.getByLabelText("Balance in your account right now"), "90000");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(async () => expect((await db.settings.get(1))?.balanceAnchorAmount).toBe(90000));
    expect((await db.settings.get(1))?.balanceAnchorDate).toBe(todayISO());
    expect(await screen.findByText("Balance saved.")).toBeInTheDocument();
  });
});
