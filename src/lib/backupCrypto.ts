// Passphrase-encrypted backups. Pure Web Crypto (built into browsers and the
// Android WebView) — no dependencies, same code in the PWA and the APK.
//
// File format (plain JSON text, so the existing share/download path and the
// file picker keep working unchanged):
//   { format, version, kdf, iterations, salt, iv, ciphertext }   (binary → base64)
// Key  = PBKDF2-HMAC-SHA256(passphrase, salt, iterations) → AES-256-GCM key.
// GCM authenticates the data, so a wrong passphrase OR a modified file both
// fail to decrypt — nothing half-restores. The header fields are bound in as
// "additional data", so changing the iteration count or salt also fails.

export const BACKUP_FORMAT = "moneymate-encrypted-backup";
const VERSION = 1;
/** OWASP's published guidance for PBKDF2-HMAC-SHA256 — re-check it
 *  periodically and raise it; old files keep working (iterations are stored). */
export const DEFAULT_ITERATIONS = 600_000;
export const MIN_PASSPHRASE_LENGTH = 8;
// A hostile file must not be able to freeze the app with a huge iteration count.
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 5_000_000;

/** Wrong passphrase, or the file was altered (AES-GCM can't tell which). */
export class BackupPassphraseError extends Error {
  constructor() {
    super("Wrong passphrase, or the backup file was changed.");
    this.name = "BackupPassphraseError";
  }
}
/** Not a Money Mate backup, or a format this version can't read. */
export class BackupFormatError extends Error {
  constructor(message = "That file doesn't look like a valid backup.") {
    super(message);
    this.name = "BackupFormatError";
  }
}

interface Envelope {
  format: string;
  version: number;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(bytes: Uint8Array): string {
  let s = "";
  // Chunked: String.fromCharCode(...bigArray) overflows the call stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Same visible passphrase must always give the same key, whichever keyboard
// produced it (composed vs decomposed accents).
const normalize = (p: string) => p.normalize("NFKC");

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    enc.encode(normalize(passphrase)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const aad = (version: number, iterations: number, salt: string) =>
  enc.encode(`${BACKUP_FORMAT}|${version}|${iterations}|${salt}`);

export async function encryptBackup(
  plainJson: string,
  passphrase: string,
  opts: { iterations?: number } = {},
): Promise<string> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const saltB64 = toB64(salt);
  const key = await deriveKey(passphrase, salt, iterations);
  const cipher = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: aad(VERSION, iterations, saltB64) as BufferSource,
    },
    key,
    enc.encode(plainJson),
  );
  const envelope: Envelope = {
    format: BACKUP_FORMAT,
    version: VERSION,
    kdf: "PBKDF2-SHA256",
    iterations,
    salt: saltB64,
    iv: toB64(iv),
    ciphertext: toB64(new Uint8Array(cipher)),
  };
  return JSON.stringify(envelope);
}

function parseEnvelope(text: string): Envelope {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    throw new BackupFormatError();
  }
  const e = o as Partial<Envelope> | null;
  if (!e || e.format !== BACKUP_FORMAT) throw new BackupFormatError();
  if (typeof e.version !== "number" || e.version > VERSION) {
    throw new BackupFormatError(
      "This backup was made by a newer version of Money Mate. Please update the app first.",
    );
  }
  if (
    e.kdf !== "PBKDF2-SHA256" ||
    typeof e.iterations !== "number" ||
    e.iterations < MIN_ITERATIONS ||
    e.iterations > MAX_ITERATIONS ||
    typeof e.salt !== "string" ||
    typeof e.iv !== "string" ||
    typeof e.ciphertext !== "string"
  ) {
    throw new BackupFormatError();
  }
  return e as Envelope;
}

/** True when the text is one of our encrypted backups (cheap, no passphrase). */
export function isEncryptedBackup(text: string): boolean {
  try {
    return (JSON.parse(text) as { format?: unknown } | null)?.format === BACKUP_FORMAT;
  } catch {
    return false;
  }
}

export async function decryptBackup(text: string, passphrase: string): Promise<string> {
  const e = parseEnvelope(text);
  let plain: ArrayBuffer;
  try {
    const key = await deriveKey(passphrase, fromB64(e.salt), e.iterations);
    plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromB64(e.iv) as BufferSource,
        additionalData: aad(e.version, e.iterations, e.salt) as BufferSource,
      },
      key,
      fromB64(e.ciphertext) as BufferSource,
    );
  } catch {
    throw new BackupPassphraseError();
  }
  return dec.decode(plain);
}

export interface BackupSummary {
  transactions: number;
  categories: number;
  exportedAt?: string;
}

/** Read-only look inside a (decrypted) backup, for "Check this backup". Does
 *  not touch the database. */
export function summarizeBackup(json: string): BackupSummary {
  let o: unknown;
  try {
    o = JSON.parse(json);
  } catch {
    throw new BackupFormatError();
  }
  const d = o as Record<string, unknown> | null;
  if (!d || !Array.isArray(d.transactions) || !Array.isArray(d.categories)) {
    throw new BackupFormatError();
  }
  return {
    transactions: d.transactions.length,
    categories: d.categories.length,
    exportedAt: typeof d.exportedAt === "string" ? d.exportedAt : undefined,
  };
}
