import { create } from "zustand";

/** A new version has been downloaded and is waiting for the person to accept it. */
interface PwaUpdateState {
  ready: boolean;
  /** "Later" — hidden for this session; it returns on the next app start. */
  dismissed: boolean;
  setReady: () => void;
  dismiss: () => void;
}

export const usePwaUpdateStore = create<PwaUpdateState>((set) => ({
  ready: false,
  dismissed: false,
  setReady: () => set({ ready: true, dismissed: false }),
  dismiss: () => set({ dismissed: true }),
}));
