import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from "react-router-dom";
import AddTransaction from "./AddTransaction";
import TransactionDetail from "./TransactionDetail";
import ConfirmDialog from "../components/ConfirmDialog";
import { db } from "../db/db";
import { todayISO } from "../lib/format";

// Back-button behaviour through the real screens, with a real history stack —
// the bug was invisible to tests that open a page directly.

beforeEach(async () => {
  await db.transactions.clear();
  await db.categories.clear();
  await db.brackets.clear();
  await db.settings.clear();
  await db.splitShares.clear();
});

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}
// Stands in for the phone's system Back button.
function SystemBack() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(-1)}>system-back</button>;
}
function renderApp(entries: string[], index: number) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={index}>
      <Routes>
        <Route path="/add" element={<AddTransaction />} />
        <Route path="/transaction/:id" element={<TransactionDetail currency="₹" />} />
        <Route path="*" element={<div>other page</div>} />
      </Routes>
      <Where />
      <SystemBack />
      <ConfirmDialog />
    </MemoryRouter>,
  );
}
const where = () => screen.getByTestId("where").textContent;

async function seed() {
  const bracketId = await db.brackets.add({ name: "Expenditure", icon: "💳", color: "#7C93F0", kind: "spend" });
  const catId = await db.categories.add({ name: "Food", icon: "🍔", color: "#F0B94D", budget: 0, bracketId });
  const id = await db.transactions.add({ type: "expense", amount: 100, categoryId: catId, date: todayISO(), createdAt: 1 });
  return { id: id as number, catId };
}

describe("Back button after editing a transaction", () => {
  it("saving an edit returns to the detail page, and Back from there skips the edit form", async () => {
    const { id } = await seed();
    const user = userEvent.setup();
    renderApp(["/history", `/transaction/${id}`], 1);

    await user.click((await screen.findAllByRole("button", { name: "Edit transaction" }))[0]);
    expect(where()).toBe(`/add?edit=${id}`);

    const amt = await screen.findByDisplayValue("100");
    await user.clear(amt);
    await user.type(amt, "250");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(where()).toBe(`/transaction/${id}`));
    expect((await db.transactions.get(id))!.amount).toBe(250);

    // The bug: this used to land back on /add?edit=…
    await user.click(screen.getByRole("button", { name: "system-back" }));
    expect(where()).toBe("/history");
  });

  it("a detail page opened straight from a link still saves to the detail page", async () => {
    const { id } = await seed();
    const user = userEvent.setup();
    renderApp([`/add?edit=${id}`], 0);
    const amt = await screen.findByDisplayValue("100");
    await user.clear(amt);
    await user.type(amt, "300");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(where()).toBe(`/transaction/${id}`));
  });
});

describe("Back after adding a transaction", () => {
  it("does not return to the finished Add form", async () => {
    await seed();
    const user = userEvent.setup();
    renderApp(["/", "/add"], 1);
    await user.type(await screen.findByPlaceholderText("0.00"), "40");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(where()).toBe("/budget"));

    await user.click(screen.getByRole("button", { name: "system-back" }));
    expect(where()).toBe("/");
  });
});

describe("Transaction detail Back arrow", () => {
  it("returns to the page it was opened from, not always History", async () => {
    const { id } = await seed();
    const user = userEvent.setup();
    renderApp(["/budget", `/transaction/${id}`], 1);
    await user.click(await screen.findByRole("button", { name: "Back" }));
    expect(where()).toBe("/budget");
  });

  it("falls back to History when opened directly (nothing to go back to)", async () => {
    const { id } = await seed();
    const user = userEvent.setup();
    renderApp([`/transaction/${id}`], 0);
    await user.click(await screen.findByRole("button", { name: "Back" }));
    expect(where()).toBe("/history");
  });

  it("after deleting, goes back to where you came from — not to the deleted entry", async () => {
    const { id } = await seed();
    const user = userEvent.setup();
    renderApp(["/history", `/transaction/${id}`], 1);
    await user.click(await screen.findByRole("button", { name: /Delete/ }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(where()).toBe("/history"));
    expect(await db.transactions.count()).toBe(0);
  });
});

describe("Date field", () => {
  it("opens the calendar when clicked anywhere on the field", async () => {
    await seed();
    const showPicker = vi.fn();
    (HTMLInputElement.prototype as unknown as { showPicker: () => void }).showPicker = showPicker;
    try {
      const user = userEvent.setup();
      renderApp(["/add"], 0);
      await user.click(await screen.findByLabelText("Date"));
      expect(showPicker).toHaveBeenCalledTimes(1);
    } finally {
      delete (HTMLInputElement.prototype as unknown as { showPicker?: () => void }).showPicker;
    }
  });

  it("does not break when the browser refuses showPicker()", async () => {
    await seed();
    (HTMLInputElement.prototype as unknown as { showPicker: () => void }).showPicker = () => {
      throw new DOMException("not allowed", "NotAllowedError");
    };
    try {
      const user = userEvent.setup();
      renderApp(["/add"], 0);
      await user.click(await screen.findByLabelText("Date"));
      expect(screen.getByLabelText("Date")).toBeInTheDocument();
    } finally {
      delete (HTMLInputElement.prototype as unknown as { showPicker?: () => void }).showPicker;
    }
  });
});
