// A deploy replaces the app's files, and the open page may still be the old
// version. When that old page asks for a screen's file by its old name, the
// server no longer has it and the load fails — which used to show the
// "Something went wrong" screen until the app was closed and reopened.
// These helpers detect exactly that situation and reload once into the new
// version instead.

const KEY = "mm_stale_reload_at";
// A second failure inside this window is a real problem (e.g. offline with
// nothing cached), not a stale page — show the error instead of looping.
const COOLDOWN_MS = 30_000;

/** True for the "a file this page needs couldn't be loaded" family of errors,
 *  across Chrome, Firefox, Safari and older bundlers. */
export function isChunkLoadError(err: unknown): boolean {
  const msg =
    err instanceof Error ? `${err.name} ${err.message}` : String(err ?? "");
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading chunk [\w-]+ failed|ChunkLoadError|Unable to preload CSS/i.test(
    msg,
  );
}

/** Reloads the page once so it picks up the new version. Returns false (and
 *  does nothing) if it already did that moments ago, or if the browser won't
 *  let us remember that — in both cases reloading again could loop. */
export function reloadForNewVersion(now: number = Date.now()): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (last && now - last < COOLDOWN_MS) return false;
    sessionStorage.setItem(KEY, String(now));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/** Vite fires `vite:preloadError` when a lazily loaded screen can't be
 *  fetched. Recover quietly instead of letting the error reach the screen. */
export function installStaleVersionRecovery(): void {
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadForNewVersion()) event.preventDefault();
  });
}

/** Asks the browser not to clear this site's data when the phone is low on
 *  storage. Browsers decide silently (no prompt in Chrome); an installed PWA
 *  is usually granted it already. Never throws. Backups remain the real
 *  safety net — this is only extra protection. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
