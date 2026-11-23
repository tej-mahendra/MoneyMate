import { useEffect, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { App as CapApp } from "@capacitor/app";
import { useLockStore } from "../store/useLockStore";
import { installWebCover, setNativePrivacyScreen } from "../lib/privacyScreen";
import LockScreen from "./LockScreen";

/** Wraps the whole app. While locked, the app is still mounted (so a half-filled
 *  form survives a trip to the lock screen) but hidden and non-interactive,
 *  and the lock screen covers it. */
export default function LockGate({ children }: { children: ReactNode }) {
  const locked = useLockStore((s) => s.locked);
  const privacyScreen = useLockStore((s) => s.config.privacyScreen);

  // Notice when the app leaves and returns to the foreground.
  useEffect(() => {
    const { noteHidden, noteVisible } = useLockStore.getState();
    const onVisibility = () => (document.hidden ? noteHidden() : noteVisible());
    document.addEventListener("visibilitychange", onVisibility);
    let removeNative: (() => void) | undefined;
    let disposed = false;
    if (Capacitor.isNativePlatform()) {
      // The Android app reports this more reliably than the WebView does.
      void CapApp.addListener("appStateChange", ({ isActive }) =>
        isActive ? noteVisible() : noteHidden(),
      ).then((h) => {
        if (disposed) void h.remove();
        else removeNative = () => void h.remove();
      });
    }
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      removeNative?.();
    };
  }, []);

  // Privacy screen: native flag on Android, a cover on the web.
  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      void setNativePrivacyScreen(privacyScreen);
      return;
    }
    return privacyScreen ? installWebCover() : undefined;
  }, [privacyScreen]);

  return (
    <>
      {/* display: contents keeps the app's layout exactly as if this wrapper
          weren't here; `inert` makes the hidden app unreachable. */}
      <div
        inert={locked}
        aria-hidden={locked}
        style={{ display: locked ? "none" : "contents" }}
      >
        {children}
      </div>
      {locked && <LockScreen />}
    </>
  );
}
