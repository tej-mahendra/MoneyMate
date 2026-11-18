import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import Settings from "./Settings";
import { db, type Settings as SettingsType } from "../db/db";

import { useUIStore } from "../store/useUIStore";
import { clearWidget } from "../lib/widgetSync";

// Only clearWidget is under test here; the real one talks to the native
// widget bridge.
vi.mock("../lib/widgetSync", () => ({
  clearWidget: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  await db.transactions.clear();
  await db.recurring.clear();
  await db.categories.clear();
  await db.brackets.clear();
  await db.settings.clear();
  useUIStore.setState({ toastMsg: null });
});

const baseSettings: SettingsType = {
  id: 1,
  onboarded: true,
  currency: "₹",
  theme: "dark",
  monthlyIncome: 0,
  carryForward: false,
  hideWidgetAmounts: false,
};

import Toast from "../components/Toast";

function renderSettings() {
  return render(
    <MemoryRouter>
      <Settings settings={baseSettings} onSettingsChange={() => {}} />
    </MemoryRouter>,
  );
}

// Toast renders at the App shell level in the real app, not inside
// Settings itself — tests that need to see toast text (not just infer it
// from a resulting DB change) need it mounted alongside Settings here.
function renderSettingsWithToast() {
  return render(
    <MemoryRouter>
      <Settings settings={baseSettings} onSettingsChange={() => {}} />
      <Toast />
    </MemoryRouter>,
  );
}

describe("Settings — Brackets list (no per-category flow toggle)", () => {
  it('shows an empty state and an "Add bracket" affordance when no brackets exist yet', async () => {
    renderSettings();
    expect(
      await screen.findByText(/None yet\. Add one below\./i),
    ).toBeInTheDocument();
    expect(screen.getByText("Add bracket")).toBeInTheDocument();
  });

  it('creating a bracket with kind "Allocation" persists the correct kind, with no per-category toggle involved', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByText("Add bracket"));
    await user.type(
      screen.getByPlaceholderText("Bracket name (e.g. EMI)"),
      "EMI",
    );
    await user.click(screen.getByRole("button", { name: "Allocation" }));
    await user.click(screen.getByText("Create bracket"));

    const saved = await db.brackets.toArray();
    const emi = saved.find((b) => b.name === "EMI");
    expect(emi?.kind).toBe("allocation");
  });

  it('creating a bracket defaults to kind "spend" (Budget cap) if left unchanged', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByText("Add bracket"));
    await user.type(
      screen.getByPlaceholderText("Bracket name (e.g. EMI)"),
      "Groceries Fund",
    );
    await user.click(screen.getByText("Create bracket"));

    const saved = await db.brackets.toArray();
    expect(saved.find((b) => b.name === "Groceries Fund")?.kind).toBe("spend");
  });

  it("an existing bracket renders as a row with its kind and category count, and no editable category fields inline — editing happens on its own page", async () => {
    const expenditureId = await db.brackets.add({
      name: "Expenditure",
      icon: "💳",
      color: "#7C93F0",
      kind: "spend",
    });
    await db.categories.add({
      name: "Rent",
      icon: "🏠",
      color: "#F0B94D",
      budget: 20000,
      bracketId: expenditureId,
    });
    await db.brackets.add({
      name: "Savings",
      icon: "💰",
      color: "#4FD9B8",
      kind: "allocation",
    });

    renderSettings();

    expect(await screen.findByText("Expenditure")).toBeInTheDocument();
    expect(screen.getByText(/Budget cap · 1 category/)).toBeInTheDocument();
    expect(screen.getByText("Savings")).toBeInTheDocument();
    expect(screen.getByText(/Allocation · 0 categories/)).toBeInTheDocument();
    // No inline category-editing inputs on this page anymore.
    expect(screen.queryByPlaceholderText("Category")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("Rent")).not.toBeInTheDocument();
  });

  it("shows a validation toast rather than creating an unnamed bracket", async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByText("Add bracket"));
    await user.click(screen.getByText("Create bracket"));

    expect(await db.brackets.count()).toBe(0);
  });
});

