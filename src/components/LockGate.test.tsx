import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Capacitor } from "@capacitor/core";

const fake = {
  kind: "webauthn" as "webauthn" | "native",
  check: vi.fn(),
  enroll: vi.fn(),
  authenticate: vi.fn(),
  authenticateWithPin: undefined as undefined | ReturnType<typeof vi.fn>,
};
vi.mock("../lib/deviceAuth", () => ({ getDeviceAuth: () => fake }));

let appStateCb: ((s: { isActive: boolean }) => void) | null = null;
vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(async (_: string, cb: (s: { isActive: boolean }) => void) => {
      appStateCb = cb;
      return { remove: vi.fn() };
    }),
  },
}));
vi.mock("@capacitor-community/privacy-screen", () => ({
  PrivacyScreen: { enable: vi.fn(async () => {}), disable: vi.fn(async () => {}) },
}));
import { PrivacyScreen } from "@capacitor-community/privacy-screen";
import LockGate from "./LockGate";
import { useLockStore } from "../store/useLockStore";

function setLock(patch: Partial<ReturnType<typeof useLockStore.getState>["config"]> = {}, locked = true) {
  useLockStore.setState({
    config: { enabled: true, timeoutSec: 60, privacyScreen: false, credentialId: "cred1", ...patch },
    locked,
    hiddenAt: null,
    quietUntil: 0,
  });
}
function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}
const App = () => <input data-testid="draft" aria-label="draft" />;

