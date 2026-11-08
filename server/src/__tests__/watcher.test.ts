import { describe, expect, it, vi } from 'vitest';
import { isLibraryChange, scanForChanges } from '../services/watcher.js';

/**
 * §6: the watcher also reacts to folders and cover pictures, not to
 * Synology's own bookkeeping, and a change during a running scan gets one
 * scan afterwards instead of being dropped.
 */
describe('library watcher', () => {
  it('cares about audio, covers and folders; not thumbnails, recycle bin or hidden files', () => {
    expect(isLibraryChange('Miles Davis/Kind of Blue/01.flac')).toBe(true);
    expect(isLibraryChange('Miles Davis/Kind of Blue/cover.jpg')).toBe(true);
    expect(isLibraryChange('Miles Davis/Kind of Blue (Remaster)')).toBe(true);
    expect(isLibraryChange('Album/@eaDir/01.flac/SYNOPHOTO_THUMB_M.jpg')).toBe(false);
    expect(isLibraryChange('#recycle/old.flac')).toBe(false);
    expect(isLibraryChange('Album/.DS_Store')).toBe(false);
    expect(isLibraryChange('Album/notes.txt')).toBe(false);
  });

  it('scans at once when idle', async () => {
    const scan = vi.fn(async () => {});
    await scanForChanges(scan, () => false, 1);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('runs one more scan after a busy one, however many changes came in', async () => {
    let busy = true;
    const scan = vi.fn(async () => {});
    const first = scanForChanges(scan, () => busy, 5);
    const second = scanForChanges(scan, () => busy, 5);
    await new Promise((r) => setTimeout(r, 20));
    expect(scan).not.toHaveBeenCalled();
    busy = false;
    await Promise.all([first, second]);
    expect(scan).toHaveBeenCalledTimes(1);
  });
});
