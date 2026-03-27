import { describe, it, expect } from 'vitest';
import { LocalProvider } from '../providers/local.js';
import { TidalStubProvider } from '../providers/tidal-stub.js';
import { SpotifyStubProvider } from '../providers/spotify-stub.js';
import type { MusicProvider } from '@audioserver/shared';

function testProviderInterface(provider: MusicProvider) {
  it(`has correct type property`, () => {
    expect(['local', 'tidal', 'spotify', 'qobuz']).toContain(provider.type);
  });

  it(`has a name`, () => {
    expect(provider.name).toBeTruthy();
    expect(typeof provider.name).toBe('string');
  });

  it(`has isAvailable boolean`, () => {
    expect(typeof provider.isAvailable).toBe('boolean');
  });

  it(`has all required methods`, () => {
    expect(typeof provider.initialize).toBe('function');
    expect(typeof provider.dispose).toBe('function');
    expect(typeof provider.getArtists).toBe('function');
    expect(typeof provider.getArtist).toBe('function');
    expect(typeof provider.getAlbums).toBe('function');
    expect(typeof provider.getAlbum).toBe('function');
    expect(typeof provider.getAlbumTracks).toBe('function');
    expect(typeof provider.getArtistAlbums).toBe('function');
    expect(typeof provider.search).toBe('function');
    expect(typeof provider.getStreamUrl).toBe('function');
  });
}

describe('LocalProvider', () => {
  const provider = new LocalProvider();
  testProviderInterface(provider);

  it('type is "local"', () => {
    expect(provider.type).toBe('local');
  });

  it('is available by default', () => {
    expect(provider.isAvailable).toBe(true);
  });
});

describe('TidalStubProvider', () => {
  const provider = new TidalStubProvider();
  testProviderInterface(provider);

  it('type is "tidal"', () => {
    expect(provider.type).toBe('tidal');
  });

  it('is not available (stub)', () => {
    expect(provider.isAvailable).toBe(false);
  });

  it('auth is not authenticated', () => {
    expect(provider.auth.isAuthenticated).toBe(false);
  });

  it('search returns empty results', async () => {
    const results = await provider.search();
    expect(results.artists).toEqual([]);
    expect(results.albums).toEqual([]);
    expect(results.tracks).toEqual([]);
  });
});

describe('SpotifyStubProvider', () => {
  const provider = new SpotifyStubProvider();
  testProviderInterface(provider);

  it('type is "spotify"', () => {
    expect(provider.type).toBe('spotify');
  });

  it('is not available (stub)', () => {
    expect(provider.isAvailable).toBe(false);
  });

  it('getStreamUrl returns null', async () => {
    const url = await provider.getStreamUrl();
    expect(url).toBeNull();
  });
});
