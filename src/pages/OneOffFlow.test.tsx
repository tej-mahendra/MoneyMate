import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import AddTransaction from "./AddTransaction";
import BracketDetail from "./BracketDetail";
import History from "./History";
import Toast from "../components/Toast";
import { db } from "../db/db";
import { ensureOneOffCategory } from "../lib/oneOff";
import { todayISO } from "../lib/format";

async function seed() {
  const spendId = (await db.brackets.add({ name: "Expenditure", icon: "💳", color: "#111111", kind: "spend" })) as number;
  const bigId = (await db.brackets.add({ name: "Big Purchases", icon: "🛍️", color: "#444444", kind: "one_off" })) as number;
  await db.categories.add({ name: "Food", icon: "🍲", color: "#aa0000", budget: 5000, bracketId: spendId });
  return { spendId, bigId };
}

beforeEach(async () => {
  await db.transactions.clear();
  await db.categories.clear();
  await db.brackets.clear();
  await db.settings.clear();
  await db.splitShares.clear();
});

function renderAdd(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AddTransaction />
      <Toast />
    </MemoryRouter>,
  );
}

describe("ensureOneOffCategory", () => {
  it("creates one hidden 'Purchases' category per bracket and reuses it", async () => {
    const { bigId } = await seed();
    const a = await ensureOneOffCategory(bigId);
    const b = await ensureOneOffCategory(bigId);
    expect(a).toBe(b);
    const cats = (await db.categories.toArray()).filter((c) => c.bracketId === bigId);
    expect(cats.map((c) => c.name)).toEqual(["Purchases"]);
  });
  it("brings the category back if it was archived", async () => {
    const { bigId } = await seed();
    const id = await ensureOneOffCategory(bigId);
    await db.categories.update(id, { archived: true });
    await ensureOneOffCategory(bigId);
    expect((await db.categories.get(id))?.archived).toBe(false);
  });
});

describe("AddTransaction — one-off purchase is added directly, by name", () => {
  it("has no category step; saves the item name and lands it in the bracket's Purchases category", async () => {
    const { bigId } = await seed();
    const user = userEvent.setup();
    renderAdd(`/add?kind=oneoff&bracket=${bigId}`);

    await user.type(await screen.findByLabelText("What did you buy?"), "iPhone 16");
    expect(screen.queryByLabelText("Category")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Amount"), "80000");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(async () => expect(await db.transactions.count()).toBe(1));
    const tx = (await db.transactions.toArray())[0];
    const cat = await db.categories.get(tx.categoryId);
    expect(tx.merchant).toBe("iPhone 16");
    expect(tx.amount).toBe(80000);
    expect(tx.type).toBe("expense");
    expect(cat?.name).toBe("Purchases");
    expect(cat?.bracketId).toBe(bigId);
  });

  it("a second purchase reuses the same hidden category", async () => {
    const { bigId } = await seed();
    const user = userEvent.setup();
    for (const [name, amt] of [["Bike", "120000"], ["Laptop", "90000"]]) {
      const { unmount } = renderAdd(`/add?kind=oneoff&bracket=${bigId}`);
      await user.type(await screen.findByLabelText("What did you buy?"), name);
      await user.type(screen.getByLabelText("Amount"), amt);
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(async () => expect((await db.transactions.toArray()).some((t) => t.merchant === name)).toBe(true));
      unmount();
    }
    const cats = (await db.categories.toArray()).filter((c) => c.bracketId === bigId);
    expect(cats).toHaveLength(1);
  });

  it("won't save without a name", async () => {
    const { bigId } = await seed();
    const user = userEvent.setup();
    renderAdd(`/add?kind=oneoff&bracket=${bigId}`);
    await user.type(await screen.findByLabelText("Amount"), "5000");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Enter what you bought.")).toBeInTheDocument();
    expect(await db.transactions.count()).toBe(0);
  });

  it("asks which bracket only when there is more than one", async () => {
    const { bigId } = await seed();
    renderAdd(`/add?kind=oneoff&bracket=${bigId}`);
    await screen.findByLabelText("What did you buy?");
    expect(screen.queryByLabelText("Bracket")).not.toBeInTheDocument();

    await db.brackets.add({ name: "Gadgets", icon: "📱", color: "#555555", kind: "one_off" });
    expect(await screen.findByLabelText("Bracket")).toBeInTheDocument();
  });
});

describe("AddTransaction — editing a one-off purchase", () => {
  it("opens on the One-off tab with the item name, and saves the new name in place", async () => {
    const { bigId } = await seed();
    const cat = await ensureOneOffCategory(bigId);
    const id = (await db.transactions.add({ type: "expense", amount: 80000, categoryId: cat, date: todayISO(), merchant: "iPhone 16", createdAt: 1 })) as number;
    const user = userEvent.setup();
    renderAdd(`/add?edit=${id}`);

    const name = await screen.findByLabelText("What did you buy?");
    await waitFor(() => expect(name).toHaveValue("iPhone 16"));
    await user.clear(name);
    await user.type(name, "iPhone 16 Pro");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(async () => expect((await db.transactions.get(id))?.merchant).toBe("iPhone 16 Pro"));
    expect((await db.transactions.get(id))?.categoryId).toBe(cat);
    expect(await db.categories.count()).toBe(2); // Food + Purchases, nothing new
  });
});

describe("one-off bracket page and History show purchases by name", () => {
  it("lists purchases instead of categories, newest first, with an Add button", async () => {
    const { bigId } = await seed();
    const cat = await ensureOneOffCategory(bigId);
    await db.transactions.add({ type: "expense", amount: 80000, categoryId: cat, date: todayISO(), merchant: "iPhone 16", createdAt: 2 });
    await db.transactions.add({ type: "expense", amount: 1000, categoryId: cat, date: "2020-01-05", merchant: "Old speaker", createdAt: 1 });

    render(
      <MemoryRouter initialEntries={[`/bracket/${bigId}`]}>
        <Routes>
          <Route path="/bracket/:id" element={<BracketDetail currency="₹" monthlyIncome={0} />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("iPhone 16")).toBeInTheDocument();
    expect(screen.getByText("Old speaker")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Purchases" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Categories" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Add" })).toBeInTheDocument();
    const names = screen.getAllByText(/iPhone 16|Old speaker/).map((n) => n.textContent);
    expect(names).toEqual(["iPhone 16", "Old speaker"]);
  });

  it("shows an empty state with the one-off explanation", async () => {
    const { bigId } = await seed();
    render(
      <MemoryRouter initialEntries={[`/bracket/${bigId}`]}>
        <Routes>
          <Route path="/bracket/:id" element={<BracketDetail currency="₹" monthlyIncome={0} />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/never count toward your monthly spend/i)).toBeInTheDocument();
  });

  it("History shows the item's own name, not 'Purchases · name'", async () => {
    const { bigId } = await seed();
    const cat = await ensureOneOffCategory(bigId);
    await db.transactions.add({ type: "expense", amount: 80000, categoryId: cat, date: todayISO(), merchant: "iPhone 16", createdAt: 1 });
    render(
      <MemoryRouter initialEntries={["/history"]}>
        <History currency="₹" />
      </MemoryRouter>,
    );
    expect(await screen.findByText("iPhone 16")).toBeInTheDocument();
    expect(screen.queryByText(/Purchases · iPhone 16/)).not.toBeInTheDocument();
  });
});
