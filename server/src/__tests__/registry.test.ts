import { describe, expect, it } from 'vitest';
import type { Album, Artist, ProviderType, SearchResults, Track } from '@audioserver/shared';
import {
  deduplicateProviderItems,
  deduplicateSearchResults,
  normalizeSearchKey,
} from '../providers/registry.js';

function artist(name: string, source: ProviderType): Artist {
  return {
    id: `${source}-${name}`,
    name,
    source,
  };
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

function track(title: string, artistName: string, source: ProviderType): Track {
  return {
    id: `${source}-${artistName}-${title}`,
    title,
    albumId: `${source}-album`,
    albumTitle: 'Album',
    artistId: `${source}-${artistName}`,
    artistName,
    source,
  };
}

describe('provider search deduplication', () => {
  it('normalizes punctuation, accents, whitespace and case', () => {
    expect(normalizeSearchKey('  Café   del  Mar ', 'Don’t Stop')).toBe('cafe del mar|dont stop');
  });

  it('keeps local over streaming providers and records availability', () => {
    const result = deduplicateProviderItems(
      [artist('Prince', 'spotify'), artist('Prince', 'qobuz'), artist('Prince', 'local')],
      (item) => normalizeSearchKey(item.name),
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      source: 'local',
      availableOn: ['local', 'qobuz', 'spotify'],
    });
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

  it('handles empty input', () => {
    const result = deduplicateProviderItems(
      [] as Array<{ name: string; source: ProviderType; availableOn?: ProviderType[] }>,
      (item) => item.name,
    );

    expect(result).toEqual([]);
  });
});
