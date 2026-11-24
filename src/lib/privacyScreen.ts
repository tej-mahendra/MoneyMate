import { Capacitor } from "@capacitor/core";
import { PrivacyScreen } from "@capacitor-community/privacy-screen";

// "Privacy screen": keep the app's contents out of the recent-apps preview.
//  - Android app: the system flag that blanks the preview AND blocks
//    screenshots / screen recording while it is on.
//  - Web: a cover is shown as soon as the window loses focus or the page is
//    hidden. Browsers take the preview snapshot on their own schedule and a web
//    page cannot block it, so this is best-effort only; the Android app is the
//    only place it is guaranteed.

export async function setNativePrivacyScreen(on: boolean): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    if (on) await PrivacyScreen.enable();
    else await PrivacyScreen.disable();
  } catch {
    /* not available on this device — nothing to do */
  }
}

const STYLE_ID = "mm-privacy-cover";
const ATTR = "data-privacy-cover";

/** Installs the web cover; returns a function that removes it. The cover is
 *  toggled with a plain attribute on <html> so it applies in the same tick
 *  as the event, without waiting for React to render. */
export function installWebCover(): () => void {
  const root = document.documentElement;
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      html[${ATTR}] body > * { visibility: hidden !important; }
      html[${ATTR}] body { background: var(--void, #041412) !important; }`;
    document.head.appendChild(style);
  }
  const cover = () => root.setAttribute(ATTR, "");
  const uncover = () => root.removeAttribute(ATTR);
  const onVisibility = () => (document.hidden ? cover() : uncover());
  // The window loses focus BEFORE the page is reported hidden (opening the app
  // switcher, another window, the notification shade) — the earlier signal is
  // the one that can beat the system's preview snapshot.
  const onBlur = () => cover();
  const onFocus = () => {
    if (!document.hidden) uncover();
  };
  // Safety valve: if a focus event is ever missed the page must not stay
  // blank, so any tap or key press while it is visible clears the cover.
  const onInteract = () => {
    if (!document.hidden) uncover();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", cover);
  window.addEventListener("pageshow", uncover);
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", onFocus);
  window.addEventListener("pointerdown", onInteract, true);
  window.addEventListener("keydown", onInteract, true);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", cover);
    window.removeEventListener("pageshow", uncover);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("pointerdown", onInteract, true);
    window.removeEventListener("keydown", onInteract, true);
    uncover();
  };
}
