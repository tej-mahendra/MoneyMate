// Stand-in for the module vite-plugin-pwa generates at build time, so code
// that imports "virtual:pwa-register" can be loaded under Vitest. Tests that
// care about registration mock it explicitly.
export function registerSW(): (reloadPage?: boolean) => Promise<void> {
  return async () => {};
}
