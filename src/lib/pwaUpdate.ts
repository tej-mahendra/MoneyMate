import { Capacitor } from "@capacitor/core";

// Updates for the web version (PWA).
//
// The service worker downloads a new version in the background and WAITS. The
// open page keeps getting its own (old) files from the old cache, so nothing
// breaks mid-use; the person is told, and chooses when to switch. (The earlier
// silent auto-update swapped the files under the open page, which is what
// produced "Failed to fetch dynamically imported module" error screens.)

/** Written by the build (see vite.config.ts) next to index.html. */
export interface BuildInfo {
  /** Highest database version this build knows how to open. */
  schemaVersion: number;
  builtAt: string;
}

let updateSW: ((reloadPage?: boolean) => Promise<void>) | null = null;
const HOUR = 60 * 60 * 1000;

/** Registers the service worker and calls `onNeedRefresh` when a new version
 *  is ready. Does nothing in dev, in browsers without service workers, or in
 *  the Android app (whose files are bundled and update with the app). */
export function startPwaUpdates(onNeedRefresh: () => void): void {
  // Some browsers expose `serviceWorker` as undefined (e.g. private windows).
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return;

  if (Capacitor.isNativePlatform()) {
    // The Android app ships its files inside the APK. A leftover service
    // worker from an earlier build could serve stale copies, so remove it.
    void removeServiceWorkerAndCaches();
    return;
  }
  if (!import.meta.env.PROD) return;

  void import("virtual:pwa-register").then(({ registerSW }) => {
    updateSW = registerSW({
      onNeedRefresh,
      onRegisteredSW(_url, registration) {
        if (!registration) return;
        const check = () => void registration.update().catch(() => {});
        // A long-open app would otherwise only look for updates at launch.
        setInterval(check, HOUR);
        document.addEventListener("visibilitychange", () => {
          if (!document.hidden) check();
        });
      },
    });
  });
}

/** Switches to the waiting version and reloads. */
export async function applyPwaUpdate(): Promise<void> {
  if (updateSW) await updateSW(true);
  else window.location.reload();
}

async function removeServiceWorkerAndCaches(): Promise<void> {
  try {
    const regs = (await navigator.serviceWorker.getRegistrations?.()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
    if (typeof caches !== "undefined") {
      for (const key of await caches.keys()) await caches.delete(key);
    }
  } catch {
    /* nothing to clean up, or not permitted — harmless */
  }
}

/** The newest deployed build's facts, or null if they can't be read (offline,
 *  or an older deploy without the file). Never throws. */
export async function fetchBuildInfo(): Promise<BuildInfo | null> {
  try {
    const url = new URL("version.json", document.baseURI);
    url.searchParams.set("t", String(Date.now())); // bypass any cache
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const j = (await res.json()) as Partial<BuildInfo> | null;
    if (!j || typeof j.schemaVersion !== "number" || !Number.isFinite(j.schemaVersion)) return null;
    return { schemaVersion: j.schemaVersion, builtAt: String(j.builtAt ?? "") };
  } catch {
    return null;
  }
}

/** Does the new build change how data is stored? True only when the new build's
 *  database version is higher than the one this page is running. */
export function dataFormatChanges(runningVersion: number, info: BuildInfo | null): boolean {
  return !!info && info.schemaVersion > runningVersion;
}

/** Whole days since the last backup, or null if there has never been one. */
export function backupAgeDays(lastBackupAt: number | undefined, now: number = Date.now()): number | null {
  if (!lastBackupAt) return null;
  return Math.max(0, Math.floor((now - lastBackupAt) / 86_400_000));
}
