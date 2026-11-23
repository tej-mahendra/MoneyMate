import { create } from "zustand";
import {
  loadLockConfig,
  saveLockConfig,
  shouldRelock,
  type LockConfig,
} from "../lib/appLock";

// How long after an unlock prompt closes we still ignore "app left / came
// back" signals: on some phones the system prompt itself briefly pauses the
// app, which would otherwise lock it again the instant it unlocked.
const PROMPT_GRACE_MS = 1500;

interface LockState {
  config: LockConfig;
  /** True when the lock screen must cover the app. */
  locked: boolean;
  /** When the app last left the foreground, or null. */
  hiddenAt: number | null;
  /** Until this time (ms), hide/show signals are ignored (prompt in progress or just closed). */
  quietUntil: number;

  /** Updates and persists the settings. Turning the lock off also unlocks. */
  setConfig: (patch: Partial<LockConfig>) => void;
  lock: () => void;
  unlock: () => void;
  beginPrompt: () => void;
  endPrompt: (now?: number) => void;
  noteHidden: (now?: number) => void;
  /** App is back in the foreground; locks if it was away longer than allowed. */
  noteVisible: (now?: number) => void;
}

const initial = loadLockConfig();

export const useLockStore = create<LockState>((set, get) => ({
  config: initial,
  // Cold start: if the lock is on, the very first paint is the lock screen.
  locked: initial.enabled,
  hiddenAt: null,
  quietUntil: 0,

  setConfig: (patch) => {
    const config = { ...get().config, ...patch };
    saveLockConfig(config);
    set({ config, locked: config.enabled ? get().locked : false });
  },
  lock: () => set({ locked: true }),
  unlock: () => set({ locked: false, hiddenAt: null }),

  beginPrompt: () => set({ quietUntil: Infinity }),
  endPrompt: (now = Date.now()) => set({ quietUntil: now + PROMPT_GRACE_MS }),

  noteHidden: (now = Date.now()) => {
    const s = get();
    if (now < s.quietUntil) return;
    // Keep the EARLIEST hide time if several signals arrive for one departure.
    if (s.hiddenAt === null) set({ hiddenAt: now });
  },
  noteVisible: (now = Date.now()) => {
    const s = get();
    if (now < s.quietUntil) {
      set({ hiddenAt: null });
      return;
    }
    const relock = shouldRelock(s.config, s.hiddenAt, now);
    set({ hiddenAt: null, ...(relock ? { locked: true } : null) });
  },
}));
