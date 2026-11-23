import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const fake = {
  kind: "webauthn" as "webauthn" | "native",
  check: vi.fn(),
  enroll: vi.fn(),
  authenticate: vi.fn(),
};
vi.mock("../lib/deviceAuth", () => ({ getDeviceAuth: () => fake }));

import SecuritySettings from "./SecuritySettings";
import { useLockStore } from "../store/useLockStore";
import { useUIStore } from "../store/useUIStore";
import { LOCK_STORAGE_KEY } from "../lib/appLock";

function setLock(patch = {}) {
  useLockStore.setState({
    config: { enabled: false, timeoutSec: 60, privacyScreen: false, ...patch },
    locked: false,
    hiddenAt: null,
    quietUntil: 0,
  });
}
const toast = () => useUIStore.getState().toastMsg;

beforeEach(() => {
  localStorage.clear();
  fake.kind = "webauthn";
  fake.check.mockReset().mockResolvedValue({ available: true });
  fake.enroll.mockReset().mockResolvedValue({ ok: true, credentialId: "cred-new" });
  fake.authenticate.mockReset().mockResolvedValue({ ok: true });
  useUIStore.setState({ toastMsg: null });
  setLock();
});

describe("SecuritySettings — turning the lock on", () => {
  it("verifies the person, saves the lock on THIS device, and turns the privacy screen on too", async () => {
    render(<SecuritySettings />);
    await userEvent.setup().click(screen.getByLabelText("Require unlock to open Money Mate"));
    await waitFor(() => expect(useLockStore.getState().config.enabled).toBe(true));
    const c = useLockStore.getState().config;
    expect(c.credentialId).toBe("cred-new");
    expect(c.privacyScreen).toBe(true);
    expect(useLockStore.getState().locked).toBe(false); // doesn't lock you out of the screen you're on
    expect(JSON.parse(localStorage.getItem(LOCK_STORAGE_KEY)!).enabled).toBe(true);
    expect(toast()).toBe("App lock is on.");
  });

  it("explains when the device has no screen lock, and changes nothing", async () => {
    fake.check.mockResolvedValue({ available: false, reason: "noScreenLock" });
    render(<SecuritySettings />);
    await userEvent.setup().click(screen.getByLabelText("Require unlock to open Money Mate"));
    await waitFor(() => expect(toast()).toMatch(/Set a screen lock/));
    expect(useLockStore.getState().config.enabled).toBe(false);
    expect(fake.enroll).not.toHaveBeenCalled();
  });

  it("does not turn the lock on if the person can't pass the device lock", async () => {
    fake.enroll.mockResolvedValue({ ok: false, reason: "cancelled" });
    render(<SecuritySettings />);
    await userEvent.setup().click(screen.getByLabelText("Require unlock to open Money Mate"));
    await waitFor(() => expect(toast()).toMatch(/not changed/i));
    expect(useLockStore.getState().config.enabled).toBe(false);
    expect(localStorage.getItem(LOCK_STORAGE_KEY)).toBeNull();
  });
});

describe("SecuritySettings — turning the lock off", () => {
  beforeEach(() => setLock({ enabled: true, credentialId: "cred1" }));

  it("asks the person to unlock first, then turns it off and forgets the credential", async () => {
    render(<SecuritySettings />);
    await userEvent.setup().click(screen.getByLabelText("Require unlock to open Money Mate"));
    await waitFor(() => expect(useLockStore.getState().config.enabled).toBe(false));
    expect(fake.authenticate).toHaveBeenCalledWith({ credentialId: "cred1" });
    expect(useLockStore.getState().config.credentialId).toBeUndefined();
    expect(toast()).toBe("App lock is off.");
  });

  it("a borrowed unlocked phone can't switch it off: failing the check leaves it on", async () => {
    fake.authenticate.mockResolvedValue({ ok: false, reason: "failed" });
    render(<SecuritySettings />);
    await userEvent.setup().click(screen.getByLabelText("Require unlock to open Money Mate"));
    await waitFor(() => expect(toast()).toMatch(/stays on/));
    expect(useLockStore.getState().config.enabled).toBe(true);
  });

  it("cancelling the check also leaves it on", async () => {
    fake.authenticate.mockResolvedValue({ ok: false, reason: "cancelled" });
    render(<SecuritySettings />);
    await userEvent.setup().click(screen.getByLabelText("Require unlock to open Money Mate"));
    await waitFor(() => expect(fake.authenticate).toHaveBeenCalled());
    expect(useLockStore.getState().config.enabled).toBe(true);
  });
});

describe("SecuritySettings — options", () => {
  it("shows the re-lock choices only while the lock is on, and saves the choice", async () => {
    const { rerender } = render(<SecuritySettings />);
    expect(screen.queryByText("After 5 minutes")).not.toBeInTheDocument();
    setLock({ enabled: true });
    rerender(<SecuritySettings />);
    expect(screen.getByRole("button", { name: "After 1 minute" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.setup().click(screen.getByRole("button", { name: "After 5 minutes" }));
    expect(useLockStore.getState().config.timeoutSec).toBe(300);
    expect(JSON.parse(localStorage.getItem(LOCK_STORAGE_KEY)!).timeoutSec).toBe(300);
  });

  it("the privacy screen is its own switch and works with the lock off", async () => {
    render(<SecuritySettings />);
    await userEvent.setup().click(screen.getByLabelText(/Hide the app when I switch away/));
    expect(useLockStore.getState().config.privacyScreen).toBe(true);
  });

  it("describes the Android behaviour in the Android app and the web limits in the browser", () => {
    const web = render(<SecuritySettings />);
    expect(screen.getByText(/not encrypted/)).toBeInTheDocument();
    web.unmount();
    fake.kind = "native";
    render(<SecuritySettings />);
    expect(screen.getByText(/never sees or stores them/)).toBeInTheDocument();
    expect(screen.getByLabelText(/block screenshots/)).toBeInTheDocument();
  });

  it("says plainly that these settings stay on the device and are not in backups", () => {
    render(<SecuritySettings />);
    expect(screen.getByText(/not part of backups/)).toBeInTheDocument();
  });
});
