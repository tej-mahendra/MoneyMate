import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { reloadForNewVersion } from "./staleVersion";

/** When a new version of the app has taken over in the background, switch to
 *  it at the person's NEXT screen change — not mid-form, and before the old
 *  page asks for a screen file that no longer exists on the server.
 *
 *  Why this is needed: a deploy replaces the app's files, and the new service
 *  worker takes control straight away, but the page already open is still the
 *  old version. Without this, the next tab you open can fail to load. Leaving
 *  a screen already discards that screen's state, so reloading then loses
 *  nothing the person wasn't about to leave. */
export function useUpdateOnNavigate(): void {
  const { pathname } = useLocation();
  const updateReady = useRef(false);
  const firstRender = useRef(true);

  useEffect(() => {
    const sw = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
    if (!sw) return;
    // Only an UPDATE counts. If nothing controlled this page when it loaded,
    // the first-ever install is "claiming" it, which is not a new version.
    const hadController = Boolean(sw.controller);
    const onChange = () => {
      if (hadController) updateReady.current = true;
    };
    sw.addEventListener("controllerchange", onChange);
    return () => sw.removeEventListener("controllerchange", onChange);
  }, []);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (updateReady.current) {
      updateReady.current = false;
      reloadForNewVersion();
    }
  }, [pathname]);
}
