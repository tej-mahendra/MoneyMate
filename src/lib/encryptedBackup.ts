import { updateSettings, type Settings } from "../db/db";
import { encryptBackup } from "./backupCrypto";
import { downloadFile, exportFullBackup } from "./csv";
import { todayISO } from "./format";

/** Makes a passphrase-encrypted backup file, hands it to the share sheet /
 *  downloads it, and records the backup time. Returns the updated settings.
 *  Throws if the file couldn't be created or saved. Shared by Settings and
 *  the "update available" prompt so both behave identically. */
export async function saveEncryptedBackup(passphrase: string): Promise<Settings> {
  const encrypted = await encryptBackup(await exportFullBackup(), passphrase);
  await downloadFile(
    `moneymate-backup-${todayISO()}.encrypted.json`,
    encrypted,
    "application/json",
  );
  return updateSettings({ lastBackupAt: Date.now(), backupNudgeSnoozedUntil: 0 });
}
