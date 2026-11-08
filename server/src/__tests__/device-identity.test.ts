import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTrackUri } from '../devices/dlna.js';
import { DeviceManager, DeviceUnavailableError } from '../devices/manager.js';
import { judgeRestart } from '../services/server-player.js';
import { noteSeek } from '../services/seek-log.js';

/**
 * ANALYSE_EN_VERBETERPLAN B02 and §6: what a renderer says it plays tells a
 * seek from a new track, and a speaker the server cannot find is a failure,
 * not a quiet success.
 */
describe('the URL a renderer reports', () => {
  it('is read from GetPositionInfo, entities decoded', () => {
    const xml =
      '<RelTime>0:00:03</RelTime><TrackURI>http://nas:3001/api/library/tracks/a/stream?t=x&amp;zone=wk</TrackURI>';
    expect(parseTrackUri(xml)).toBe('http://nas:3001/api/library/tracks/a/stream?t=x&zone=wk');
    expect(parseTrackUri('<TrackURI></TrackURI>')).toBeUndefined();
    expect(parseTrackUri('<RelTime>0:00:03</RelTime>')).toBeUndefined();
  });
});

describe('judging a restart at 0:00', () => {
  const zone = {
    playingUrl: 'http://nas/stream/a?t=1',
    armed: { itemId: 'b', trackId: 'b', at: 0, url: 'http://nas/stream/b?t=2' },
  };

  it('follows the URL when the device reports one, whatever host it shows', () => {
    expect(judgeRestart(zone, 'dev-1', 'http://192.168.2.58:3001/stream/b?t=2')).toBe('advanced');
    expect(judgeRestart(zone, 'dev-1', 'http://nas/stream/a?t=1')).toBe('seek');
  });

  it('falls back to the server’s own recent seek when the URLs cannot tell', () => {
    // Same track armed again (repeat one): the URL says nothing.
    const same = { ...zone, armed: { ...zone.armed, url: zone.playingUrl } };
    expect(judgeRestart(same, 'dev-2', zone.playingUrl)).toBe('advanced');
    noteSeek('dev-3');
    expect(judgeRestart(same, 'dev-3', zone.playingUrl)).toBe('seek');
    expect(judgeRestart(zone, 'dev-3', undefined)).toBe('seek');
  });
});

describe('a speaker the server cannot find', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is searched for once, then reported, instead of "played" silently', async () => {
    const manager = new DeviceManager();
    const discover = vi.spyOn(manager, 'getDevices').mockResolvedValue([]);
    await expect(manager.play('sonos:gone', 'http://nas/stream/a')).rejects.toBeInstanceOf(
      DeviceUnavailableError,
    );
    await expect(manager.setNextUri('sonos:gone', 'http://nas/stream/b')).rejects.toBeInstanceOf(
      DeviceUnavailableError,
    );
    expect(discover).toHaveBeenCalledWith(true);
    // The browser is not a network device: nothing to find, nothing to fail.
    await expect(manager.play('browser', 'x')).resolves.toBeUndefined();
  });
});
