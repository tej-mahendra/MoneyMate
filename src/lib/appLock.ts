// App lock — configuration and the "when should it lock again?" rule.
//
// The lock settings live in localStorage on THIS device, deliberately NOT in
// the database: backups are restored onto other phones, and a restored
// "lock is on" flag pointing at a credential that only exists on the old
// phone would lock the person out of their own data. Device-local also lets
// the lock screen appear on first paint, before the database has opened.

export const LOCK_STORAGE_KEY = "pfos_lock";

export const TIMEOUT_CHOICES = [
  { sec: 0, label: "Immediately" },
  { sec: 60, label: "After 1 minute" },
  { sec: 300, label: "After 5 minutes" },
] as const;

export interface LockConfig {
  enabled: boolean;
  /** How long the app may be in the background before it locks again. */
  timeoutSec: number;
  /** Hide the app in the recent-apps list (and block screenshots on Android). */
  privacyScreen: boolean;
  /** Web only: id of the device-lock credential created when the lock was turned on. */
  credentialId?: string;
}

export const DEFAULT_LOCK: LockConfig = {
  enabled: false,
  timeoutSec: 60,
  privacyScreen: false,
};

/** Accepts whatever is in storage and returns a safe config — corrupt or
 *  hand-edited values never throw or half-apply. */
export function sanitizeLockConfig(raw: unknown): LockConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_LOCK };
  const r = raw as Record<string, unknown>;
  const allowed = TIMEOUT_CHOICES.map((c) => c.sec) as number[];
  return {
    enabled: r.enabled === true,
    timeoutSec:
      typeof r.timeoutSec === "number" && allowed.includes(r.timeoutSec)
        ? r.timeoutSec
        : DEFAULT_LOCK.timeoutSec,
    privacyScreen: r.privacyScreen === true,
    credentialId:
      typeof r.credentialId === "string" && r.credentialId.length > 0
        ? r.credentialId
        : undefined,
  };
}

export function loadLockConfig(storage: Storage = localStorage): LockConfig {
  try {
    const text = storage.getItem(LOCK_STORAGE_KEY);
    return text ? sanitizeLockConfig(JSON.parse(text)) : { ...DEFAULT_LOCK };
  } catch {
    return { ...DEFAULT_LOCK };
  }
}

export function saveLockConfig(config: LockConfig, storage: Storage = localStorage): void {
  try {
    storage.setItem(LOCK_STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* storage blocked — the in-memory state still applies for this session */
  }
}

/** Has the app been away long enough that it must ask again? `hiddenAt` is
 *  when it left the foreground (ms), or null if it hasn't. */
export function shouldRelock(
  config: Pick<LockConfig, "enabled" | "timeoutSec">,
  hiddenAt: number | null,
  now: number,
): boolean {
  if (!config.enabled || hiddenAt === null) return false;
  const away = now - hiddenAt;
  // A clock set backwards must not stretch the grace period.
  if (away < 0) return true;
  return away >= config.timeoutSec * 1000;
}
