import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  cacheEmbeddedCover,
  getLocalCoverPath,
  readCachedCover,
} from '../services/coverart-fetch.js';

describe('embedded cover disk cache', () => {
  let tmp: string | null = null;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'audioserver-covers-'));
    process.env.COVER_CACHE_DIR = tmp;
  });

  afterEach(() => {
    delete process.env.COVER_CACHE_DIR;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it('persists embedded cover art with the original mime type', () => {
    const saved = cacheEmbeddedCover('album-1', Buffer.from([1, 2, 3]), 'image/png');
    const cached = readCachedCover('album-1');

    expect(saved).toBe(true);
    expect(getLocalCoverPath('album-1')).toMatch(/album-1\.png$/);
    expect(cached).toEqual({ data: Buffer.from([1, 2, 3]), mime: 'image/png' });
  });

  it('does not overwrite an existing cached cover', () => {
    cacheEmbeddedCover('album-1', Buffer.from([1, 2, 3]), 'image/jpeg');

    expect(cacheEmbeddedCover('album-1', Buffer.from([4, 5, 6]), 'image/png')).toBe(false);
    expect(readCachedCover('album-1')).toEqual({
      data: Buffer.from([1, 2, 3]),
      mime: 'image/jpeg',
    });
  });
});
