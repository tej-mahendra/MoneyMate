import { Capacitor } from "@capacitor/core";
import {
  BiometryType,
  NativeBiometric,
} from "@capgo/capacitor-native-biometric";

// Asks the person to prove they hold the phone, using the device's OWN lock
// (fingerprint, face, PIN, pattern or password). Money Mate never sees or
// stores a biometric or a PIN.
//
// Android app: the system biometric prompt, plus a separate PIN prompt (the
//   plugin cannot show "fingerprint OR PIN" in one dialog on Android).
// Web / PWA: WebAuthn with the device's built-in authenticator. There is no
//   server, so nothing checks a signature — it is a screen gate: the browser
//   makes the person pass the device lock, and we trust that it did.

export type AuthFailure =
  | "cancelled" // person dismissed the prompt
  | "failed" // wrong finger / PIN, or an unknown error
  | "lockedOut" // too many wrong attempts — the phone is making them wait
  | "noScreenLock" // the device has no PIN/pattern/password set
  | "unavailable" // this device or browser cannot verify the person
  | "pluginMissing"; // Android: this build was made without the unlock plugin

export type AuthResult = { ok: true } | { ok: false; reason: AuthFailure };

export interface DeviceAuth {
  kind: "native" | "webauthn";
  /** Can this device verify the person at all? */
  check(): Promise<{ available: boolean; reason?: AuthFailure }>;
  /** One-time setup when the lock is turned on. Also proves the person can
   *  pass the device lock right now. Web returns the new credential id. */
  enroll(): Promise<AuthResult & { credentialId?: string }>;
  authenticate(opts?: { credentialId?: string }): Promise<AuthResult>;
  /** Android only: PIN / pattern / password instead of biometrics. */
  authenticateWithPin?(): Promise<AuthResult>;
}

// ───────────────────────── Android (native) ─────────────────────────
const CODE = {
  BIOMETRICS_UNAVAILABLE: 1,
  USER_LOCKOUT: 2,
  BIOMETRICS_NOT_ENROLLED: 3,
  USER_TEMPORARY_LOCKOUT: 4,
  PASSCODE_NOT_SET: 14,
  USER_CANCEL: 16,
  USER_FALLBACK: 17,
  SYSTEM_CANCEL: 15,
} as const;

/** Capacitor rejects with code UNIMPLEMENTED when a plugin's JS is bundled but
 *  its native half was never compiled into the app (e.g. `npx cap sync android`
 *  wasn't run after the plugin was added). Worth telling apart from "this
 *  phone can't do it", because the fix is a new build, not a phone setting. */
function isPluginMissing(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (e?.code === "UNIMPLEMENTED") return true;
  return typeof e?.message === "string" && /plugin is not implemented|not implemented on android/i.test(e.message);
}

/** Translates the plugin's error (its `code` may arrive as a number or a numeric string). */
export function mapNativeError(err: unknown): AuthFailure {
  if (isPluginMissing(err)) return "pluginMissing";
  const code = Number((err as { code?: unknown } | null)?.code);
  switch (code) {
    case CODE.USER_CANCEL:
    case CODE.USER_FALLBACK:
    case CODE.SYSTEM_CANCEL:
      return "cancelled";
    case CODE.USER_LOCKOUT:
    case CODE.USER_TEMPORARY_LOCKOUT:
      return "lockedOut";
    case CODE.PASSCODE_NOT_SET:
      return "noScreenLock";
    case CODE.BIOMETRICS_UNAVAILABLE:
    case CODE.BIOMETRICS_NOT_ENROLLED:
      return "unavailable";
    default:
      return "failed";
  }
}

const PROMPT = {
  title: "Unlock Money Mate",
  reason: "Confirm it's you to open your finances.",
};

