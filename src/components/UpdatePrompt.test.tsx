import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const applyPwaUpdate = vi.fn();
const fetchBuildInfo = vi.fn();
vi.mock("../lib/pwaUpdate", async (orig) => ({
  ...(await orig<typeof import("../lib/pwaUpdate")>()),
  applyPwaUpdate: () => applyPwaUpdate(),
  fetchBuildInfo: () => fetchBuildInfo(),
}));
const saveEncryptedBackup = vi.fn();
vi.mock("../lib/encryptedBackup", () => ({ saveEncryptedBackup: (p: string) => saveEncryptedBackup(p) }));

import UpdatePrompt from "./UpdatePrompt";
import { usePwaUpdateStore } from "../store/usePwaUpdateStore";
import { useUIStore } from "../store/useUIStore";
import { db, type Settings } from "../db/db";

const DAY = 86_400_000;
const settings = (lastBackupAt?: number): Settings =>
  ({ id: 1, onboarded: true, currency: "₹", theme: "dark", monthlyIncome: 0, carryForward: false, lastBackupAt }) as Settings;
const recent = () => Date.now() - 2 * DAY;

function show(s: Settings = settings(recent()), onChange = vi.fn()) {
  act(() => usePwaUpdateStore.getState().setReady());
  render(<UpdatePrompt settings={s} onSettingsChange={onChange} />);
  return onChange;
}
async function fillPassphrase(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Passphrase"), "correct horse");
  await user.type(screen.getByLabelText("Repeat passphrase"), "correct horse");
  await user.click(screen.getByRole("button", { name: "Encrypt & export" }));
}

beforeEach(() => {
  usePwaUpdateStore.setState({ ready: false, dismissed: false });
  useUIStore.setState({ toastMsg: null });
  applyPwaUpdate.mockReset().mockResolvedValue(undefined);
  fetchBuildInfo.mockReset().mockResolvedValue({ schemaVersion: db.verno, builtAt: "" });
  saveEncryptedBackup.mockReset().mockResolvedValue(settings(Date.now()));
});

describe("UpdatePrompt — ordinary update", () => {
  it("shows nothing until a new version is waiting", () => {
    render(<UpdatePrompt settings={settings(recent())} onSettingsChange={vi.fn()} />);
    expect(screen.queryByRole("region", { name: "Update available" })).not.toBeInTheDocument();
  });

  it("offers Update now, reassures that data stays, and updates on tap", async () => {
    show();
    expect(await screen.findByText("Update available")).toBeInTheDocument();
    expect(screen.getByText(/keeps all your data/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Update now" }));
    expect(applyPwaUpdate).toHaveBeenCalledTimes(1);
  });

  it("suggests a backup when there has never been one, or the last is old", async () => {
    show(settings(undefined));
    expect(await screen.findByText(/haven't made a backup yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back up first" })).toBeInTheDocument();
  });
  it("says how old the last backup is when it is stale", async () => {
    show(settings(Date.now() - 30 * DAY));
    expect(await screen.findByText(/last backup was 30 days ago/)).toBeInTheDocument();
  });
  it("stays quiet about backups when one was made recently", async () => {
    show(settings(recent()));
    await screen.findByText("Update available");
    expect(screen.queryByText(/backup/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back up first" })).not.toBeInTheDocument();
  });

  it("'Later' hides it for now, and a newer update brings it back", async () => {
    show();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Later" }));
    expect(screen.queryByText("Update available")).not.toBeInTheDocument();
    expect(applyPwaUpdate).not.toHaveBeenCalled();
    act(() => usePwaUpdateStore.getState().setReady());
    expect(await screen.findByText("Update available")).toBeInTheDocument();
  });

  it("'Back up first' makes the encrypted backup and only then updates", async () => {
    const onChange = show(settings(undefined));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Back up first" }));
    await fillPassphrase(user);
    await waitFor(() => expect(applyPwaUpdate).toHaveBeenCalledTimes(1));
    expect(saveEncryptedBackup).toHaveBeenCalledWith("correct horse");
    expect(onChange).toHaveBeenCalled();
    expect(saveEncryptedBackup.mock.invocationCallOrder[0]).toBeLessThan(applyPwaUpdate.mock.invocationCallOrder[0]);
  });
});

describe("UpdatePrompt — update that changes how data is stored", () => {
  beforeEach(() => fetchBuildInfo.mockResolvedValue({ schemaVersion: db.verno + 1, builtAt: "" }));

  it("warns, and makes 'Back up, then update' the main choice", async () => {
    show();
    expect(await screen.findByText("Update changes how data is stored")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back up, then update" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update now" })).not.toBeInTheDocument();
    expect(applyPwaUpdate).not.toHaveBeenCalled();
  });

  it("backs up first, and updates only AFTER the backup succeeded", async () => {
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Back up, then update" }));
    await fillPassphrase(user);
    await waitFor(() => expect(applyPwaUpdate).toHaveBeenCalledTimes(1));
    expect(saveEncryptedBackup.mock.invocationCallOrder[0]).toBeLessThan(applyPwaUpdate.mock.invocationCallOrder[0]);
  });

  it("does NOT update if the backup fails, and says so", async () => {
    saveEncryptedBackup.mockRejectedValue(new Error("share cancelled"));
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Back up, then update" }));
    await fillPassphrase(user);
    await waitFor(() => expect(useUIStore.getState().toastMsg).toMatch(/update was not applied/));
    expect(applyPwaUpdate).not.toHaveBeenCalled();
  });

  it("cancelling the passphrase dialog changes nothing", async () => {
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Back up, then update" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(saveEncryptedBackup).not.toHaveBeenCalled();
    expect(applyPwaUpdate).not.toHaveBeenCalled();
    expect(screen.getByText("Update changes how data is stored")).toBeInTheDocument();
  });

  it("still lets the person update without a backup, on purpose", async () => {
    show();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Update without backup" }));
    expect(applyPwaUpdate).toHaveBeenCalledTimes(1);
    expect(saveEncryptedBackup).not.toHaveBeenCalled();
  });
});

describe("UpdatePrompt — when the build info can't be read", () => {
  it("treats it as an ordinary update instead of blocking or alarming", async () => {
    fetchBuildInfo.mockResolvedValue(null);
    show();
    expect(await screen.findByText("Update available")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Update now" }));
    expect(applyPwaUpdate).toHaveBeenCalled();
  });
});
