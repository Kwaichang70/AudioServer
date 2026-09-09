/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, extname, join } from 'node:path';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPRESSED_ASSET_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.svg']);
const MIN_COMPRESS_SIZE_BYTES = 1024;

/** Build id shown in the app and baked into the service worker (V08.1). */
function resolveBuildId(): string {
  if (process.env.VITE_BUILD_ID && process.env.VITE_BUILD_ID !== 'unknown') {
    return process.env.VITE_BUILD_ID;
  }
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return `local-${Date.now().toString(36)}`;
  }
}
const BUILD_ID = resolveBuildId();

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [react(), serviceWorkerPlugin(), compressedAssetsPlugin()],
  resolve: {
    alias: {
      // Resolve @audioserver/shared directly to its source. Avoids relying on
      // npm workspace symlinks (which behave unreliably in some Docker builds)
      // and on shared/dist being present at bundle time.
      '@audioserver/shared': resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
});

/**
 * Writes dist/sw.js from client/sw/sw.template.js with this build's id and
 * the exact list of files to precache: index.html, the hashed assets Vite
 * emitted, and the static shell files. Runs before the compression plugin so
 * sw.js gets .gz/.br too. Dev serves client/public/sw.js (network only).
 */
function serviceWorkerPlugin(): Plugin {
  const emitted: string[] = [];
  return {
    name: 'audioserver-service-worker',
    apply: 'build',
    enforce: 'pre',
    generateBundle(_options, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (fileName === 'sw.js') continue;
        if (/\.(js|css)$/.test(fileName) || chunk.type === 'chunk') emitted.push(`/${fileName}`);
      }
    },
    async closeBundle() {
      const template = await readFile(resolve(__dirname, 'sw/sw.template.js'), 'utf8');
      const precache = Array.from(
        new Set([
          '/index.html',
          '/offline.html',
          '/manifest.json',
          '/icon-192.svg',
          '/icon-512.svg',
          ...emitted,
        ]),
      );
      const output = template
        .replace('__BUILD_ID__', BUILD_ID)
        .replace('__PRECACHE__', JSON.stringify(precache));
      await writeFile(resolve(__dirname, 'dist/sw.js'), output);
    },
  };
}

function compressedAssetsPlugin(): Plugin {
  return {
    name: 'audioserver-compressed-assets',
    apply: 'build',
    async closeBundle() {
      const outDir = resolve(__dirname, 'dist');
      const files = await listBuildAssets(outDir);

      await Promise.all(
        files.map(async (file) => {
          if (!COMPRESSED_ASSET_EXTENSIONS.has(extname(file))) return;

          const input = await readFile(file);
          if (input.length < MIN_COMPRESS_SIZE_BYTES) return;

          await Promise.all([
            writeFile(`${file}.gz`, gzipSync(input, { level: 9 })),
            writeFile(
              `${file}.br`,
              brotliCompressSync(input, {
                params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
              }),
            ),
          ]);
        }),
      );
    },
  };
}

async function listBuildAssets(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? listBuildAssets(path) : [path];
    }),
  );
  return files.flat();
}
