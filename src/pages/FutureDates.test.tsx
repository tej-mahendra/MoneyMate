import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import AddTransaction from "./AddTransaction";
import Toast from "../components/Toast";
import { db } from "../db/db";
import { addMonths, monthKey, todayISO } from "../lib/format";

beforeEach(async () => {
  await db.transactions.clear();
  await db.categories.clear();
  await db.brackets.clear();
  await db.settings.clear();
  const b = (await db.brackets.add({ name: "Expenditure", icon: "💳", color: "#111111", kind: "spend" })) as number;
  await db.categories.add({ name: "Food", icon: "🍲", color: "#aa0000", budget: 5000, bracketId: b });
});

const renderAdd = (path = "/add") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AddTransaction />
      <Toast />
    </MemoryRouter>,
  );

describe("AddTransaction — no future dates", () => {
  it("caps the calendar at today", async () => {
    renderAdd();
    expect(await screen.findByLabelText("Date")).toHaveAttribute("max", todayISO());
  });

  it("refuses a typed future date and says what to use instead", async () => {
    const user = userEvent.setup();
    renderAdd();
    await user.type(await screen.findByLabelText("Amount"), "500");
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: `${addMonths(monthKey(todayISO()), 2)}-15` } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Future dates aren't allowed/)).toBeInTheDocument();
    expect(await db.transactions.count()).toBe(0);
  });

  it("still saves today's date", async () => {
    const user = userEvent.setup();
    renderAdd();
    await user.type(await screen.findByLabelText("Amount"), "500");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByLabelText("Amount").catch(() => null);
    expect(await db.transactions.count()).toBe(1);
  });
});
