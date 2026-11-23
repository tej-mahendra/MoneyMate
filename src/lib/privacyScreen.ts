import { Capacitor } from "@capacitor/core";
import { PrivacyScreen } from "@capacitor-community/privacy-screen";

// "Privacy screen": keep the app's contents out of the recent-apps preview.
//  - Android app: the system flag that blanks the preview AND blocks
//    screenshots / screen recording while it is on.
//  - Web: a cover is shown the moment the page is hidden. Browsers take the
//    preview snapshot on their own schedule, so this is best-effort only.

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
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", cover);
  window.addEventListener("pageshow", uncover);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", cover);
    window.removeEventListener("pageshow", uncover);
    uncover();
  };
}
