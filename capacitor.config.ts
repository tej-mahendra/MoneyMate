import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.pfos.app',
  appName: 'Money Mate',
  webDir: 'dist',
  plugins: {
    // Off at startup; the app switches it on/off from its Security setting
    // (the plugin's default would block screenshots all the time).
    PrivacyScreen: { enable: false },
  },
};

export default config;
