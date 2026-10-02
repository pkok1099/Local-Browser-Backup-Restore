// ESLint — strict config for browser-backup-extension.
// Type-aware linting via typescript-eslint (requires TS 5.x; TS 7.0 is not
// supported by typescript-eslint, so the project uses TS 5.9.2).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  js.configs.recommended,
  // Note: We do NOT use recommendedTypeChecked/strictTypeChecked presets because
  // they flag `any` in JS files without JSDoc. We enable only the 4 requested
  // type-aware rules manually below.
  {
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
  },
  importPlugin.flatConfigs.recommended,
  prettierConfig,

  {
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        chrome: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        indexedDB: 'readonly',
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        crypto: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        Blob: 'readonly',
        CompressionStream: 'readonly',
        DecompressionStream: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        FormData: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        location: 'readonly',
        history: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        caches: 'readonly',
        __BBR: 'writable', // page-injected pagelib namespace
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // ===== Initialization and cycles (TDZ bug) =====
      // functions: false — function declarations are hoisted, so there is NO
      // TDZ risk. The "Cannot access 'A' before initialization" bug was caused
      // by let/const (stats), not functions. Requiring functions:true forces
      // major refactoring of safe code (e.g., haltCrawl referenced in a
      // callback before its declaration line, but invoked after init).
      // classes, variables: true — let/const/class are NOT hoisted; this is
      // where the real TDZ risk lives.
      'no-use-before-define': ['error', {
        functions: false,
        classes: true,
        variables: true,
        allowNamedExports: false,
      }],
      'import/no-cycle': ['error', { maxDepth: Infinity }],
      'import/no-self-import': 'error',
      'import/no-useless-path-segments': 'error',
      'import/first': 'error',
      'import/no-duplicates': 'error',

      // ===== Promise and async (type-aware) =====
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      'require-await': 'off', // use TS version
      'no-async-promise-executor': 'error',
      'no-await-in-loop': 'off', // sequential awaits are intentional in places
      'prefer-promise-reject-errors': 'error',

      // ===== Type safety: disable unsafe-* (JS files lack JSDoc types) =====
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-enum-comparison': 'off',
      '@typescript-eslint/restrict-plus-operands': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',

      // ===== Cleanliness =====
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-empty-function': 'error',
      'no-unused-vars': 'off', // use TS version
      '@typescript-eslint/no-unused-vars': ['error', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none', // allow unused catch params (common for benign ignores)
      }],
      'no-shadow': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'eqeqeq': ['error', 'always'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-throw-literal': 'error',
      'no-param-reassign': 'error',
      'no-return-assign': 'error',
      'no-self-compare': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': 'error',
      'no-loss-of-precision': 'error',
      'no-unsafe-optional-chaining': 'error',
      // require-atomic-updates: OFF — the rule flags safe single-threaded patterns
      // (e.g., module-level cache assignment after await). This codebase has no
      // shared-memory concurrency; the flagged cases are false positives.
      'require-atomic-updates': 'off',
      'no-redeclare': 'error',
      'no-undef': 'error',

      // ===== Complexity =====
      // Limit 25 for new code. Existing high-complexity functions are TECH DEBT
      // (listed below with explicit per-function exceptions). Refactoring them
      // risks behavior changes; they are documented, not ignored.
      // Tech debt (complexity > 25):
      //   - runCloudBackup (77): src/lib/cloud.js
      //   - collectSiteData (65): src/lib/sitedata.js
      //   - runProbes (43): src/lib/capabilities.js
      //   - restoreTabsWindows (37): src/lib/restore.js
      //   - restoreCookies (33): src/lib/restore.js
      //   - restoreSiteData (32): src/lib/sitedata.js
      //   - openOne (30): src/lib/sitedata.js
      //   - validateSettingsConfig (27): src/lib/validate.js
      'complexity': ['error', 25],
      'max-depth': ['error', 6],
      'max-params': ['error', 5],

      // ===== Project-specific: tab safety =====
      // chrome.tabs.remove is ONLY allowed inside safeCloseTab (marked SAFETY-ALLOWED).
      // The static test tests/no-raw-tab-remove.mjs enforces this; this rule is a second layer.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.object.name='chrome'][callee.object.property.name='tabs'][callee.property.name='remove']",
          message: 'chrome.tabs.remove is forbidden outside safeCloseTab. Use ownership.safeCloseTab().',
        },
        {
          selector: "CallExpression[callee.object.object.name='browser'][callee.object.property.name='tabs'][callee.property.name='remove']",
          message: 'browser.tabs.remove is forbidden outside safeCloseTab.',
        },
        {
          selector: "CallExpression[callee.object.object.name='chrome'][callee.object.property.name='windows'][callee.property.name='remove']",
          message: 'chrome.windows.remove is forbidden.',
        },
      ],

      // ===== Project-specific: logging =====
      'no-console': 'error',

      // ===== Project-specific: XSS / MV3 =====
      'no-restricted-properties': [
        'error',
        {
          property: 'innerHTML',
          message: 'innerHTML is forbidden (XSS). Use safe DOM APIs.',
        },
        {
          property: 'outerHTML',
          message: 'outerHTML is forbidden (XSS). Use safe DOM APIs.',
        },
      ],
    },
  },

  // Override: the log() implementation itself may use console.
  {
    files: ['src/lib/site-log.js'],
    rules: {
      'no-console': 'off',
    },
  },

  // Override: sitedata.js contains the ONLY allowed chrome.tabs.remove calls,
  // both inside safeCloseTab and marked SAFETY-ALLOWED. The precise enforcement
  // is tests/no-raw-tab-remove.mjs (checks the marker); ESLint's AST selector
  // cannot distinguish, so we disable the syntax rule here and rely on the test.
  {
    files: ['src/lib/sitedata.js'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },

  // Test files: relaxed.
  {
    files: ['tests/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      'complexity': 'off',
      'max-depth': 'off',
    },
  },
);
