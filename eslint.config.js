// Flat ESLint config for the AudioServer monorepo.
// Runs across server (Node/Express + Drizzle) and client (React 19 + Vite).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

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
    plugins: { 'react-hooks': reactHooks },
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
