// Flat ESLint config for the AudioServer monorepo.
// Runs across server (Node/Express + Drizzle) and client (React 19 + Vite).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/.vite/**',
      '**/coverage/**',
      '**/*.config.js',
      '**/*.config.ts',
      '**/vite.config.*',
      '**/vitest.config.*',
      // Service worker uses Worker globals (self, caches, Response, etc.)
      // It's plain JS and not subject to our TypeScript rules.
      'client/public/sw.js',
      // Same for the build-time template of the production worker (V08.1).
      'client/sw/sw.template.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Browser + Node mix (workspaces share this base)
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
      // Module-augmentation for Express's Request type uses `declare global { namespace Express { ... } }`
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
      'prefer-const': 'error',
      '@typescript-eslint/no-unused-expressions': [
        'error',
        { allowTernary: true, allowShortCircuit: true },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'off', // server uses console.log in startup
    },
  },
  {
    files: ['client/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        HTMLAudioElement: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        Image: 'readonly',
        Audio: 'readonly',
        MediaMetadata: 'readonly',
      },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      // Accessibility, as errors. These ran as warnings while a backlog was
      // worked off; it reached zero (T07), so a new violation now fails lint
      // instead of scrolling past.
      ...jsxA11y.flatConfigs.recommended.rules,
      'jsx-a11y/no-static-element-interactions': 'error',
      'jsx-a11y/click-events-have-key-events': 'error',
      'jsx-a11y/no-autofocus': 'error',
      // Image load failures are state/error handling, not user interaction.
      // Keep the rule focused on handlers that actually make an element
      // interactive so <img onError={...}> does not produce false positives.
      'jsx-a11y/no-noninteractive-element-interactions': [
        'error',
        {
          handlers: ['onClick', 'onMouseDown', 'onMouseUp', 'onKeyDown', 'onKeyUp', 'onKeyPress'],
        },
      ],
      'jsx-a11y/label-has-associated-control': 'error',
      'jsx-a11y/media-has-caption': 'off', // album art / audio streams have no captions
    },
  },
  {
    files: ['**/__tests__/**/*.ts', '**/__tests__/**/*.tsx', '**/*.test.ts', '**/*.test.tsx'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        vi: 'readonly',
      },
    },
  },
);
