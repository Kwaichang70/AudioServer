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
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
      // Module-augmentation for Express's Request type uses `declare global { namespace Express { ... } }`
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
      'prefer-const': 'warn', // existing code has a few violations; fix incrementally
      '@typescript-eslint/no-unused-expressions': [
        'warn',
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
      'react-hooks/exhaustive-deps': 'warn',
      // Accessibility. The recommended set defaults to 'error'; we run it as
      // 'warn' so CI stays green while the backlog is worked through
      // incrementally (same policy as no-explicit-any / prefer-const here).
      // Promote individual rules to 'error' as their violations reach zero.
      ...jsxA11y.flatConfigs.recommended.rules,
      'jsx-a11y/no-static-element-interactions': 'warn',
      'jsx-a11y/click-events-have-key-events': 'warn',
      'jsx-a11y/no-autofocus': 'warn',
      // Image load failures are state/error handling, not user interaction.
      // Keep the rule focused on handlers that actually make an element
      // interactive so <img onError={...}> does not produce false positives.
      'jsx-a11y/no-noninteractive-element-interactions': [
        'warn',
        {
          handlers: ['onClick', 'onMouseDown', 'onMouseUp', 'onKeyDown', 'onKeyUp', 'onKeyPress'],
        },
      ],
      'jsx-a11y/label-has-associated-control': 'warn',
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
