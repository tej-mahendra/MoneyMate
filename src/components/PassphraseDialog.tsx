import { useEffect, useRef, useState } from "react";
import { Lock } from "lucide-react";
import { MIN_PASSPHRASE_LENGTH } from "../lib/backupCrypto";

/** Asks for a backup passphrase. "export" asks twice (a typo would make the
 *  backup unrecoverable); "unlock" asks once, for restoring or checking.
 *  Reuses the confirm dialog's look. Rendered by Settings at the page root —
 *  not inside a card, whose backdrop blur would break `position: fixed`. */
export default function PassphraseDialog({
  mode,
  title,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  mode: "export" | "unlock";
  title: string;
  busy: boolean;
  error: string | null;
  onSubmit: (passphrase: string) => void;
  onCancel: () => void;
}) {
  const [pass, setPass] = useState("");
  const [again, setAgain] = useState("");
  const [show, setShow] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  const exporting = mode === "export";
  const tooShort = pass.length < MIN_PASSPHRASE_LENGTH;
  const mismatch = exporting && pass !== again;
  // Only nag once they've typed something in the second box.
  const localError = exporting
    ? tooShort && pass.length > 0
      ? `Use at least ${MIN_PASSPHRASE_LENGTH} characters.`
      : mismatch && again.length > 0
        ? "The two passphrases don't match."
        : null
    : null;
  const canSubmit = !busy && pass.length > 0 && (!exporting || (!tooShort && !mismatch));

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "13px 14px",
    border: "1px solid var(--surface-border)",
    borderRadius: 13,
    background: "var(--surface-strong)",
    color: "var(--ink)",
    fontSize: 15.5,
    fontWeight: 500,
    marginBottom: 10,
  };
  const type = show ? "text" : "password";

  return (
    <div className="confirm-overlay" onClick={() => !busy && onCancel()}>
      <form
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pp-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) onSubmit(pass);
        }}
      >
        <div className="confirm-icon-wrap">
          <Lock size={22} />
        </div>
        <h3 id="pp-title" className="confirm-title">
          {title}
        </h3>
        <p className="confirm-message">
          {exporting
            ? "Choose a passphrase for this backup. If you forget it, nobody can open the file — not even Money Mate. Write it down somewhere safe."
            : "Enter the passphrase you chose when this backup was made."}
        </p>
        <div style={{ textAlign: "left" }}>
          <input
            ref={firstRef}
            type={type}
            style={inputStyle}
            aria-label="Passphrase"
            placeholder="Passphrase"
            autoComplete={exporting ? "new-password" : "current-password"}
            value={pass}
            onChange={(e) => setPass(e.target.value)}
          />
          {exporting && (
            <input
              type={type}
              style={inputStyle}
              aria-label="Repeat passphrase"
              placeholder="Repeat passphrase"
              autoComplete="new-password"
              value={again}
              onChange={(e) => setAgain(e.target.value)}
            />
          )}
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13.5, marginBottom: 8 }}>
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
            Show passphrase
          </label>
          {(error || localError) && (
            <p role="alert" style={{ color: "var(--over)", fontSize: 13.5, margin: "4px 0 8px" }}>
              {error || localError}
            </p>
          )}
        </div>
        <div className="confirm-actions">
          <button type="button" className="btn secondary confirm-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn confirm-btn" disabled={!canSubmit}>
            {busy ? "Working…" : exporting ? "Encrypt & export" : "Unlock"}
          </button>
        </div>
      </form>
    </div>
  );
}
