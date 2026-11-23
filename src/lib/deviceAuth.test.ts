import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Capacitor } from "@capacitor/core";

vi.mock("@capgo/capacitor-native-biometric", () => ({
  BiometryType: { DEVICE_CREDENTIAL: 7 },
  NativeBiometric: { isAvailable: vi.fn(), verifyIdentity: vi.fn() },
}));
import { NativeBiometric } from "@capgo/capacitor-native-biometric";
import { getDeviceAuth, mapNativeError, nativeAuth, webAuthn } from "./deviceAuth";

const isAvailable = vi.mocked(NativeBiometric.isAvailable);
const verify = vi.mocked(NativeBiometric.verifyIdentity);
const avail = (isAvail: boolean, deviceIsSecure = true) =>
  ({ isAvailable: isAvail, deviceIsSecure }) as never;

beforeEach(() => {
  isAvailable.mockReset();
  verify.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("mapNativeError", () => {
  it.each([
    [16, "cancelled"], [17, "cancelled"], [15, "cancelled"],
    [2, "lockedOut"], [4, "lockedOut"],
    [14, "noScreenLock"],
    [1, "unavailable"], [3, "unavailable"],
    [10, "failed"], [0, "failed"],
  ])("code %s → %s", (code, expected) => {
    expect(mapNativeError({ code })).toBe(expected);
  });
  it("accepts the code as a numeric string and survives junk", () => {
    expect(mapNativeError({ code: "16" })).toBe("cancelled");
    expect(mapNativeError(null)).toBe("failed");
    expect(mapNativeError("boom")).toBe("failed");
  });
});

describe("Android (native) auth", () => {
  it("check: available when a biometric OR a PIN can verify", async () => {
    isAvailable.mockResolvedValue(avail(true));
    expect(await nativeAuth.check()).toEqual({ available: true });
    expect(isAvailable).toHaveBeenCalledWith({ useFallback: true });
  });
  it("check: says 'no screen lock' when the device has none", async () => {
    isAvailable.mockResolvedValue(avail(false, false));
    expect(await nativeAuth.check()).toEqual({ available: false, reason: "noScreenLock" });
  });
  it("check: unavailable when secure but nothing can verify, or the plugin throws", async () => {
    isAvailable.mockResolvedValue(avail(false, true));
    expect((await nativeAuth.check()).reason).toBe("unavailable");
    isAvailable.mockRejectedValue(new Error("x"));
    expect((await nativeAuth.check()).reason).toBe("unavailable");
  });

  it("authenticate: uses the biometric prompt with a 'Use PIN' button when biometrics work", async () => {
    isAvailable.mockResolvedValue(avail(true));
    verify.mockResolvedValue(undefined);
    expect(await nativeAuth.authenticate()).toEqual({ ok: true });
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ negativeButtonText: "Use PIN" }));
    expect(verify.mock.calls[0][0]).not.toHaveProperty("allowedBiometryTypes");
  });
  it("authenticate: goes straight to the PIN prompt when no biometric is enrolled (never stuck)", async () => {
    isAvailable.mockResolvedValue(avail(false, true));
    verify.mockResolvedValue(undefined);
    expect(await nativeAuth.authenticate()).toEqual({ ok: true });
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ allowedBiometryTypes: [7] }));
  });
  it("authenticate: reports a dismissed prompt as cancelled, a lockout as lockedOut", async () => {
    isAvailable.mockResolvedValue(avail(true));
    verify.mockRejectedValueOnce({ code: 16 });
    expect(await nativeAuth.authenticate()).toEqual({ ok: false, reason: "cancelled" });
    verify.mockRejectedValueOnce({ code: "2" });
    expect(await nativeAuth.authenticate()).toEqual({ ok: false, reason: "lockedOut" });
  });
  it("authenticateWithPin: asks for the device credential only", async () => {
    verify.mockResolvedValue(undefined);
    expect(await nativeAuth.authenticateWithPin!()).toEqual({ ok: true });
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ allowedBiometryTypes: [7] }));
  });
  it("enroll proves the person can pass the lock right now", async () => {
    isAvailable.mockResolvedValue(avail(true));
    verify.mockRejectedValue({ code: 10 });
    expect(await nativeAuth.enroll()).toEqual({ ok: false, reason: "failed" });
  });
});

