import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import LockGate from "./components/LockGate";
import { startPwaUpdates } from "./lib/pwaUpdate";
import { usePwaUpdateStore } from "./store/usePwaUpdateStore";
import { installGlobalErrorHandlers } from "./lib/globalErrors";
import {
  installStaleVersionRecovery,
  requestPersistentStorage,
} from "./lib/staleVersion";

// Self-hosted premium type system — no external font CDN calls, stays offline-first.
import "@fontsource-variable/fraunces";
import "@fontsource/plus-jakarta-sans/400.css";
import "@fontsource/plus-jakarta-sans/500.css";
import "@fontsource/plus-jakarta-sans/600.css";
import "@fontsource/plus-jakarta-sans/700.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";

import "./theme.css";

installGlobalErrorHandlers();
installStaleVersionRecovery();
void requestPersistentStorage();
startPwaUpdates(() => usePwaUpdateStore.getState().setReady());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <LockGate>
        <App />
      </LockGate>
    </ErrorBoundary>
  </StrictMode>,
);
