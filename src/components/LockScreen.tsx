import { useEffect, useMemo, useRef, useState } from "react";
import { Lock } from "lucide-react";
import { getDeviceAuth, type AuthFailure, type AuthResult } from "../lib/deviceAuth";
import { useLockStore } from "../store/useLockStore";

const MESSAGE: Record<AuthFailure, string | null> = {
  cancelled: null, // dismissing the prompt isn't an error worth shouting about
  failed: "That didn't work. Try again.",
  lockedOut: "Too many attempts. Wait a moment, or use your device PIN.",
  noScreenLock: "Set a screen lock (PIN, pattern or fingerprint) in your device settings first.",
  unavailable: "This device can't verify you right now.",
};

/** Full-screen cover shown while the app is locked. Prompts automatically
 *  when it appears, and always leaves a way to try again. */
export default function LockScreen() {
  const auth = useMemo(getDeviceAuth, []);
  const { config, unlock, setConfig, beginPrompt, endPrompt } = useLockStore();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fails, setFails] = useState(0);
  const prompted = useRef(false);

  async function attempt(run: () => Promise<AuthResult>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    beginPrompt();
    let result: AuthResult;
    try {
      result = await run();
    } catch {
      result = { ok: false, reason: "failed" };
    }
    endPrompt();
    setBusy(false);
    if (result.ok) {
      unlock();
      return;
    }
    setFails((n) => n + 1);
    setError(MESSAGE[result.reason]);
  }

  const unlockMain = () => attempt(() => auth.authenticate({ credentialId: config.credentialId }));
  const unlockWithPin = () => attempt(() => auth.authenticateWithPin!());

  // Web only. If the saved credential is gone (passkey deleted, site data
  // cleared), re-enrolling asks for the device lock again — the same proof as
  // unlocking — so it is a safe way back in, not a bypass.
  async function setUpAgain() {
    await attempt(async () => {
      const r = await auth.enroll();
      if (r.ok && r.credentialId) setConfig({ credentialId: r.credentialId });
      return r;
    });
  }

  useEffect(() => {
    if (prompted.current) return;
    prompted.current = true;
    void unlockMain();
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="lock-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100000,
        background: "var(--void)",
        color: "var(--ink)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        padding: 24,
        textAlign: "center",
      }}
    >
      <div className="confirm-icon-wrap">
        <Lock size={26} />
      </div>
      <h1 id="lock-title" style={{ fontFamily: "var(--display)", fontSize: 26, margin: 0 }}>
        Money Mate is locked
      </h1>
      <p className="muted" style={{ maxWidth: 300, margin: 0 }}>
        {auth.kind === "native"
          ? "Unlock with your fingerprint, face or device PIN."
          : "Unlock with your device screen lock."}
      </p>
      {error && (
        <p role="alert" style={{ color: "var(--over)", fontSize: 14, margin: 0, maxWidth: 300 }}>
          {error}
        </p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 300 }}>
        <button className="btn" onClick={unlockMain} disabled={busy}>
          {busy ? "Waiting…" : "Unlock"}
        </button>
        {auth.authenticateWithPin && (
          <button className="btn secondary" onClick={unlockWithPin} disabled={busy}>
            Use device PIN
          </button>
        )}
        {auth.kind === "webauthn" && fails >= 2 && (
          <button className="btn secondary" onClick={setUpAgain} disabled={busy}>
            Trouble unlocking? Set up the lock again
          </button>
        )}
      </div>
    </div>
  );
}
