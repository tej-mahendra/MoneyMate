import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { readFileSync } from "node:fs";

// Injects a strict Content-Security-Policy into the built index.html only —
// never into the dev server's. The app itself needs no external origins
// anywhere (all fonts/icons are self-hosted; the only fetch() is a
// same-origin request for the static version.json), so this is free
// defense-in-depth for the shipped app. It can't
// run in dev mode, though: Vite's React plugin injects the Fast Refresh
// preamble as an *inline* <script> into index.html's <head>, which a
// script-src without 'unsafe-inline' (correctly) blocks — that would silently
// break Hot Module Reload for anyone running `npm run dev`. `apply: 'build'`
// keeps this scoped to the production bundle only.
function cspPlugin(): Plugin {
  const csp =
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; ") + ";";

  return {
    name: "inject-csp-meta",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(
        '<meta name="theme-color" content="#14171A" />',
        `<meta name="theme-color" content="#14171A" />\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
      );
    },
  };
}

// Publishes `version.json` with every build. The page a person already has
// open fetches it when an update is waiting, to learn whether the new build
// changes how data is stored (the highest `this.version(N)` in db.ts) and so
// should prompt for a backup first. Only a static file is fetched — nothing
// from the person's data is ever sent.
function versionFilePlugin(): Plugin {
  return {
    name: "emit-version-json",
    apply: "build",
    generateBundle() {
      const src = readFileSync("src/db/db.ts", "utf8");
      const versions = [...src.matchAll(/this\.version\((\d+)\)/g)].map((m) => Number(m[1]));
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify({
          schemaVersion: versions.length ? Math.max(...versions) : 0,
          builtAt: new Date().toISOString(),
        }),
      });
    },
  };
}

export default defineConfig({
  base: "./",
  build: {
    // Vite's default modulePreload injects <link rel="modulepreload"> for
    // every chunk reachable in the import graph, including ones only ever
    // reached via a React.lazy() dynamic import() — which silently defeats
    // route-based code-splitting by having the browser fetch e.g. the
    // recharts-heavy Analytics chunk on every single page load regardless
    // of route. Disabling it restores real lazy loading: a lazy chunk is
    // only fetched when its route is actually visited.
    modulePreload: false,
    rollupOptions: {
      output: {
        // React.lazy() already splits each page into its own chunk; this
        // further separates rarely-changing framework code and the heaviest
        // single dependency (recharts, only used by Analytics) into their
        // own vendor chunks. That means a normal app update — most of which
        // only touch page/component code — invalidates a small chunk
        // instead of forcing a re-download of React/Dexie/recharts too,
        // since the browser (and the PWA's precache) can keep serving the
        // unchanged vendor chunks from cache across releases.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("recharts") || id.includes("d3-"))
            return "vendor-charts";
          if (id.includes("framer-motion")) return "vendor-motion";
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("react-router")
          ) {
            return "vendor-react";
          }
          if (id.includes("dexie")) return "vendor-dexie";
          return "vendor";
        },
      },
    },
  },
  plugins: [
    react(),
    cspPlugin(),
    versionFilePlugin(),
    VitePWA({
      // "prompt": a new version downloads in the background and WAITS until the
      // person taps Update (see UpdatePrompt). With "autoUpdate" it replaced
      // the files under the open page and broke screens that hadn't loaded yet.
      registerType: "prompt",
      // Registration is done in code (lib/pwaUpdate.ts), not by an injected script.
      injectRegister: false,
      includeAssets: [
        "icons/icon-192.png",
        "icons/icon-512.png",
        "icons/apple-touch-icon.png",
      ],
      manifest: {
        name: "Money Mate",
        short_name: "Money Mate",
        description:
          "A private, offline-first personal finance tracker. Your data never leaves your device.",
        theme_color: "#14171A",
        background_color: "#14171A",
        display: "standalone",
        orientation: "portrait",
        start_url: "./",
        scope: "./",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        // Serve the static privacy page as itself, not the app shell.
        navigateFallbackDenylist: [/^\/privacy\.html$/],
      },
    }),
  ],
});