beforeEach(() => {
  localStorage.clear();
  fake.kind = "webauthn";
  fake.authenticateWithPin = undefined;
  fake.authenticate.mockReset().mockResolvedValue({ ok: true });
  fake.enroll.mockReset();
  appStateCb = null;
  setHidden(false);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("LockGate — covering the app", () => {
  it("shows the lock screen and hides the app while locked", async () => {
    fake.authenticate.mockResolvedValue({ ok: false, reason: "cancelled" });
    setLock();
    render(<LockGate><App /></LockGate>);
    expect(await screen.findByText("Money Mate is locked")).toBeInTheDocument();
    const draft = screen.getByTestId("draft");
    expect(draft.closest("[inert]")).not.toBeNull(); // unreachable by keyboard / screen reader
    expect(draft).not.toBeVisible();
  });

  it("shows no lock screen when the lock is off", () => {
    setLock({ enabled: false }, false);
    render(<LockGate><App /></LockGate>);
    expect(screen.queryByText("Money Mate is locked")).not.toBeInTheDocument();
    expect(screen.getByTestId("draft")).toBeVisible();
    expect(fake.authenticate).not.toHaveBeenCalled();
  });

  it("asks for the device lock as soon as it appears, with the saved credential", async () => {
    setLock();
    render(<LockGate><App /></LockGate>);
    await waitFor(() => expect(fake.authenticate).toHaveBeenCalledTimes(1));
    expect(fake.authenticate).toHaveBeenCalledWith({ credentialId: "cred1" });
  });

  it("unlocks on success and the app is back", async () => {
    setLock();
    render(<LockGate><App /></LockGate>);
    await waitFor(() => expect(screen.queryByText("Money Mate is locked")).not.toBeInTheDocument());
    expect(screen.getByTestId("draft")).toBeVisible();
  });

  it("keeps a half-typed entry across a lock and unlock (the app stays mounted)", async () => {
    setLock({}, false);
    render(<LockGate><App /></LockGate>);
    const user = userEvent.setup();
    await user.type(screen.getByTestId("draft"), "450 swiggy");
    fake.authenticate.mockResolvedValue({ ok: false, reason: "cancelled" });
    act(() => useLockStore.getState().lock());
    expect(await screen.findByText("Money Mate is locked")).toBeInTheDocument();
    fake.authenticate.mockResolvedValue({ ok: true });
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(screen.queryByText("Money Mate is locked")).not.toBeInTheDocument());
    expect(screen.getByTestId("draft")).toHaveValue("450 swiggy");
  });
});

describe("LockGate — failures", () => {
  it("stays locked and explains a failure; a dismissed prompt is not an error message", async () => {
    setLock();
    fake.authenticate.mockResolvedValueOnce({ ok: false, reason: "failed" });
    render(<LockGate><App /></LockGate>);
    expect(await screen.findByRole("alert")).toHaveTextContent(/didn't work/i);
    expect(useLockStore.getState().locked).toBe(true);

    fake.authenticate.mockResolvedValueOnce({ ok: false, reason: "cancelled" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(useLockStore.getState().locked).toBe(true);
  });

  it("an exception from the device prompt never unlocks", async () => {
    setLock();
    fake.authenticate.mockRejectedValue(new Error("boom"));
    render(<LockGate><App /></LockGate>);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(useLockStore.getState().locked).toBe(true);
  });

  it("can try again after a failure", async () => {
    setLock();
    fake.authenticate.mockResolvedValueOnce({ ok: false, reason: "failed" });
    render(<LockGate><App /></LockGate>);
    await screen.findByRole("alert");
    await userEvent.setup().click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(useLockStore.getState().locked).toBe(false));
  });

  it("Android: offers 'Use device PIN' so a failing fingerprint never locks you out", async () => {
    fake.kind = "native";
    fake.authenticateWithPin = vi.fn().mockResolvedValue({ ok: true });
    fake.authenticate.mockResolvedValue({ ok: false, reason: "lockedOut" });
    setLock();
    render(<LockGate><App /></LockGate>);
    await screen.findByRole("alert");
    await userEvent.setup().click(screen.getByRole("button", { name: "Use device PIN" }));
    await waitFor(() => expect(useLockStore.getState().locked).toBe(false));
    expect(fake.authenticateWithPin).toHaveBeenCalled();
  });

  it("web: after two failures offers to set the lock up again, which re-proves the device lock", async () => {
    fake.authenticate.mockResolvedValue({ ok: false, reason: "failed" });
    fake.enroll.mockResolvedValue({ ok: true, credentialId: "fresh" });
    setLock();
    render(<LockGate><App /></LockGate>);
    const user = userEvent.setup();
    await screen.findByRole("alert");
    expect(screen.queryByText(/Set up the lock again/)).not.toBeInTheDocument(); // 1 failure
    await user.click(screen.getByRole("button", { name: "Unlock" })); // 2nd failure
    await user.click(await screen.findByRole("button", { name: /Set up the lock again/ }));
    await waitFor(() => expect(useLockStore.getState().locked).toBe(false));
    expect(useLockStore.getState().config.credentialId).toBe("fresh");
  });

  it("web: setting the lock up again does NOT unlock if the device lock isn't passed", async () => {
    fake.authenticate.mockResolvedValue({ ok: false, reason: "failed" });
    fake.enroll.mockResolvedValue({ ok: false, reason: "cancelled" });
    setLock();
    render(<LockGate><App /></LockGate>);
    const user = userEvent.setup();
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await user.click(await screen.findByRole("button", { name: /Set up the lock again/ }));
    await waitFor(() => expect(fake.enroll).toHaveBeenCalled());
    expect(useLockStore.getState().locked).toBe(true);
    expect(useLockStore.getState().config.credentialId).toBe("cred1");
  });
});

describe("LockGate — locking again after time away", () => {
  it("locks on return after the chosen time, but not after a quick trip (web visibility)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-19T10:00:00Z"));
    setLock({ timeoutSec: 60 }, false);
    render(<LockGate><App /></LockGate>);

    act(() => setHidden(true));
    vi.setSystemTime(new Date("2026-11-19T10:00:20Z"));
    act(() => setHidden(false));
    expect(useLockStore.getState().locked).toBe(false);

    act(() => setHidden(true));
    vi.setSystemTime(new Date("2026-11-19T10:02:00Z")); // 100 s away
    fake.authenticate.mockResolvedValue({ ok: false, reason: "cancelled" });
    act(() => setHidden(false));
    expect(useLockStore.getState().locked).toBe(true);
  });

  it("Android: uses the app's own foreground/background signal", async () => {
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-19T10:00:00Z"));
    setLock({ timeoutSec: 0 }, false);
    render(<LockGate><App /></LockGate>);
    await waitFor(() => expect(appStateCb).not.toBeNull());

    fake.authenticate.mockResolvedValue({ ok: false, reason: "cancelled" });
    act(() => appStateCb!({ isActive: false }));
    vi.setSystemTime(new Date("2026-11-19T10:00:05Z"));
    act(() => appStateCb!({ isActive: true }));
    expect(useLockStore.getState().locked).toBe(true);
  });
});

describe("LockGate — privacy screen", () => {
  it("web: covers the page the moment it is hidden, and uncovers it on return", () => {
    setLock({ enabled: false, privacyScreen: true }, false);
    render(<LockGate><App /></LockGate>);
    expect(document.getElementById("mm-privacy-cover")).not.toBeNull();
    act(() => setHidden(true));
    expect(document.documentElement.hasAttribute("data-privacy-cover")).toBe(true);
    act(() => setHidden(false));
    expect(document.documentElement.hasAttribute("data-privacy-cover")).toBe(false);
  });

  it("web: does nothing when the privacy screen is off", () => {
    setLock({ enabled: false, privacyScreen: false }, false);
    render(<LockGate><App /></LockGate>);
    act(() => setHidden(true));
    expect(document.documentElement.hasAttribute("data-privacy-cover")).toBe(false);
  });

  it("Android: switches the system privacy screen on and off with the setting", async () => {
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
    setLock({ enabled: false, privacyScreen: true }, false);
    render(<LockGate><App /></LockGate>);
    await waitFor(() => expect(PrivacyScreen.enable).toHaveBeenCalled());
    act(() => useLockStore.getState().setConfig({ privacyScreen: false }));
    await waitFor(() => expect(PrivacyScreen.disable).toHaveBeenCalled());
  });
});