describe("Settings — restore accepts encrypted backups only", () => {
  it("explains a plain (unencrypted) backup instead of restoring it, and asks nothing first", async () => {
    const bracketId = await db.brackets.add({ name: "Expenditure", icon: "💳", color: "#7C93F0", kind: "spend" });
    await db.categories.add({ name: "Rent", icon: "🏠", color: "#F0B94D", budget: 20000, bracketId });
    const { exportFullBackup } = await import("../lib/csv");
    const plain = await exportFullBackup();

    const user = userEvent.setup();
    renderSettingsWithToast();
    const confirm = vi.fn(async () => true);
    const originalShowConfirm = useUIStore.getState().showConfirm;
    useUIStore.setState({ showConfirm: confirm });
    try {
      await user.upload(
        screen.getByLabelText("Restore from backup") as HTMLInputElement,
        new File([plain], "old.json", { type: "application/json" }),
      );
    } finally {
      useUIStore.setState({ showConfirm: originalShowConfirm });
    }

    expect(await screen.findByText(/isn't encrypted/)).toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Passphrase")).not.toBeInTheDocument();
    expect(await db.categories.count()).toBe(1); // untouched
  });

  it("shows an error toast when the chosen file isn't a backup at all", async () => {
    const user = userEvent.setup();
    renderSettingsWithToast();
    await user.upload(
      screen.getByLabelText("Restore from backup") as HTMLInputElement,
      new File(["not a backup at all"], "notes.json", { type: "application/json" }),
    );
    expect(await screen.findByText("That file doesn't look like a valid backup.")).toBeInTheDocument();
  });

  it('does nothing if the person cancels the "this replaces everything" confirmation', async () => {
    const bracketId = await db.brackets.add({ name: "Expenditure", icon: "💳", color: "#7C93F0", kind: "spend" });
    await db.categories.add({ name: "Rent", icon: "🏠", color: "#F0B94D", budget: 20000, bracketId });
    const { exportFullBackup } = await import("../lib/csv");
    const { encryptBackup } = await import("../lib/backupCrypto");
    const encrypted = await encryptBackup(await exportFullBackup(), "correct horse", { iterations: 100_000 });

    const user = userEvent.setup();
    renderSettings();
    const originalShowConfirm = useUIStore.getState().showConfirm;
    useUIStore.setState({ showConfirm: async () => false }); // person taps Cancel
    try {
      await user.upload(
        screen.getByLabelText("Restore from backup") as HTMLInputElement,
        new File([encrypted], "backup.encrypted.json", { type: "application/json" }),
      );
    } finally {
      useUIStore.setState({ showConfirm: originalShowConfirm });
    }

    expect(screen.queryByLabelText("Passphrase")).not.toBeInTheDocument();
    expect(screen.queryByText("Backup restored.")).not.toBeInTheDocument();
    expect(await db.categories.count()).toBe(1); // untouched
  });
});

describe("Settings — Erase all data", () => {
  it("wipes everything, including split-expense records and the budget history", async () => {
    const bracketId = await db.brackets.add({ name: "Expenditure", icon: "💳", color: "#7C93F0", kind: "spend" });
    const catId = await db.categories.add({ name: "Dinner", icon: "🍽", color: "#F0B94D", budget: 1000, bracketId });
    const txId = await db.transactions.add({ type: "expense", amount: 500, categoryId: catId, date: "2026-10-01", createdAt: 0 });
    await db.splitShares.add({ transactionId: txId, personName: "Rahul", amountOwed: 250, amountSettled: 0, createdAt: 0 });
    await db.budgetHistory.add({ categoryId: catId, month: "2026-10", budget: 1000, origin: "migrated", createdAt: 0 });

    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    const originalShowConfirm = useUIStore.getState().showConfirm;
    useUIStore.setState({ showConfirm: async () => true });
    try {
      const user = userEvent.setup();
      renderSettings();
      await user.click(await screen.findByText("Erase all data"));
      await vi.waitFor(() => expect(reload).toHaveBeenCalled());
    } finally {
      useUIStore.setState({ showConfirm: originalShowConfirm });
      vi.unstubAllGlobals();
    }

    expect(await db.transactions.count()).toBe(0);
    expect(await db.categories.count()).toBe(0);
    expect(await db.brackets.count()).toBe(0);
    expect(await db.splitShares.count()).toBe(0);
    expect(await db.budgetHistory.count()).toBe(0);
  });
});

describe("Settings — Erase all data: widget and failure handling", () => {
  it("blanks the home-screen widget as part of erasing", async () => {
    vi.mocked(clearWidget).mockClear();
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    const originalShowConfirm = useUIStore.getState().showConfirm;
    useUIStore.setState({ showConfirm: async () => true });
    try {
      const user = userEvent.setup();
      renderSettings();
      await user.click(await screen.findByText("Erase all data"));
      await vi.waitFor(() => expect(reload).toHaveBeenCalled());
    } finally {
      useUIStore.setState({ showConfirm: originalShowConfirm });
      vi.unstubAllGlobals();
    }
    expect(clearWidget).toHaveBeenCalledTimes(1);
  });

  it("does not reload or blank the widget when the erase itself fails, and says so", async () => {
    vi.mocked(clearWidget).mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    const txSpy = vi
      .spyOn(db, "transaction")
      .mockRejectedValueOnce(new Error("IDB failure"));
    const originalShowConfirm = useUIStore.getState().showConfirm;
    useUIStore.setState({ showConfirm: async () => true });
    try {
      const user = userEvent.setup();
      renderSettings();
      await user.click(await screen.findByText("Erase all data"));
      await vi.waitFor(() =>
        expect(useUIStore.getState().toastMsg).toMatch(/couldn't erase/i),
      );
    } finally {
      txSpy.mockRestore();
      useUIStore.setState({ showConfirm: originalShowConfirm });
      vi.unstubAllGlobals();
    }
    expect(reload).not.toHaveBeenCalled();
    expect(clearWidget).not.toHaveBeenCalled();
  });
});

describe("Settings — backup tracking", () => {
  it('shows "Never" until a backup is exported', async () => {
    renderSettings();
    expect(await screen.findByText("Never")).toBeInTheDocument();
  });

  it("records the time of a successful (encrypted) export and tells the app", async () => {
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();
    const onSettingsChange = vi.fn();
    const before = Date.now();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Settings settings={baseSettings} onSettingsChange={onSettingsChange} />
      </MemoryRouter>,
    );

    await user.click(await screen.findByText("Export encrypted backup"));
    await user.type(screen.getByLabelText("Passphrase"), "correct horse");
    await user.type(screen.getByLabelText("Repeat passphrase"), "correct horse");
    await user.click(screen.getByRole("button", { name: "Encrypt & export" }));

    await vi.waitFor(async () => {
      const saved = await db.settings.get(1);
      expect(saved?.lastBackupAt).toBeGreaterThanOrEqual(before);
    });
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ lastBackupAt: expect.any(Number) }),
    );
  }, 20000);

  it("no longer offers a plain, unencrypted backup export", async () => {
    renderSettings();
    await screen.findByText("Export encrypted backup");
    expect(screen.queryByText("Export backup (.json)")).not.toBeInTheDocument();
  });

  it("shows how long ago the last backup was", async () => {
    render(
      <MemoryRouter>
        <Settings
          settings={{ ...baseSettings, lastBackupAt: Date.now() - 5 * 86400000 }}
          onSettingsChange={() => {}}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText("5 days ago")).toBeInTheDocument();
  });
});

