import { useMemo, useState } from "react";
import { getDeviceAuth, type AuthFailure } from "../lib/deviceAuth";
import { TIMEOUT_CHOICES } from "../lib/appLock";
import { useLockStore } from "../store/useLockStore";
import { useUIStore } from "../store/useUIStore";

const WHY_NOT: Record<AuthFailure, string> = {
  noScreenLock: "Set a screen lock (PIN, pattern or fingerprint) in your device settings first, then try again.",
  unavailable: "This device or browser can't verify your device lock, so the app lock can't be turned on here.",
  cancelled: "Cancelled — the app lock was not changed.",
  failed: "That didn't work, so nothing was changed. Please try again.",
  lockedOut: "Too many attempts. Wait a moment and try again.",
};

/** Settings card: turn the app lock on/off, how soon it re-locks, and the
 *  privacy screen. Turning the lock OFF asks the person to unlock first, so
 *  someone borrowing an unlocked phone can't simply switch it off. */
export default function SecuritySettings() {
  const auth = useMemo(getDeviceAuth, []);
  const { config, setConfig, beginPrompt, endPrompt } = useLockStore();
  const showToast = useUIStore((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  const native = auth.kind === "native";

  async function turnOn() {
    setBusy(true);
    try {
      const check = await auth.check();
      if (!check.available) {
        showToast(WHY_NOT[check.reason ?? "unavailable"]);
        return;
      }
      beginPrompt();
      const r = await auth.enroll();
      endPrompt();
      if (!r.ok) {
        showToast(WHY_NOT[r.reason]);
        return;
      }
      // Hiding the app preview is part of a sensible default for a lock.
      setConfig({ enabled: true, privacyScreen: true, credentialId: r.credentialId });
      showToast("App lock is on.");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    try {
      beginPrompt();
      const r = await auth.authenticate({ credentialId: config.credentialId });
      endPrompt();
      if (!r.ok) {
        showToast("Couldn't confirm it's you, so the app lock stays on.");
        return;
      }
      setConfig({ enabled: false, credentialId: undefined });
      showToast("App lock is off.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Security</h2>
      <label style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 15, margin: "6px 0" }}>
        <input
          type="checkbox"
          checked={config.enabled}
          disabled={busy}
          onChange={() => (config.enabled ? turnOff() : turnOn())}
        />
        Require unlock to open Money Mate
      </label>
      <p className="muted" style={{ fontSize: 13 }}>
        {native
          ? "Uses your fingerprint, face or device PIN. Money Mate never sees or stores them."
          : "Uses your device's screen lock through the browser. On the web version this keeps casual snoopers out, but the data stored in this browser is not encrypted. The Android app can protect it more strongly."}
      </p>

      {config.enabled && (
        <>
          <div className="label" style={{ margin: "12px 0 6px" }}>Lock the app</div>
          <div className="chip-row">
            {TIMEOUT_CHOICES.map((c) => (
              <button
                key={c.sec}
                className={"chip" + (config.timeoutSec === c.sec ? " active" : "")}
                aria-pressed={config.timeoutSec === c.sec}
                onClick={() => setConfig({ timeoutSec: c.sec })}
              >
                {c.label}
              </button>
            ))}
          </div>
        </>
      )}

      <label style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 15, margin: "14px 0 6px" }}>
        <input
          type="checkbox"
          checked={config.privacyScreen}
          onChange={(e) => setConfig({ privacyScreen: e.target.checked })}
        />
        {native
          ? "Hide the app in recent apps and block screenshots"
          : "Hide the app when I switch away (best effort)"}
      </label>
      <p className="muted" style={{ fontSize: 13 }}>
        These settings stay on this device and are not part of backups.
      </p>
    </div>
  );
}
