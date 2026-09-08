import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * V03.4: the playback service must be importable on its own. Before V03 a
 * direct `import('services/playback.ts')` failed on the circular chain
 * playback → socketio → device-monitor → playback; events now go through an
 * injected sink and Socket.IO is never imported from the service.
 */
describe('playback service import order', () => {
  it('loads and works without socketio ever being imported', async () => {
    vi.resetModules();
    const loaded: string[] = [];
    vi.doMock('../socketio.js', () => {
      loaded.push('socketio');
      return {};
    });
    const tmp = mkdtempSync(join(tmpdir(), 'audioserver-import-order-'));
    try {
      const db = await import('../db/index.js');
      await db.initDatabase(join(tmp, 'test.db'));
      const { PlaybackService } = await import('../services/playback.js');
      const service = new PlaybackService();
      service.initialize();
      service.setQueue([{ id: 'a', title: 'A', artistName: 'x', albumTitle: 'y' }]);
      expect(service.getSnapshot().queue).toHaveLength(1);
      expect(loaded).toEqual([]); // socketio was never needed
      db.closeDatabase();
    } finally {
      vi.doUnmock('../socketio.js');
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
