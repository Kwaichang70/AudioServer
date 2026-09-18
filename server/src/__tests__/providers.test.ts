import { describe, it, expect } from 'vitest';
import { LocalProvider } from '../providers/local.js';
import { TidalProvider } from '../providers/tidal.js';
import { SpotifyProvider } from '../providers/spotify.js';
import { QobuzProvider } from '../providers/qobuz.js';
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

// R00.5: these used to exercise `tidal-stub.ts` and `spotify-stub.ts`, two
// files the registry never loaded. The real providers are what runs, so the
// interface contract is checked against those instead.
describe('TidalProvider', () => {
  const provider = new TidalProvider();
  testProviderInterface(provider);

  it('type is "tidal"', () => {
    expect(provider.type).toBe('tidal');
  });

  it('needs credentials before it claims to be available', () => {
    expect(provider.isAvailable).toBe(
      !!(process.env.TIDAL_CLIENT_ID && process.env.TIDAL_CLIENT_SECRET),
    );
  });

  it('hands out no stream url without a logged-in account', async () => {
    expect(provider.auth.isAuthenticated).toBe(false);
    await expect(provider.getStreamUrl('tidal:1')).resolves.toBeNull();
  });
});

describe('SpotifyProvider', () => {
  const provider = new SpotifyProvider();
  testProviderInterface(provider);

  it('type is "spotify"', () => {
    expect(provider.type).toBe('spotify');
  });

  it('needs credentials before it claims to be available', () => {
    expect(provider.isAvailable).toBe(
      !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET),
    );
  });

  // Spotify has no direct stream url: playback goes through Connect or
  // Librespot. The playback resolver depends on this being null.
  it('never returns a stream url', async () => {
    await expect(provider.getStreamUrl('spotify:1')).resolves.toBeNull();
  });
});

describe('QobuzProvider', () => {
  const provider = new QobuzProvider();
  testProviderInterface(provider);

  it('type is "qobuz"', () => {
    expect(provider.type).toBe('qobuz');
  });

  it('exposes robust streaming status', () => {
    const status = provider.getStatus();
    expect(typeof status.streamingAvailable).toBe('boolean');
    expect(status.formatId).toBeTruthy();
  });
});
