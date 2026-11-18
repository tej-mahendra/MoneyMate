import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  installStaleVersionRecovery,
  isChunkLoadError,
  reloadForNewVersion,
  requestPersistentStorage,
} from "./staleVersion";

describe("isChunkLoadError", () => {
  it.each([
    "Failed to fetch dynamically imported module: https://x.app/assets/Analytics-abc123.js",
    "error loading dynamically imported module",
    "Importing a module script failed.",
    "Loading chunk 42 failed.",
    "Unable to preload CSS for /assets/History-1.css",
  ])("recognises: %s", (m) => {
    expect(isChunkLoadError(new Error(m))).toBe(true);
  });
  it("does not treat ordinary bugs as stale-version errors", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError(new Error("Opening storage took too long."))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});

describe("reloadForNewVersion", () => {
  const reload = vi.fn();
  beforeEach(() => {
    sessionStorage.clear();
    reload.mockClear();
    vi.stubGlobal("location", { ...window.location, reload });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reloads once, then refuses to loop within the cooldown", () => {
    expect(reloadForNewVersion(1_000_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadForNewVersion(1_010_000)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("is allowed again once the cooldown has passed", () => {
    expect(reloadForNewVersion(1_000_000)).toBe(true);
    expect(reloadForNewVersion(1_000_000 + 31_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
  it("does nothing if the browser won't let it remember the reload (avoids a loop)", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(reloadForNewVersion(5)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("installStaleVersionRecovery", () => {
  it("handles vite:preloadError by reloading and suppressing the error", () => {
    const reload = vi.fn();
    sessionStorage.clear();
    vi.stubGlobal("location", { ...window.location, reload });
    installStaleVersionRecovery();
    const ev = new Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(ev);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe("requestPersistentStorage", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("asks the browser for persistent storage", async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal("navigator", { ...navigator, storage: { persist, persisted: async () => false } });
    expect(await requestPersistentStorage()).toBe(true);
    expect(persist).toHaveBeenCalled();
  });
  it("doesn't ask again when already persistent", async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal("navigator", { ...navigator, storage: { persist, persisted: async () => true } });
    expect(await requestPersistentStorage()).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });
  it("is silent when the browser doesn't support it or it throws", async () => {
    vi.stubGlobal("navigator", { ...navigator, storage: undefined });
    expect(await requestPersistentStorage()).toBe(false);
    vi.stubGlobal("navigator", { ...navigator, storage: { persist: async () => { throw new Error("x"); } } });
    expect(await requestPersistentStorage()).toBe(false);
  });
});
