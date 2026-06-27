// ListenBrainz read API: pulls the user's listening stats / recommendations /
// fresh releases and matches them back to the local library (by name) so the
// UI can deep-link into albums you own. The scrobble side lives in
// scrobbler.ts; this is the read side. Token is the same one stored in
// scrobble_config (Settings → Scrobbling → ListenBrainz).

import { getRawDb } from '../db/index.js';
import { logger } from '../logger.js';

const LB_API = 'https://api.listenbrainz.org/1';

/** Allowed stat ranges (a subset of ListenBrainz's). */
export type StatRange = 'week' | 'month' | 'year' | 'all_time';
const RANGES: StatRange[] = ['week', 'month', 'year', 'all_time'];
export function parseRange(v: unknown): StatRange {
  return RANGES.includes(v as StatRange) ? (v as StatRange) : 'month';
}

function getToken(): string | null {
  const db = getRawDb();
  const row = db
    .prepare('SELECT listenbrainz_token, listenbrainz_enabled FROM scrobble_config WHERE id = 1')
    .get() as { listenbrainz_token: string | null; listenbrainz_enabled: number } | undefined;
  if (!row || !row.listenbrainz_enabled || !row.listenbrainz_token) return null;
  return row.listenbrainz_token;
}

export function isConfigured(): boolean {
  return getToken() !== null;
}

async function lbFetch<T = unknown>(path: string, token: string): Promise<T | null> {
  const res = await fetch(`${LB_API}${path}`, {
    headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
  });
  if (res.status === 204) return null; // no data yet (e.g. brand-new user)
  if (!res.ok) throw new Error(`ListenBrainz ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

// validate-token is cheap and returns the canonical user_name; cache it per
// token so stats calls don't re-validate every time.
let cachedUser: { token: string; name: string } | null = null;
export async function getUserName(): Promise<string | null> {
  const token = getToken();
  if (!token) return null;
  if (cachedUser && cachedUser.token === token) return cachedUser.name;
  try {
    const data = await lbFetch<{ valid?: boolean; user_name?: string }>('/validate-token', token);
    if (data?.valid && data.user_name) {
      cachedUser = { token, name: data.user_name };
      return data.user_name;
    }
  } catch (err) {
    logger.warn(`ListenBrainz: validate-token failed: ${String(err)}`);
  }
  return null;
}

// ─── Local-library matching (by name, case-insensitive) ──────────────────────

function matchArtist(name: string): string | null {
  const row = getRawDb()
    .prepare('SELECT id FROM artists WHERE LOWER(name) = LOWER(?) LIMIT 1')
    .get(name) as { id: string } | undefined;
  return row?.id ?? null;
}

function matchAlbum(title: string, artist: string): string | null {
  const row = getRawDb()
    .prepare(
      'SELECT id FROM albums WHERE LOWER(title) = LOWER(?) AND LOWER(artist_name) = LOWER(?) LIMIT 1',
    )
    .get(title, artist) as { id: string } | undefined;
  return row?.id ?? null;
}

function matchTrack(title: string, artist: string): { id: string; albumId: string | null } | null {
  const row = getRawDb()
    .prepare(
      'SELECT id, album_id as albumId FROM tracks WHERE LOWER(title) = LOWER(?) AND LOWER(artist_name) = LOWER(?) LIMIT 1',
    )
    .get(title, artist) as { id: string; albumId: string | null } | undefined;
  return row ?? null;
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export interface TopArtist {
  name: string;
  listenCount: number;
  localArtistId: string | null;
}
export interface TopRelease {
  title: string;
  artist: string;
  listenCount: number;
  localAlbumId: string | null;
}
export interface TopRecording {
  title: string;
  artist: string;
  release: string | null;
  listenCount: number;
  localTrackId: string | null;
  localAlbumId: string | null;
}

export async function topArtists(range: StatRange): Promise<TopArtist[]> {
  const user = await getUserName();
  const token = getToken();
  if (!user || !token) return [];
  const data = await lbFetch<{
    payload?: { artists?: Array<{ artist_name: string; listen_count: number }> };
  }>(`/stats/user/${encodeURIComponent(user)}/artists?range=${range}&count=30`, token);
  return (data?.payload?.artists ?? []).map((a) => ({
    name: a.artist_name,
    listenCount: a.listen_count,
    localArtistId: matchArtist(a.artist_name),
  }));
}

export async function topReleases(range: StatRange): Promise<TopRelease[]> {
  const user = await getUserName();
  const token = getToken();
  if (!user || !token) return [];
  const data = await lbFetch<{
    payload?: {
      releases?: Array<{ release_name: string; artist_name: string; listen_count: number }>;
    };
  }>(`/stats/user/${encodeURIComponent(user)}/releases?range=${range}&count=30`, token);
  return (data?.payload?.releases ?? []).map((r) => ({
    title: r.release_name,
    artist: r.artist_name,
    listenCount: r.listen_count,
    localAlbumId: matchAlbum(r.release_name, r.artist_name),
  }));
}

export async function topRecordings(range: StatRange): Promise<TopRecording[]> {
  const user = await getUserName();
  const token = getToken();
  if (!user || !token) return [];
  const data = await lbFetch<{
    payload?: {
      recordings?: Array<{
        track_name: string;
        artist_name: string;
        release_name?: string;
        listen_count: number;
      }>;
    };
  }>(`/stats/user/${encodeURIComponent(user)}/recordings?range=${range}&count=30`, token);
  return (data?.payload?.recordings ?? []).map((r) => {
    const local = matchTrack(r.track_name, r.artist_name);
    return {
      title: r.track_name,
      artist: r.artist_name,
      release: r.release_name ?? null,
      listenCount: r.listen_count,
      localTrackId: local?.id ?? null,
      localAlbumId: local?.albumId ?? null,
    };
  });
}
