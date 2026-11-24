import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { db, type Settings } from "../db/db";
import { applyPwaUpdate, backupAgeDays, dataFormatChanges, fetchBuildInfo } from "../lib/pwaUpdate";
import { saveEncryptedBackup } from "../lib/encryptedBackup";
import { usePwaUpdateStore } from "../store/usePwaUpdateStore";
import { useUIStore } from "../store/useUIStore";
import PassphraseDialog from "./PassphraseDialog";

// If the last backup is older than this, the prompt suggests one before updating.
const STALE_BACKUP_DAYS = 14;

/** "A new version is ready" — shown only once the new version has been
 *  downloaded and is waiting. The person chooses when to switch.
 *  - Normal update: Update now / Later.
 *  - Update that changes how data is stored: the main button makes an
 *    encrypted backup first, then updates (and only updates if the backup
 *    succeeded). An ordinary update never touches stored data. */
export default function UpdatePrompt({
  settings,
  onSettingsChange,
}: {
  settings: Settings;
  onSettingsChange: (s: Settings) => void;
}) {
  const ready = usePwaUpdateStore((s) => s.ready);
  const dismissed = usePwaUpdateStore((s) => s.dismissed);
  const dismiss = usePwaUpdateStore((s) => s.dismiss);
  const showToast = useUIStore((s) => s.showToast);

  const [formatChanges, setFormatChanges] = useState(false);
  const [askPassphrase, setAskPassphrase] = useState(false);
  const [busy, setBusy] = useState(false);

  // Ask the server whether this build changes the data format. If it can't be
  // read (offline, older deploy) we assume it doesn't — and the backup hint
  // below still appears for a stale backup.
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void fetchBuildInfo().then((info) => {
      if (alive) setFormatChanges(dataFormatChanges(db.verno, info));
    });
    return () => {
      alive = false;
    };
  }, [ready]);

  if (!ready || dismissed) return null;

  const age = backupAgeDays(settings.lastBackupAt);
  const staleBackup = age === null || age >= STALE_BACKUP_DAYS;
  const backupLine =
    age === null
      ? "You haven't made a backup yet."
      : `Your last backup was ${age} day${age === 1 ? "" : "s"} ago.`;

  async function backupThenUpdate(passphrase: string) {
    setBusy(true);
    try {
      onSettingsChange(await saveEncryptedBackup(passphrase));
    } catch {
      // No backup, no update: the person asked for the safe path.
      setBusy(false);
      setAskPassphrase(false);
      showToast("Couldn't save the backup, so the update was not applied. Please try again.");
      return;
    }
    setBusy(false);
    setAskPassphrase(false);
    await applyPwaUpdate();
  }

  return (
    <>
      <div
        role="region"
        aria-label="Update available"
        className="card"
        style={{
          position: "fixed",
          left: 12,
          right: 12,
          bottom: "calc(84px + env(safe-area-inset-bottom, 0px))",
          // Above the bottom nav (100) but below every dialog (200), so a dialog
          // opened from here — or any other — is never covered by this banner.
          zIndex: 150,
          margin: 0,
          // Solid, not the card's ~5% glass tint: this floats over live page
          // content, and where the blur isn't applied (Android WebView) a
          // see-through banner lets that content bleed into its text.
          backgroundColor: "var(--void-elev)",
          backgroundImage: "linear-gradient(var(--surface-strong), var(--surface-strong))",
          boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
        }}
      >
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <Download size={20} style={{ flex: "none", marginTop: 2 }} />
          <div>
            <strong>
              {formatChanges ? "Update changes how data is stored" : "Update available"}
            </strong>
            <p className="muted" style={{ fontSize: 13.5, margin: "4px 0 0" }}>
              {formatChanges
                ? "This version changes how your data is stored on this device. Updates are tested, but an encrypted backup first means you can always get it back."
                : "A new version of Money Mate is ready. Updating keeps all your data on this device."}
              {!formatChanges && staleBackup && ` ${backupLine} A backup first is a good idea.`}
            </p>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          {formatChanges ? (
            <>
              <button className="btn" onClick={() => setAskPassphrase(true)} disabled={busy}>
                Back up, then update
              </button>
              <button className="btn secondary" onClick={() => void applyPwaUpdate()} disabled={busy}>
                Update without backup
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={() => void applyPwaUpdate()} disabled={busy}>
                Update now
              </button>
              {staleBackup && (
                <button className="btn secondary" onClick={() => setAskPassphrase(true)} disabled={busy}>
                  Back up first
                </button>
              )}
            </>
          )}
          <button className="btn secondary" onClick={dismiss} disabled={busy}>
            Later
          </button>
        </div>
      </div>
      {askPassphrase && (
        <PassphraseDialog
          mode="export"
          title="Encrypt this backup"
          busy={busy}
          error={null}
          onSubmit={backupThenUpdate}
          onCancel={() => setAskPassphrase(false)}
        />
      )}
    </>
  );
}
