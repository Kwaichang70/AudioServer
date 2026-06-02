/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, extname, join } from 'node:path';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPRESSED_ASSET_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.svg']);
const MIN_COMPRESS_SIZE_BYTES = 1024;

export default defineConfig({
  plugins: [react(), compressedAssetsPlugin()],
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
