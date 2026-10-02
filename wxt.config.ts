import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// Local Browser Backup & Restore — WXT + React + Tailwind + shadcn/ui.
// The manifest mirrors the original v1.3.0 manifest (same permissions, same
// fixed extension `key`, no popup — the toolbar action opens the dashboard).
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  manifest: {
    name: 'Local Browser Backup & Restore',
    description:
      'Backup & restore browser data locally or to GitHub, with encryption, daily or weekly scheduling, retry controls, and token-safe settings transfer. No server or telemetry.',
    // Fixed public key → deterministic extension ID (unchanged from v1.3.0).
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxhKDPmX6fK/uvUURPPLml69/taEphQKIt7MQFsHf1ZVjjvxWhFshfmt8DpiBtatjiun0e20A5iDsZgwW6WNvB+CpZV7ZNTrY2TRfoq5staq2ba0+WLThiyYIT07jJnG/6BUQz9Xn2zfLrCHdj2i7beXQ67MJPBp54KfxTimf3kSHw6bF28JgI0ltANhrz5rGvoPBliX7S10XVKCvPwyeZA/DqLjiFrJziZXl6ivySA+ASEwB/YF7a9CsEYXqXigiGeOWDlb/G6mvWnxZGLkoq3nwn0gi6xXkrnoWgncoBBcIdoVJx0P18fpF415QLhnnD7YDhb+vQsM4tIrgUrWCJwIDAQAB',
    minimum_chrome_version: '114',
    permissions: [
      'bookmarks',
      'history',
      'tabs',
      'tabGroups',
      'sessions',
      'cookies',
      'downloads',
      'readingList',
      'storage',
      'unlimitedStorage',
      'management',
      'scripting',
      'debugger',
      'alarms',
      'system.cpu'
    ],
    host_permissions: ['http://*/*', 'https://*/*'],
    icons: { 128: 'icon.png' },
    action: { default_title: 'Open Browser Backup dashboard', default_icon: 'icon.png' }
  },
  vite: () => ({
    plugins: [tailwindcss()]
  })
});
