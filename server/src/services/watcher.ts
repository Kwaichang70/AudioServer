import { watch, type FSWatcher } from 'fs';
import { extname } from 'path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getScanStatus, scanLibrary } from './scanner.js';

const SUPPORTED_EXTENSIONS = new Set([
  '.flac',
  '.mp3',
  '.m4a',
  '.aac',
  '.ogg',
  '.opus',
  '.wav',
  '.wma',
  '.aiff',
]);

/** Pictures next to the music: a new cover.jpg is worth a scan too (§6). */
const COVER_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

let watchers: FSWatcher[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 5000; // Wait 5s after last change before scanning

/**
 * Does this change matter to the library? Audio files and cover pictures do,
 * and so does a name without an extension — usually a folder that was moved
 * or renamed, which changes nothing per file the watcher hears about.
 */
export function isLibraryChange(filename: string): boolean {
  // Synology's thumbnail folders, its recycle bin and hidden files are not music.
  if (/(^|[\\/])(@eaDir|#recycle|\.)/.test(filename)) return false;
  const base = filename.split(/[\\/]/).pop() ?? '';
  if (!base) return false;
  const ext = extname(base).toLowerCase();
  return ext === '' || SUPPORTED_EXTENSIONS.has(ext) || COVER_EXTENSIONS.has(ext);
}

/**
 * Scan for what changed. A change during a running scan is not lost: that
 * scan may already be past the folder, so one more scan follows when it ends
 * (§6) — however many changes arrive meanwhile, one follow-up.
 */
let waitingForScan = false;
export async function scanForChanges(
  scan: () => Promise<unknown> = () =>
    scanLibrary(config.musicLibraryPaths, { trigger: 'watcher' }),
  busy: () => boolean = () => getScanStatus().isScanning,
  pollMs = 2000,
): Promise<void> {
  if (!busy()) {
    await scan();
    return;
  }
  if (waitingForScan) return;
  waitingForScan = true;
  try {
    while (busy()) await new Promise((r) => setTimeout(r, pollMs));
  } finally {
    waitingForScan = false;
  }
  await scan();
}

export function startWatcher(): void {
  if (process.env.WATCH_LIBRARY !== 'true') return;

  for (const libPath of config.musicLibraryPaths) {
    try {
      const watcher = watch(libPath, { recursive: true }, (event, filename) => {
        if (!filename || !isLibraryChange(String(filename))) return;

        logger.debug(`File ${event}: ${filename}`);

        // Debounce: wait 5s after last change before scanning
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          logger.info('Watcher: changes detected, starting incremental scan...');
          scanForChanges().catch((err) => logger.error(`Watcher: scan crashed: ${err}`));
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
