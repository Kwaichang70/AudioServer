import { describe, expect, it } from 'vitest';
import type { Album, Artist, ProviderType, SearchResults, Track } from '@audioserver/shared';
import {
  deduplicateProviderItems,
  deduplicateSearchResults,
  editionKey,
  normalizeSearchKey,
  splitTitleVersion,
} from '../providers/registry.js';

function artist(name: string, source: ProviderType): Artist {
  return { id: `${source}-${name}`, name, source };
}

function album(title: string, artistName: string, source: ProviderType): Album {
  return {
    id: `${source}-${artistName}-${title}`,
    title,
    artistId: `${source}-${artistName}`,
    artistName,
    source,
  };
}

function track(
  title: string,
  artistName: string,
  source: ProviderType,
  extra: Partial<Track> = {},
): Track {
  return {
    id: `${source}-${artistName}-${title}`,
    title,
    albumId: `${source}-album`,
    albumTitle: 'Album',
    artistId: `${source}-${artistName}`,
    artistName,
    source,
    ...extra,
  };
}

describe('search keys (V07.1)', () => {
  it('normalizes punctuation, accents, whitespace and case', () => {
    expect(normalizeSearchKey('  Café   del  Mar ', 'Don’t Stop')).toBe('cafe del mar|dont stop');
  });

  it('keeps letters of every script, so different non-Latin names stay different', () => {
    const a = normalizeSearchKey('宇多田ヒカル', 'First Love');
    const b = normalizeSearchKey('椎名林檎', 'First Love');
    expect(a).not.toBe(b);
    expect(a).not.toBe('|first love');
    expect(normalizeSearchKey('Пётр Чайковский')).toBe('петр чаиковскии');
  });

  it('splits an edition label off the title', () => {
    expect(splitTitleVersion('One (Live)')).toEqual({ base: 'One', version: 'Live' });
    expect(splitTitleVersion('Song [2011 Remaster]')).toEqual({
      base: 'Song',
      version: '2011 Remaster',
    });
    expect(splitTitleVersion('Track - Radio Edit')).toEqual({
      base: 'Track',
      version: 'Radio Edit',
    });
    expect(splitTitleVersion('Blue (In Green)')).toEqual({ base: 'Blue (In Green)' });
    expect(splitTitleVersion('Everything In Its Right Place')).toEqual({
      base: 'Everything In Its Right Place',
    });
  });

  it('edition keys ignore word order and spelling of remaster', () => {
    expect(editionKey('Remastered 2011')).toBe(editionKey('2011 Remaster'));
    expect(editionKey('Live')).not.toBe(editionKey('Live Acoustic'));
    expect(editionKey(undefined)).toBe('');
  });
});

describe('provider search deduplication', () => {
  it('keeps local over streaming providers and records availability and alternatives', () => {
    const result = deduplicateProviderItems(
      [artist('Prince', 'spotify'), artist('Prince', 'qobuz'), artist('Prince', 'local')],
      (item) => normalizeSearchKey(item.name),
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      source: 'local',
      availableOn: ['local', 'qobuz', 'spotify'],
    });
    expect(result[0].alternatives?.map((a) => [a.source, a.id])).toEqual([
      ['local', 'local-Prince'],
      ['qobuz', 'qobuz-Prince'],
      ['spotify', 'spotify-Prince'],
    ]);
  });

  it('prefers qobuz over tidal and spotify when local is absent', () => {
    const result = deduplicateProviderItems(
      [
        track('So What', 'Miles Davis', 'spotify'),
        track('So What', 'Miles Davis', 'tidal'),
        track('So What', 'Miles Davis', 'qobuz'),
      ],
      (item) => normalizeSearchKey(item.artistName, item.title),
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      source: 'qobuz',
      availableOn: ['qobuz', 'tidal', 'spotify'],
    });
  });

  it('deduplicates albums by artist and title', () => {
    const result = deduplicateSearchResults({
      artists: [],
      albums: [
        album('Kind of Blue', 'Miles Davis', 'spotify'),
        album('Kind of Blue', 'Miles Davis', 'qobuz'),
        album('Bitches Brew', 'Miles Davis', 'spotify'),
      ],
      tracks: [],
      playlists: [],
    });

    expect(result.albums).toHaveLength(2);
    expect(result.albums.find((item) => item.title === 'Kind of Blue')).toMatchObject({
      source: 'qobuz',
      availableOn: ['qobuz', 'spotify'],
    });
  });

  it('deduplicates tracks while preserving unique tracks', () => {
    const input: SearchResults = {
      artists: [],
      albums: [],
      tracks: [
        track('Where The Streets Have No Name', 'U2', 'local'),
        track('Where the Streets Have No Name', 'U2', 'qobuz'),
        track('One', 'U2', 'qobuz'),
      ],
      playlists: [],
    };

    const result = deduplicateSearchResults(input);

    expect(result.tracks).toHaveLength(2);
    expect(result.tracks[0]).toMatchObject({
      source: 'local',
      availableOn: ['local', 'qobuz'],
    });
  });

  it('keeps studio, live and remastered versions apart, whether labelled in the title or by the source', () => {
    const result = deduplicateSearchResults({
      artists: [],
      albums: [],
      tracks: [
        track('One', 'U2', 'local', { duration: 276 }),
        track('One (Live)', 'U2', 'qobuz', { duration: 300 }),
        track('One', 'U2', 'tidal', { duration: 276, version: 'Remastered 2011' }),
        track('One', 'U2', 'spotify', { duration: 277 }),
      ],
      playlists: [],
    });

    expect(result.tracks.map((t) => [t.source, t.version ?? null, t.availableOn])).toEqual([
      ['local', null, ['local', 'spotify']],
      ['qobuz', 'Live', ['qobuz']],
      ['tidal', 'Remastered 2011', ['tidal']],
    ]);
  });

  it('treats a clearly different duration as a different recording', () => {
    const result = deduplicateSearchResults({
      artists: [],
      albums: [],
      tracks: [
        track('Blue', 'Joni', 'qobuz', { duration: 180 }),
        track('Blue', 'Joni', 'spotify', { duration: 420 }),
        track('Blue', 'Joni', 'tidal', { duration: 185 }),
      ],
      playlists: [],
    });
    expect(result.tracks.map((t) => [t.source, t.availableOn])).toEqual([
      ['qobuz', ['qobuz', 'tidal']],
      ['spotify', ['spotify']],
    ]);
  });

  it('merges when one side has no duration', () => {
    const result = deduplicateSearchResults({
      artists: [],
      albums: [],
      tracks: [track('Blue', 'Joni', 'local'), track('Blue', 'Joni', 'qobuz', { duration: 200 })],
      playlists: [],
    });
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0].alternatives?.map((a) => a.source)).toEqual(['local', 'qobuz']);
  });

  it('handles empty input', () => {
    const result = deduplicateProviderItems(
      [] as Array<{ id: string; name: string; source: ProviderType }>,
      (item) => item.name,
    );

    expect(result).toEqual([]);
  });
});