describe("Settings — encrypted backups", () => {
  async function seedData() {
    const bracketId = await db.brackets.add({ name: "Expenditure", icon: "💳", color: "#7C93F0", kind: "spend" });
    const catId = await db.categories.add({ name: "Rent", icon: "🏠", color: "#F0B94D", budget: 20000, bracketId });
    await db.transactions.add({ type: "expense", amount: 5000, categoryId: catId, date: "2026-01-15", createdAt: Date.now(), note: "January rent" });
  }
  // jsdom's Blob isn't readable by Node's Response, so use FileReader.
  function blobText(b: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsText(b);
    });
  }
  // Runs the real UI: button → dialog → passphrase → file handed to the
  // download path. Returns the text of the file that would be saved.
  async function exportEncrypted(user: ReturnType<typeof userEvent.setup>, pass: string) {
    let captured: Blob | null = null;
    URL.createObjectURL = vi.fn((b: Blob) => {
      captured = b;
      return "blob:test";
    });
    URL.revokeObjectURL = vi.fn();
    await user.click(await screen.findByText("Export encrypted backup"));
    await user.type(screen.getByLabelText("Passphrase"), pass);
    await user.type(screen.getByLabelText("Repeat passphrase"), pass);
    await user.click(screen.getByRole("button", { name: "Encrypt & export" }));
    await vi.waitFor(() => expect(captured).not.toBeNull());
    return blobText(captured as unknown as Blob);
  }

  it("exports a file that is encrypted (no readable data) and records the backup time", async () => {
    await seedData();
    const user = userEvent.setup();
    const onSettingsChange = vi.fn();
    const before = Date.now();
    render(
      <MemoryRouter>
        <Settings settings={baseSettings} onSettingsChange={onSettingsChange} />
      </MemoryRouter>,
    );
    const text = await exportEncrypted(user, "correct horse");
    expect(text).toContain("moneymate-encrypted-backup");
    expect(text).not.toContain("Rent");
    expect(text).not.toContain("January rent");
    await vi.waitFor(async () => {
      expect((await db.settings.get(1))?.lastBackupAt).toBeGreaterThanOrEqual(before);
    });
  }, 20000);

  it("won't export until the passphrase is long enough and typed the same twice", async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(await screen.findByText("Export encrypted backup"));
    const go = screen.getByRole("button", { name: "Encrypt & export" });
    expect(go).toBeDisabled();
    await user.type(screen.getByLabelText("Passphrase"), "short");
    expect(await screen.findByRole("alert")).toHaveTextContent(/at least 8/);
    expect(go).toBeDisabled();
    await user.clear(screen.getByLabelText("Passphrase"));
    await user.type(screen.getByLabelText("Passphrase"), "correct horse");
    await user.type(screen.getByLabelText("Repeat passphrase"), "correct hors");
    expect(await screen.findByRole("alert")).toHaveTextContent(/don't match/);
    expect(go).toBeDisabled();
    await user.type(screen.getByLabelText("Repeat passphrase"), "e");
    expect(go).toBeEnabled();
  });

  it("restores an encrypted backup with the right passphrase; a wrong one changes nothing", async () => {
    await seedData();
    const user = userEvent.setup();
    const first = render(
      <MemoryRouter>
        <Settings settings={baseSettings} onSettingsChange={() => {}} />
      </MemoryRouter>,
    );
    const text = await exportEncrypted(user, "correct horse");
    first.unmount();

    // New phone: everything gone.
    await db.transactions.clear();
    await db.categories.clear();
    await db.brackets.clear();

    renderSettingsWithToast();
    const file = new File([text], "moneymate-backup.encrypted.json", { type: "application/json" });
    const originalShowConfirm = useUIStore.getState().showConfirm;
    useUIStore.setState({ showConfirm: async () => true });
    try {
      await user.upload(screen.getByLabelText("Restore from backup") as HTMLInputElement, file);
    } finally {
      useUIStore.setState({ showConfirm: originalShowConfirm });
    }

    await user.type(await screen.findByLabelText("Passphrase"), "wrong horse!");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Wrong passphrase/);
    expect(await db.transactions.count()).toBe(0); // nothing restored

    await user.clear(screen.getByLabelText("Passphrase"));
    await user.type(screen.getByLabelText("Passphrase"), "correct horse");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await screen.findByText("Backup restored.");
    const tx = await db.transactions.toArray();
    expect(tx).toHaveLength(1);
    expect(tx[0].note).toBe("January rent");
    expect((await db.categories.toArray())[0].name).toBe("Rent");
  }, 30000);

  it('"Check a backup file" reports what is inside without changing this device', async () => {
    await seedData();
    const user = userEvent.setup();
    const first = render(
      <MemoryRouter>
        <Settings settings={baseSettings} onSettingsChange={() => {}} />
      </MemoryRouter>,
    );
    const text = await exportEncrypted(user, "correct horse");
    first.unmount();
    await db.transactions.clear();

    renderSettingsWithToast();
    const file = new File([text], "b.encrypted.json", { type: "application/json" });
    await user.upload(screen.getByLabelText("Check a backup file") as HTMLInputElement, file);
    await user.type(await screen.findByLabelText("Passphrase"), "correct horse");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByText(/Backup is readable: 1 transactions, 1 categories/)).toBeInTheDocument();
    expect(await db.transactions.count()).toBe(0); // check never restores
  }, 30000);

  it("tells you when the file to check isn't a backup", async () => {
    const user = userEvent.setup();
    renderSettingsWithToast();
    const file = new File(["hello"], "x.json", { type: "application/json" });
    await user.upload(screen.getByLabelText("Check a backup file") as HTMLInputElement, file);
    expect(await screen.findByText(/doesn't look like a valid backup/)).toBeInTheDocument();
  });
});