async function nativeVerify(biometric: boolean): Promise<AuthResult> {
  try {
    await NativeBiometric.verifyIdentity(
      biometric
        ? { ...PROMPT, negativeButtonText: "Use PIN", maxAttempts: 3 }
        : { ...PROMPT, allowedBiometryTypes: [BiometryType.DEVICE_CREDENTIAL] },
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: mapNativeError(err) };
  }
}

export const nativeAuth: DeviceAuth = {
  kind: "native",
  async check() {
    try {
      // useFallback: a device with only a PIN still counts as able to verify.
      const r = await NativeBiometric.isAvailable({ useFallback: true });
      if (r.isAvailable) return { available: true };
      return { available: false, reason: r.deviceIsSecure ? "unavailable" : "noScreenLock" };
    } catch (err) {
      return { available: false, reason: isPluginMissing(err) ? "pluginMissing" : "unavailable" };
    }
  },
  async enroll() {
    return nativeBiometricOrPin();
  },
  async authenticate() {
    return nativeBiometricOrPin();
  },
  async authenticateWithPin() {
    return nativeVerify(false);
  },
};

// Fingerprint/face first. If biometrics aren't usable at all (none enrolled),
// go straight to the PIN prompt so the person is never stuck.
async function nativeBiometricOrPin(): Promise<AuthResult> {
  let biometricsUsable = false;
  try {
    biometricsUsable = (await NativeBiometric.isAvailable({ useFallback: false })).isAvailable;
  } catch {
    biometricsUsable = false;
  }
  return nativeVerify(biometricsUsable);
}

// ───────────────────────── Web (WebAuthn) ─────────────────────────
const toB64Url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fromB64Url = (s: string) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

function webFailure(err: unknown): AuthFailure {
  const name = (err as { name?: string } | null)?.name;
  // NotAllowedError covers "dismissed", "timed out" and "no such credential".
  if (name === "NotAllowedError" || name === "AbortError") return "cancelled";
  if (name === "NotSupportedError" || name === "SecurityError") return "unavailable";
  return "failed";
}

export const webAuthn: DeviceAuth = {
  kind: "webauthn",
  async check() {
    try {
      if (
        typeof window === "undefined" ||
        !window.PublicKeyCredential ||
        !navigator.credentials
      ) {
        return { available: false, reason: "unavailable" };
      }
      const ok =
        await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.();
      // No platform authenticator almost always means "no screen lock set".
      return ok ? { available: true } : { available: false, reason: "noScreenLock" };
    } catch {
      return { available: false, reason: "unavailable" };
    }
  },
  async enroll() {
    try {
      const cred = (await navigator.credentials.create({
        publicKey: {
          challenge: randomBytes(32),
          rp: { name: "Money Mate" },
          user: { id: randomBytes(16), name: "moneymate-local", displayName: "Money Mate" },
          pubKeyCredParams: [
            { type: "public-key", alg: -7 },
            { type: "public-key", alg: -257 },
          ],
          authenticatorSelection: {
            authenticatorAttachment: "platform",
            userVerification: "required",
            residentKey: "discouraged",
          },
          attestation: "none",
          timeout: 60_000,
        },
      })) as PublicKeyCredential | null;
      if (!cred) return { ok: false, reason: "failed" };
      return { ok: true, credentialId: toB64Url(cred.rawId) };
    } catch (err) {
      return { ok: false, reason: webFailure(err) };
    }
  },
  async authenticate(opts) {
    if (!opts?.credentialId) return { ok: false, reason: "unavailable" };
    try {
      const got = await navigator.credentials.get({
        publicKey: {
          challenge: randomBytes(32),
          allowCredentials: [
            { type: "public-key", id: fromB64Url(opts.credentialId), transports: ["internal"] },
          ],
          userVerification: "required",
          timeout: 60_000,
        },
      });
      return got ? { ok: true } : { ok: false, reason: "failed" };
    } catch (err) {
      return { ok: false, reason: webFailure(err) };
    }
  },
};

export function getDeviceAuth(): DeviceAuth {
  return Capacitor.isNativePlatform() ? nativeAuth : webAuthn;
}
