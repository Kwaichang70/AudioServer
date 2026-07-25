import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getRawDb, initDatabase } from '../db/index.js';
import { saveTokens } from '../services/tokenstore.js';
import { SpotifyProvider } from '../providers/spotify.js';
import { TidalProvider } from '../providers/tidal.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('external provider response contracts', () => {
  let tmp: string | null = null;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'audioserver-provider-contracts-'));
    await initDatabase(join(tmp, 'test.db'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    try {
      getRawDb().close();
    } catch {
      // ignore
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it('maps typed Spotify search resources to domain objects', async () => {
    vi.stubEnv('SPOTIFY_CLIENT_ID', 'spotify-client');
    vi.stubEnv('SPOTIFY_CLIENT_SECRET', 'spotify-secret');
    saveTokens('spotify', {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3_600_000,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          artists: {
            items: [null, { id: 'artist-1', name: 'Miles Davis', images: [{ url: 'artist.jpg' }] }],
          },
          albums: {
            items: [
              {
                id: 'album-1',
                name: 'Kind of Blue',
                artists: [{ id: 'artist-1', name: 'Miles Davis' }],
                release_date: '1959-08-17',
                images: [{ url: 'album.jpg' }],
                total_tracks: 5,
              },
            ],
          },
          tracks: {
            items: [
              {
                id: 'track-1',
                name: 'So What',
                artists: [{ id: 'artist-1', name: 'Miles Davis' }],
                album: { id: 'album-1', name: 'Kind of Blue' },
                duration_ms: 562_000,
              },
            ],
          },
          playlists: {
            items: [
              {
                id: 'playlist-1',
                name: 'Modal Jazz',
                tracks: { total: 12 },
                images: [{ url: 'playlist.jpg' }],
              },
            ],
          },
        }),
      ),
    );

    const provider = new SpotifyProvider();
    await provider.initialize();
    const results = await provider.search('Miles Davis');

    expect(results.artists[0]).toMatchObject({
      id: 'spotify:artist-1',
      name: 'Miles Davis',
      imageUrl: 'artist.jpg',
      source: 'spotify',
    });
    expect(results.albums[0]).toMatchObject({
      id: 'spotify:album-1',
      artistId: 'spotify:artist-1',
      year: 1959,
    });
    expect(results.tracks[0]).toMatchObject({
      id: 'spotify:track-1',
      albumId: 'spotify:album-1',
      duration: 562,
    });
    expect(results.playlists[0]).toMatchObject({
      id: 'spotify:playlist-1',
      trackCount: 12,
    });
    expect(results.artists).toHaveLength(1);
  });

  it('maps typed Tidal JSON:API album and track resources', async () => {
    vi.stubEnv('TIDAL_CLIENT_ID', 'tidal-client');
    vi.stubEnv('TIDAL_CLIENT_SECRET', 'tidal-secret');
    saveTokens('tidal', {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3_600_000,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            id: 'album-1',
            type: 'albums',
            attributes: {
              title: 'Blue Train',
              releaseDate: '1957-09-15',
              numberOfItems: 5,
            },
            relationships: {
              artists: { data: [{ id: 'artist-1', type: 'artists' }] },
              coverArt: { data: [{ id: 'art-1', type: 'artworks' }] },
            },
          },
          included: [
            {
              id: 'artist-1',
              type: 'artists',
              attributes: { name: 'John Coltrane' },
            },
            {
              id: 'art-1',
              type: 'artworks',
              attributes: {
                mediaType: 'IMAGE',
                files: [
                  { href: 'small.jpg', meta: { width: 160, height: 160 } },
                  { href: 'large.jpg', meta: { width: 640, height: 640 } },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: 'track-1',
              type: 'tracks',
              meta: { trackNumber: 2, volumeNumber: 1 },
            },
          ],
          included: [{ id: 'track-1', type: 'tracks', attributes: { title: 'Moment’s Notice' } }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: 'track-1',
              type: 'tracks',
              attributes: {
                title: 'Moment’s Notice',
                duration: 'PT9M8S',
              },
              relationships: {
                artists: { data: [{ id: 'artist-1', type: 'artists' }] },
                albums: { data: [{ id: 'album-1', type: 'albums' }] },
              },
            },
          ],
          included: [
            { id: 'artist-1', type: 'artists', attributes: { name: 'John Coltrane' } },
            { id: 'album-1', type: 'albums', attributes: { title: 'Blue Train' } },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new TidalProvider();
    await provider.initialize();

    await expect(provider.getAlbum('tidal:album-1')).resolves.toMatchObject({
      id: 'tidal:album-1',
      title: 'Blue Train',
      artistId: 'tidal:artist-1',
      artistName: 'John Coltrane',
      year: 1957,
      coverUrl: 'large.jpg',
    });
    const tracks = await provider.getAlbumTracks('tidal:album-1');
    expect(tracks).toEqual([
      expect.objectContaining({
        id: 'tidal:track-1',
        title: 'Moment’s Notice',
        artistName: 'John Coltrane',
        albumId: 'tidal:album-1',
        albumTitle: 'Blue Train',
        trackNumber: 2,
        duration: 548,
      }),
    ]);
    expect(Number.isFinite(tracks[0].duration)).toBe(true);
  });

  it('loads Tidal artist albums through the JSON:API relationship document', async () => {
    vi.stubEnv('TIDAL_CLIENT_ID', 'tidal-client');
    vi.stubEnv('TIDAL_CLIENT_SECRET', 'tidal-secret');
    saveTokens('tidal', {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3_600_000,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'album-1', type: 'albums' }] }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: 'album-1',
              type: 'albums',
              attributes: {
                title: 'Blue Train',
                releaseDate: '1957-09-15',
              },
              relationships: {
                artists: { data: [{ id: 'artist-1', type: 'artists' }] },
                coverArt: { data: [{ id: 'art-1', type: 'artworks' }] },
              },
            },
          ],
          included: [
            { id: 'artist-1', type: 'artists', attributes: { name: 'John Coltrane' } },
            {
              id: 'art-1',
              type: 'artworks',
              attributes: {
                mediaType: 'IMAGE',
                files: [{ href: 'cover.jpg', meta: { width: 640, height: 640 } }],
              },
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new TidalProvider();
    await provider.initialize();

    await expect(provider.getArtistAlbums('tidal:artist-1')).resolves.toEqual([
      expect.objectContaining({
        id: 'tidal:album-1',
        title: 'Blue Train',
        artistName: 'John Coltrane',
        coverUrl: 'cover.jpg',
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        '/artists/artist-1/relationships/albums?include=albums&page[limit]=50',
      ),
      expect.any(Object),
    );
  });

  it('hydrates Tidal search relationships for artist, album, artwork, and track metadata', async () => {
    vi.stubEnv('TIDAL_CLIENT_ID', 'tidal-client');
    vi.stubEnv('TIDAL_CLIENT_SECRET', 'tidal-secret');
    saveTokens('tidal', {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3_600_000,
    });

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/relationships/artists')) {
        return jsonResponse({ data: [{ id: 'artist-1', type: 'artists' }] });
      }
      if (url.includes('/relationships/albums')) {
        return jsonResponse({ data: [{ id: 'album-1', type: 'albums' }] });
      }
      if (url.includes('/relationships/tracks')) {
        return jsonResponse({ data: [{ id: 'track-1', type: 'tracks' }] });
      }
      if (url.includes('/artists?')) {
        return jsonResponse({
          data: [
            {
              id: 'artist-1',
              type: 'artists',
              attributes: { name: 'John Coltrane' },
              relationships: { profileArt: { data: [{ id: 'profile-1', type: 'artworks' }] } },
            },
          ],
          included: [
            {
              id: 'profile-1',
              type: 'artworks',
              attributes: {
                mediaType: 'IMAGE',
                files: [{ href: 'profile.jpg', meta: { width: 640, height: 640 } }],
              },
            },
          ],
        });
      }
      if (url.includes('/albums?')) {
        return jsonResponse({
          data: [
            {
              id: 'album-1',
              type: 'albums',
              attributes: { title: 'Blue Train', releaseDate: '1957-09-15' },
              relationships: {
                artists: { data: [{ id: 'artist-1', type: 'artists' }] },
                coverArt: { data: [{ id: 'cover-1', type: 'artworks' }] },
              },
            },
          ],
          included: [
            { id: 'artist-1', type: 'artists', attributes: { name: 'John Coltrane' } },
            {
              id: 'cover-1',
              type: 'artworks',
              attributes: {
                mediaType: 'IMAGE',
                files: [{ href: 'cover.jpg', meta: { width: 640, height: 640 } }],
              },
            },
          ],
        });
      }
      if (url.includes('/tracks?')) {
        return jsonResponse({
          data: [
            {
              id: 'track-1',
              type: 'tracks',
              attributes: { title: 'Moment’s Notice', duration: 'PT9M8S' },
              relationships: {
                artists: { data: [{ id: 'artist-1', type: 'artists' }] },
                albums: { data: [{ id: 'album-1', type: 'albums' }] },
              },
            },
          ],
          included: [
            { id: 'artist-1', type: 'artists', attributes: { name: 'John Coltrane' } },
            { id: 'album-1', type: 'albums', attributes: { title: 'Blue Train' } },
          ],
        });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new TidalProvider();
    await provider.initialize();
    const results = await provider.search('blue train');

    expect(results.artists[0]).toMatchObject({
      name: 'John Coltrane',
      imageUrl: 'profile.jpg',
    });
    expect(results.albums[0]).toMatchObject({
      title: 'Blue Train',
      artistName: 'John Coltrane',
      coverUrl: 'cover.jpg',
    });
    expect(results.tracks[0]).toMatchObject({
      title: 'Moment’s Notice',
      artistName: 'John Coltrane',
      albumTitle: 'Blue Train',
      duration: 548,
    });
  });
});
