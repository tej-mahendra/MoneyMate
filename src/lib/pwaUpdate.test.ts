import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const registerSW = vi.fn();
vi.mock("virtual:pwa-register", () => ({ registerSW: (o: unknown) => registerSW(o) }));
const isNative = vi.fn(() => false);
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => isNative() } }));

async function load() {
  vi.resetModules();
  return import("./pwaUpdate");
}

describe("small helpers", () => {
  it("dataFormatChanges is true only when the new build's database version is higher", async () => {
    const { dataFormatChanges } = await load();
    const info = (v: number) => ({ schemaVersion: v, builtAt: "" });
    expect(dataFormatChanges(6, info(7))).toBe(true);
    expect(dataFormatChanges(6, info(6))).toBe(false);
    expect(dataFormatChanges(6, info(5))).toBe(false);
    expect(dataFormatChanges(6, null)).toBe(false);
  });
  it("backupAgeDays counts whole days and is null when there was never a backup", async () => {
    const { backupAgeDays } = await load();
    const now = Date.UTC(2026, 10, 20);
    expect(backupAgeDays(undefined, now)).toBeNull();
    expect(backupAgeDays(0, now)).toBeNull();
    expect(backupAgeDays(now - 3 * 86_400_000 - 1000, now)).toBe(3);
    expect(backupAgeDays(now + 5000, now)).toBe(0); // clock skew never goes negative
  });
});

describe("fetchBuildInfo", () => {
  const fetchMock = vi.fn();
  beforeEach(() => vi.stubGlobal("fetch", fetchMock));
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("reads the version file, bypassing caches", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ schemaVersion: 7, builtAt: "x" }) });
    const { fetchBuildInfo } = await load();
    expect(await fetchBuildInfo()).toEqual({ schemaVersion: 7, builtAt: "x" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("version.json");
    expect(String(url)).toContain("t=");
    expect(init).toEqual({ cache: "no-store" });
  });
  it("returns null — never throws — for a missing file, bad content, or no network", async () => {
    const { fetchBuildInfo } = await load();
    fetchMock.mockResolvedValueOnce({ ok: false });
    expect(await fetchBuildInfo()).toBeNull();
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ schemaVersion: "7" }) });
    expect(await fetchBuildInfo()).toBeNull();
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => null });
    expect(await fetchBuildInfo()).toBeNull();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await fetchBuildInfo()).toBeNull();
  });
});

describe("startPwaUpdates", () => {
  const unregister = vi.fn();
  const del = vi.fn();
  beforeEach(() => {
    registerSW.mockReset();
    isNative.mockReturnValue(false);
    unregister.mockReset();
    del.mockReset();
    vi.stubEnv("PROD", true);
    vi.stubGlobal("navigator", {
      ...navigator,
      serviceWorker: { getRegistrations: async () => [{ unregister }] },
    });
    vi.stubGlobal("caches", { keys: async () => ["a", "b"], delete: del });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("registers the service worker and reports when an update is waiting", async () => {
    const { startPwaUpdates } = await load();
    const onNeed = vi.fn();
    startPwaUpdates(onNeed);
    await vi.waitFor(() => expect(registerSW).toHaveBeenCalled());
    registerSW.mock.calls[0][0].onNeedRefresh();
    expect(onNeed).toHaveBeenCalledTimes(1);
  });

  it("does nothing in development", async () => {
    vi.stubEnv("PROD", false);
    const { startPwaUpdates } = await load();
    startPwaUpdates(() => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(registerSW).not.toHaveBeenCalled();
  });

  it("does nothing in browsers without service workers", async () => {
    vi.stubGlobal("navigator", { ...navigator, serviceWorker: undefined });
    const { startPwaUpdates } = await load();
    startPwaUpdates(() => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(registerSW).not.toHaveBeenCalled();
  });

  it("in the Android app: registers nothing and removes any old service worker and caches", async () => {
    isNative.mockReturnValue(true);
    const { startPwaUpdates } = await load();
    startPwaUpdates(() => {});
    await vi.waitFor(() => expect(unregister).toHaveBeenCalled());
    await vi.waitFor(() => expect(del).toHaveBeenCalledTimes(2));
    expect(registerSW).not.toHaveBeenCalled();
  });

  it("looks for updates hourly and whenever the app comes back to the foreground", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { startPwaUpdates } = await load();
    startPwaUpdates(() => {});
    await vi.waitFor(() => expect(registerSW).toHaveBeenCalled());
    const update = vi.fn().mockResolvedValue(undefined);
    registerSW.mock.calls[0][0].onRegisteredSW("sw.js", { update });
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(update).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("applyPwaUpdate switches to the waiting version and reloads", async () => {
    const { startPwaUpdates, applyPwaUpdate } = await load();
    const updateSW = vi.fn().mockResolvedValue(undefined);
    registerSW.mockReturnValue(updateSW);
    startPwaUpdates(() => {});
    await vi.waitFor(() => expect(registerSW).toHaveBeenCalled());
    await applyPwaUpdate();
    expect(updateSW).toHaveBeenCalledWith(true);
  });
});
