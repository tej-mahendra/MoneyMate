import { describe, it, expect } from "vitest";
import {
  BackupFormatError,
  BackupPassphraseError,
  decryptBackup,
  encryptBackup,
  isEncryptedBackup,
  summarizeBackup,
} from "./backupCrypto";

const FAST = { iterations: 100_000 };
const PLAIN = JSON.stringify({
  schemaVersion: 1,
  categories: [{ id: 1 }],
  transactions: [{ id: 1, amount: 450, merchant: "Swiggy ₹ ünïcode" }],
  exportedAt: "2026-11-20T10:00:00.000Z",
});

describe("encrypted backup", () => {
  it("round-trips, including non-ASCII text", async () => {
    const enc = await encryptBackup(PLAIN, "correct horse", FAST);
    expect(await decryptBackup(enc, "correct horse")).toBe(PLAIN);
  });

  it("the file does not contain the readable data", async () => {
    const enc = await encryptBackup(PLAIN, "correct horse", FAST);
    expect(enc).not.toContain("Swiggy");
    expect(enc).not.toContain("450");
    expect(isEncryptedBackup(enc)).toBe(true);
  });

  it("a wrong passphrase fails with BackupPassphraseError", async () => {
    const enc = await encryptBackup(PLAIN, "correct horse", FAST);
    await expect(decryptBackup(enc, "wrong horse!")).rejects.toBeInstanceOf(
      BackupPassphraseError,
    );
  });

  it("a modified file (ciphertext or header) is rejected, not half-read", async () => {
    const env = JSON.parse(await encryptBackup(PLAIN, "correct horse", FAST));
    const flipped = { ...env, ciphertext: env.ciphertext.replace(/.$/, (c: string) => (c === "A" ? "B" : "A")) };
    await expect(decryptBackup(JSON.stringify(flipped), "correct horse")).rejects.toBeInstanceOf(BackupPassphraseError);
    const retuned = { ...env, iterations: 100_001 };
    await expect(decryptBackup(JSON.stringify(retuned), "correct horse")).rejects.toBeInstanceOf(BackupPassphraseError);
  });

  it("same passphrase, different files — salt and IV are fresh each time", async () => {
    const a = JSON.parse(await encryptBackup(PLAIN, "correct horse", FAST));
    const b = JSON.parse(await encryptBackup(PLAIN, "correct horse", FAST));
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("refuses a too-short passphrase", async () => {
    await expect(encryptBackup(PLAIN, "short", FAST)).rejects.toThrow(/at least 8/);
  });

  it("accented passphrases match whichever way they were typed", async () => {
    const enc = await encryptBackup(PLAIN, "caf\u00e9 au lait", FAST); // é composed
    expect(await decryptBackup(enc, "cafe\u0301 au lait")).toBe(PLAIN); // e + accent
  });

  it("rejects non-backup text and absurd iteration counts without hanging", async () => {
    await expect(decryptBackup("not json", "whatever1")).rejects.toBeInstanceOf(BackupFormatError);
    await expect(decryptBackup('{"a":1}', "whatever1")).rejects.toBeInstanceOf(BackupFormatError);
    const env = JSON.parse(await encryptBackup(PLAIN, "correct horse", FAST));
    await expect(
      decryptBackup(JSON.stringify({ ...env, iterations: 999_999_999 }), "correct horse"),
    ).rejects.toBeInstanceOf(BackupFormatError);
  });

  it("isEncryptedBackup is false for an ordinary plain backup", () => {
    expect(isEncryptedBackup(PLAIN)).toBe(false);
    expect(isEncryptedBackup("garbage")).toBe(false);
  });

  it("encrypts a large backup (chunked base64 does not overflow the stack)", async () => {
    const big = JSON.stringify({ categories: [], transactions: Array.from({ length: 20000 }, (_, i) => ({ id: i, note: "x".repeat(20) })) });
    const enc = await encryptBackup(big, "correct horse", FAST);
    expect(await decryptBackup(enc, "correct horse")).toBe(big);
  });
});

describe("summarizeBackup", () => {
  it("counts records without needing the database", () => {
    expect(summarizeBackup(PLAIN)).toEqual({
      transactions: 1,
      categories: 1,
      exportedAt: "2026-11-20T10:00:00.000Z",
    });
  });
  it("rejects things that are not backups", () => {
    expect(() => summarizeBackup("nope")).toThrow(BackupFormatError);
    expect(() => summarizeBackup('{"transactions":[]}')).toThrow(BackupFormatError);
  });
});
