import { describe, it, expect, beforeEach, vi } from "vitest";
import { LOCK_STORAGE_KEY } from "../lib/appLock";

async function freshStore() {
  vi.resetModules();
  return (await import("./useLockStore")).useLockStore;
}
const cfg = (over = {}) => ({ enabled: true, timeoutSec: 60, privacyScreen: false, ...over });

beforeEach(() => localStorage.clear());

describe("cold start", () => {
  it("starts LOCKED when the lock is on (the very first paint is the lock screen)", async () => {
    localStorage.setItem(LOCK_STORAGE_KEY, JSON.stringify(cfg()));
    const s = await freshStore();
    expect(s.getState().locked).toBe(true);
  });
  it("starts unlocked when the lock is off or nothing is saved", async () => {
    expect((await freshStore()).getState().locked).toBe(false);
    localStorage.setItem(LOCK_STORAGE_KEY, JSON.stringify(cfg({ enabled: false })));
    expect((await freshStore()).getState().locked).toBe(false);
  });
  it("a corrupt saved value cannot lock the person out", async () => {
    localStorage.setItem(LOCK_STORAGE_KEY, "garbage");
    expect((await freshStore()).getState().locked).toBe(false);
  });
});

describe("re-locking after time in the background", () => {
  async function unlocked(timeoutSec: number) {
    localStorage.setItem(LOCK_STORAGE_KEY, JSON.stringify(cfg({ timeoutSec })));
    const s = await freshStore();
    s.getState().unlock();
    return s;
  }
  it("locks when the app was away at least the chosen time", async () => {
    const s = await unlocked(60);
    s.getState().noteHidden(1_000);
    s.getState().noteVisible(1_000 + 61_000);
    expect(s.getState().locked).toBe(true);
  });
  it("stays unlocked for a quick trip away", async () => {
    const s = await unlocked(60);
    s.getState().noteHidden(1_000);
    s.getState().noteVisible(1_000 + 20_000);
    expect(s.getState().locked).toBe(false);
  });
  it("'Immediately' locks even on a split-second trip", async () => {
    const s = await unlocked(0);
    s.getState().noteHidden(1_000);
    s.getState().noteVisible(1_001);
    expect(s.getState().locked).toBe(true);
  });
  it("measures from the FIRST hide signal when several arrive for one departure", async () => {
    const s = await unlocked(60);
    s.getState().noteHidden(1_000);
    s.getState().noteHidden(50_000); // e.g. a second event later — must not reset the clock
    s.getState().noteVisible(62_000);
    expect(s.getState().locked).toBe(true);
  });
  it("coming back without ever leaving does nothing", async () => {
    const s = await unlocked(0);
    s.getState().noteVisible(5_000);
    expect(s.getState().locked).toBe(false);
  });
  it("never locks when the lock is off", async () => {
    const s = await freshStore();
    s.getState().noteHidden(0);
    s.getState().noteVisible(10_000_000);
    expect(s.getState().locked).toBe(false);
  });
});

describe("the system unlock prompt can't re-lock the app", () => {
  it("ignores hide/show signals while a prompt is open and briefly after", async () => {
    localStorage.setItem(LOCK_STORAGE_KEY, JSON.stringify(cfg({ timeoutSec: 0 })));
    const s = await freshStore();
    s.getState().beginPrompt();
    s.getState().noteHidden(1_000);
    s.getState().unlock();
    s.getState().endPrompt(2_000); // quiet until 3_500
    s.getState().noteVisible(2_100);
    expect(s.getState().locked).toBe(false);
    // …but a real departure afterwards is honoured
    s.getState().noteHidden(10_000);
    s.getState().noteVisible(10_001);
    expect(s.getState().locked).toBe(true);
  });
});

describe("settings", () => {
  it("setConfig persists to this device's storage", async () => {
    const s = await freshStore();
    s.getState().setConfig({ enabled: true, timeoutSec: 300, credentialId: "abc" });
    expect(JSON.parse(localStorage.getItem(LOCK_STORAGE_KEY)!)).toEqual(
      expect.objectContaining({ enabled: true, timeoutSec: 300, credentialId: "abc" }),
    );
  });
  it("turning the lock on does not lock the person who just turned it on", async () => {
    const s = await freshStore();
    s.getState().setConfig({ enabled: true });
    expect(s.getState().locked).toBe(false);
  });
  it("turning the lock off also removes the lock screen", async () => {
    localStorage.setItem(LOCK_STORAGE_KEY, JSON.stringify(cfg()));
    const s = await freshStore();
    expect(s.getState().locked).toBe(true);
    s.getState().setConfig({ enabled: false });
    expect(s.getState().locked).toBe(false);
  });
});
