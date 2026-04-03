import { watch, type FSWatcher } from 'fs';
import { extname } from 'path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { scanLibrary } from './scanner.js';

const SUPPORTED_EXTENSIONS = new Set([
  '.flac', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.wma', '.aiff',
]);

let watchers: FSWatcher[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 5000; // Wait 5s after last change before scanning

export function startWatcher(): void {
  if (process.env.WATCH_LIBRARY !== 'true') return;

  for (const libPath of config.musicLibraryPaths) {
    try {
      const watcher = watch(libPath, { recursive: true }, (event, filename) => {
        if (!filename) return;
        const ext = extname(filename).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(ext)) return;

        logger.debug(`File ${event}: ${filename}`);

        // Debounce: wait 5s after last change before scanning
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          logger.info('Watcher: changes detected, starting incremental scan...');
          scanLibrary(config.musicLibraryPaths);
        }, DEBOUNCE_MS);
      });

      watchers.push(watcher);
      logger.info(`Watcher: monitoring ${libPath}`);
    } catch (err) {
      logger.warn(`Watcher: failed to watch ${libPath}: ${err}`);
    }
  }
}

export function stopWatcher(): void {
  for (const watcher of watchers) {
    watcher.close();
  }
  watchers = [];
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
