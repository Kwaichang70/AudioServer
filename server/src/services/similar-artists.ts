// "Listeners also like" — similar artists for the artist page. ListenBrainz's
// own similar-artists API is MBID-based (and needs a seed MBID we don't store),
// so for reliable, name-based similarity we use Last.fm's artist.getSimilar
// (needs only LASTFM_API_KEY, the same key used for scrobbling). Results are
// matched back to the local library so owned artists deep-link.

import { getRawDb } from '../db/index.js';

const LASTFM_API = 'https://ws.audioscrobbler.com/2.0/';

export interface SimilarArtist {
  name: string;
  /** Last.fm similarity score, 0..1. */
  match: number;
  localArtistId: string | null;
}

export function similarArtistsAvailable(): boolean {
  return !!process.env.LASTFM_API_KEY;
}

function matchLocalArtist(name: string): string | null {
  const row = getRawDb()
    .prepare('SELECT id FROM artists WHERE LOWER(name) = LOWER(?) LIMIT 1')
    .get(name) as { id: string } | undefined;
  return row?.id ?? null;
}

export async function getSimilarArtists(artistName: string): Promise<SimilarArtist[]> {
  const key = process.env.LASTFM_API_KEY;
  if (!key) return [];
  const url =
    `${LASTFM_API}?method=artist.getsimilar` +
    `&artist=${encodeURIComponent(artistName)}` +
    `&api_key=${key}&format=json&limit=24&autocorrect=1`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = (await res.json()) as {
    similarartists?: { artist?: Array<{ name: string; match: string }> };
  };
  return (data?.similarartists?.artist ?? []).map((a) => ({
    name: a.name,
    match: Number(a.match) || 0,
    localArtistId: matchLocalArtist(a.name),
  }));
}