describe("Web (WebAuthn) auth", () => {
  const create = vi.fn();
  const get = vi.fn();
  function setup(platformAuth: boolean | "missing") {
    create.mockReset();
    get.mockReset();
    if (platformAuth === "missing") vi.stubGlobal("PublicKeyCredential", undefined);
    else
      vi.stubGlobal("PublicKeyCredential", {
        isUserVerifyingPlatformAuthenticatorAvailable: async () => platformAuth,
      });
    vi.stubGlobal("navigator", { ...navigator, credentials: { create, get } });
  }
  afterEach(() => vi.unstubAllGlobals());

  it("check: unavailable without WebAuthn; 'no screen lock' without a platform authenticator", async () => {
    setup("missing");
    expect((await webAuthn.check()).reason).toBe("unavailable");
    setup(false);
    expect(await webAuthn.check()).toEqual({ available: false, reason: "noScreenLock" });
    setup(true);
    expect(await webAuthn.check()).toEqual({ available: true });
  });

  it("enroll: demands the device's own verification and returns a URL-safe credential id", async () => {
    setup(true);
    create.mockResolvedValue({ rawId: new Uint8Array([251, 255, 254, 1, 2]).buffer });
    const r = await webAuthn.enroll();
    expect(r).toEqual({ ok: true, credentialId: "-__-AQI" }); // base64url, no + / =
    const opts = create.mock.calls[0][0].publicKey;
    expect(opts.authenticatorSelection).toEqual(
      expect.objectContaining({ userVerification: "required", authenticatorAttachment: "platform" }),
    );
    expect(opts.challenge).toBeInstanceOf(Uint8Array);
    expect(opts.challenge.length).toBe(32);
  });
  it("enroll: a dismissed prompt is 'cancelled', not a crash", async () => {
    setup(true);
    create.mockRejectedValue(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    expect(await webAuthn.enroll()).toEqual({ ok: false, reason: "cancelled" });
  });

  it("authenticate: asks for the saved credential with required verification", async () => {
    setup(true);
    get.mockResolvedValue({ id: "x" });
    expect(await webAuthn.authenticate({ credentialId: "-__-AQI" })).toEqual({ ok: true });
    const opts = get.mock.calls[0][0].publicKey;
    expect(opts.userVerification).toBe("required");
    expect(Array.from(opts.allowCredentials[0].id)).toEqual([251, 255, 254, 1, 2]);
  });
  it("authenticate: without a saved credential it cannot succeed (never fails open)", async () => {
    setup(true);
    expect(await webAuthn.authenticate({})).toEqual({ ok: false, reason: "unavailable" });
    expect(await webAuthn.authenticate()).toEqual({ ok: false, reason: "unavailable" });
    expect(get).not.toHaveBeenCalled();
  });
  it("authenticate: a null result or an error is a failure, never a pass", async () => {
    setup(true);
    get.mockResolvedValueOnce(null);
    expect((await webAuthn.authenticate({ credentialId: "abc" })).ok).toBe(false);
    get.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    expect(await webAuthn.authenticate({ credentialId: "abc" })).toEqual({ ok: false, reason: "cancelled" });
    get.mockRejectedValueOnce(new Error("weird"));
    expect(await webAuthn.authenticate({ credentialId: "abc" })).toEqual({ ok: false, reason: "failed" });
  });
});

describe("getDeviceAuth", () => {
  it("uses the native prompt in the Android app and WebAuthn in the browser", () => {
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
    expect(getDeviceAuth().kind).toBe("native");
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(false);
    expect(getDeviceAuth().kind).toBe("webauthn");
  });
});
