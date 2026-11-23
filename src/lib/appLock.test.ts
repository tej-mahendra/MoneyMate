import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_LOCK,
  LOCK_STORAGE_KEY,
  loadLockConfig,
  sanitizeLockConfig,
  saveLockConfig,
  shouldRelock,
} from "./appLock";

beforeEach(() => localStorage.clear());

describe("sanitizeLockConfig", () => {
  it("defaults to lock OFF for anything that isn't a valid config", () => {
    for (const bad of [null, undefined, "x", 5, [], true]) {
      expect(sanitizeLockConfig(bad)).toEqual(DEFAULT_LOCK);
    }
  });
  it("only an exact `true` turns the lock on (no truthy strings)", () => {
    expect(sanitizeLockConfig({ enabled: "true" }).enabled).toBe(false);
    expect(sanitizeLockConfig({ enabled: 1 }).enabled).toBe(false);
    expect(sanitizeLockConfig({ enabled: true }).enabled).toBe(true);
  });
  it("rejects timeouts that aren't one of the offered choices", () => {
    expect(sanitizeLockConfig({ timeoutSec: 999999 }).timeoutSec).toBe(DEFAULT_LOCK.timeoutSec);
    expect(sanitizeLockConfig({ timeoutSec: -5 }).timeoutSec).toBe(DEFAULT_LOCK.timeoutSec);
    expect(sanitizeLockConfig({ timeoutSec: "60" }).timeoutSec).toBe(DEFAULT_LOCK.timeoutSec);
    expect(sanitizeLockConfig({ timeoutSec: 0 }).timeoutSec).toBe(0);
    expect(sanitizeLockConfig({ timeoutSec: 300 }).timeoutSec).toBe(300);
  });
  it("drops an empty or non-string credential id", () => {
    expect(sanitizeLockConfig({ credentialId: "" }).credentialId).toBeUndefined();
    expect(sanitizeLockConfig({ credentialId: 7 }).credentialId).toBeUndefined();
    expect(sanitizeLockConfig({ credentialId: "abc" }).credentialId).toBe("abc");
  });
});

describe("load / save", () => {
  it("round-trips", () => {
    const cfg = { enabled: true, timeoutSec: 300, privacyScreen: true, credentialId: "id1" };
    saveLockConfig(cfg);
    expect(loadLockConfig()).toEqual(cfg);
  });
  it("survives corrupt storage by falling back to the defaults", () => {
    localStorage.setItem(LOCK_STORAGE_KEY, "{not json");
    expect(loadLockConfig()).toEqual(DEFAULT_LOCK);
  });
  it("does not throw when storage is blocked", () => {
    const blocked = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    } as unknown as Storage;
    expect(loadLockConfig(blocked)).toEqual(DEFAULT_LOCK);
    expect(() => saveLockConfig(DEFAULT_LOCK, blocked)).not.toThrow();
  });
});

describe("shouldRelock", () => {
  const on = (timeoutSec: number) => ({ enabled: true, timeoutSec });
  it("never locks when the lock is off", () => {
    expect(shouldRelock({ enabled: false, timeoutSec: 0 }, 0, 10_000_000)).toBe(false);
  });
  it("does nothing if the app never left the foreground", () => {
    expect(shouldRelock(on(0), null, 1000)).toBe(false);
  });
  it("'Immediately' locks on every return", () => {
    expect(shouldRelock(on(0), 5000, 5000)).toBe(true);
    expect(shouldRelock(on(0), 5000, 5001)).toBe(true);
  });
  it("waits out the grace period, then locks exactly at it", () => {
    expect(shouldRelock(on(60), 0, 59_999)).toBe(false);
    expect(shouldRelock(on(60), 0, 60_000)).toBe(true);
    expect(shouldRelock(on(300), 0, 299_000)).toBe(false);
  });
  it("a clock moved backwards cannot extend the grace period", () => {
    expect(shouldRelock(on(300), 1_000_000, 500_000)).toBe(true);
  });
});
