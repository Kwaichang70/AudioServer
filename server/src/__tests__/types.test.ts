import { describe, it, expect } from 'vitest';
import type { Track, Album, Artist, SearchResults, NowPlaying, OutputDevice, DeviceController } from '@audioserver/shared';

describe('Shared types compile-time contracts', () => {
  it('Track has all required fields', () => {
    const track: Track = {
      id: '1',
      title: 'Test Track',
      albumId: 'a1',
      albumTitle: 'Test Album',
      artistId: 'ar1',
      artistName: 'Test Artist',
      source: 'local',
    };
    expect(track.id).toBe('1');
    expect(track.source).toBe('local');
  });

  it('Album has all required fields', () => {
    const album: Album = {
      id: 'a1',
      title: 'Test Album',
      artistId: 'ar1',
      artistName: 'Test Artist',
      source: 'tidal',
    };
    expect(album.source).toBe('tidal');
  });

  it('NowPlaying has correct defaults', () => {
    const np: NowPlaying = {
      track: null,
      state: 'stopped',
      position: 0,
      duration: 0,
      volume: 50,
      deviceId: null,
    };
    expect(np.state).toBe('stopped');
    expect(np.track).toBeNull();
  });

  it('SearchResults contains all entity arrays', () => {
    const results: SearchResults = {
      artists: [],
      albums: [],
      tracks: [],
      playlists: [],
    };
    expect(results.artists).toBeInstanceOf(Array);
    expect(results.playlists).toBeInstanceOf(Array);
  });

  it('OutputDevice has required fields', () => {
    const device: OutputDevice = {
      id: 'test',
      name: 'Test Device',
      type: 'dlna',
      isOnline: true,
    };
    expect(device.type).toBe('dlna');
  });

  it('ProviderType is union of valid sources', () => {
    const sources: Track['source'][] = ['local', 'tidal', 'spotify', 'qobuz'];
    expect(sources).toHaveLength(4);
  });
});
