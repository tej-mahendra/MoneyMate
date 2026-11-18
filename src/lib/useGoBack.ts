import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/** Goes back one step in the app's own history, so Back never lands on a
 *  screen the person has already finished with (e.g. the edit form after
 *  saving). If this screen was opened directly — a link or a refresh, so
 *  there is nothing in the app to go back to — it goes to `fallback`
 *  instead, replacing the current entry so Back can't return here. */
export function useGoBack(fallback: string) {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(() => {
    // React Router gives the first entry of a session the key "default".
    if (location.key !== "default") navigate(-1);
    else navigate(fallback, { replace: true });
  }, [navigate, location.key, fallback]);
}
