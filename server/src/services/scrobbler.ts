import { createHash } from 'crypto';
import { getRawDb } from '../db/index.js';
import { logger } from '../logger.js';

const LASTFM_API_URL = 'https://ws.audioscrobbler.com/2.0/';
const LASTFM_API_KEY = process.env.LASTFM_API_KEY || '';
const LASTFM_API_SECRET = process.env.LASTFM_API_SECRET || '';
const LISTENBRAINZ_API_URL = 'https://api.listenbrainz.org/1';

interface ScrobbleTrack {
  title: string;
  artist: string;
  album?: string;
  duration?: number;
}

interface ScrobbleConfig {
  lastfmEnabled: boolean;
  lastfmSessionKey: string | null;
  lastfmUsername: string | null;
  listenbrainzEnabled: boolean;
  listenbrainzToken: string | null;
}

interface ScrobbleConfigRow {
  lastfm_enabled: number;
  lastfm_session_key: string | null;
  lastfm_username: string | null;
  listenbrainz_enabled: number;
  listenbrainz_token: string | null;
}

interface ScrobbleQueueRow {
  id: number;
  service: 'lastfm' | 'listenbrainz';
  track_title: string;
  artist_name: string;
  album_title: string | null;
  duration: number | null;
  timestamp: number;
}

interface LastfmResponse {
  error?: number;
  message?: string;
  token?: string;
  session?: { key: string; name: string };
}

// ─── Config ──────────────────────────────────────────────────────

function getConfig(): ScrobbleConfig {
  const db = getRawDb();
  const row = db.prepare('SELECT * FROM scrobble_config WHERE id = 1').get() as
    | ScrobbleConfigRow
    | undefined;
  if (!row) {
    return {
      lastfmEnabled: false,
      lastfmSessionKey: null,
      lastfmUsername: null,
      listenbrainzEnabled: false,
      listenbrainzToken: null,
    };
  }
  return {
    lastfmEnabled: !!row.lastfm_enabled,
    lastfmSessionKey: row.lastfm_session_key,
    lastfmUsername: row.lastfm_username,
    listenbrainzEnabled: !!row.listenbrainz_enabled,
    listenbrainzToken: row.listenbrainz_token,
  };
}

function saveConfig(config: Partial<ScrobbleConfig>): void {
  const db = getRawDb();
  const existing = db.prepare('SELECT id FROM scrobble_config WHERE id = 1').get();
  if (!existing) {
    db.prepare('INSERT INTO scrobble_config (id) VALUES (1)').run();
  }
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  if (config.lastfmEnabled !== undefined) {
    sets.push('lastfm_enabled = ?');
    params.push(config.lastfmEnabled ? 1 : 0);
  }
  if (config.lastfmSessionKey !== undefined) {
    sets.push('lastfm_session_key = ?');
    params.push(config.lastfmSessionKey);
  }
  if (config.lastfmUsername !== undefined) {
    sets.push('lastfm_username = ?');
    params.push(config.lastfmUsername);
  }
  if (config.listenbrainzEnabled !== undefined) {
    sets.push('listenbrainz_enabled = ?');
    params.push(config.listenbrainzEnabled ? 1 : 0);
  }
  if (config.listenbrainzToken !== undefined) {
    sets.push('listenbrainz_token = ?');
    params.push(config.listenbrainzToken);
  }
  if (sets.length > 0) {
    db.prepare(`UPDATE scrobble_config SET ${sets.join(', ')} WHERE id = 1`).run(...params);
  }
}

// ─── Last.fm ─────────────────────────────────────────────────────

function lastfmSign(params: Record<string, string>): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join('');
  return createHash('md5')
    .update(sorted + LASTFM_API_SECRET)
    .digest('hex');
}

async function lastfmGetSession(token: string): Promise<{ key: string; name: string }> {
  const params: Record<string, string> = {
    method: 'auth.getSession',
    api_key: LASTFM_API_KEY,
    token,
  };
  params.api_sig = lastfmSign(params);
  params.format = 'json';

  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${LASTFM_API_URL}?${qs}`);
  const data = (await res.json()) as LastfmResponse;
  if (data.error || !data.session) throw new Error(data.message || 'Last.fm auth failed');
  return data.session;
}

// auth.getToken (signed) → a request token to put in the authorize URL. The
// proper flow is api/auth/?api_key=…&token=…; the bare ?api_key= form drops the
// key and Last.fm reports "Invalid API key".
async function lastfmGetToken(): Promise<string> {
  const params: Record<string, string> = { method: 'auth.getToken', api_key: LASTFM_API_KEY };
  params.api_sig = lastfmSign(params);
  params.format = 'json';
  const res = await fetch(`${LASTFM_API_URL}?${new URLSearchParams(params).toString()}`);
  const data = (await res.json()) as LastfmResponse;
  if (data.error || !data.token) throw new Error(data.message || 'Last.fm getToken failed');
  return data.token as string;
}

async function lastfmScrobble(
  track: ScrobbleTrack,
  timestamp: number,
  sessionKey: string,
): Promise<boolean> {
  if (!LASTFM_API_KEY || !LASTFM_API_SECRET) return false;

  const params: Record<string, string> = {
    method: 'track.scrobble',
    api_key: LASTFM_API_KEY,
    sk: sessionKey,
    'artist[0]': track.artist,
    'track[0]': track.title,
    'timestamp[0]': String(timestamp),
  };
  if (track.album) params['album[0]'] = track.album;
  if (track.duration) params['duration[0]'] = String(track.duration);
  params.api_sig = lastfmSign(params);
  params.format = 'json';

  const res = await fetch(LASTFM_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = (await res.json()) as LastfmResponse;
  return !data.error;
}

async function lastfmUpdateNowPlaying(track: ScrobbleTrack, sessionKey: string): Promise<void> {
  if (!LASTFM_API_KEY || !LASTFM_API_SECRET) return;

  const params: Record<string, string> = {
    method: 'track.updateNowPlaying',
    api_key: LASTFM_API_KEY,
    sk: sessionKey,
    artist: track.artist,
    track: track.title,
  };
  if (track.album) params.album = track.album;
  if (track.duration) params.duration = String(track.duration);
  params.api_sig = lastfmSign(params);
  params.format = 'json';

  await fetch(LASTFM_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  }).catch(() => {});
}

// ─── ListenBrainz ────────────────────────────────────────────────

async function listenbrainzSubmit(
  track: ScrobbleTrack,
  timestamp: number,
  token: string,
): Promise<boolean> {
  const payload = {
    listen_type: 'single',
    payload: [
      {
        listened_at: timestamp,
        track_metadata: {
          artist_name: track.artist,
          track_name: track.title,
          release_name: track.album || undefined,
          additional_info: {
            duration_ms: track.duration ? track.duration * 1000 : undefined,
          },
        },
      },
    ],
  };

  const res = await fetch(`${LISTENBRAINZ_API_URL}/submit-listens`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Token ${token}`,
    },
    body: JSON.stringify(payload),
  });
  return res.ok;
}

async function listenbrainzNowPlaying(track: ScrobbleTrack, token: string): Promise<void> {
  const payload = {
    listen_type: 'playing_now',
    payload: [
      {
        track_metadata: {
          artist_name: track.artist,
          track_name: track.title,
          release_name: track.album || undefined,
        },
      },
    ],
  };

  await fetch(`${LISTENBRAINZ_API_URL}/submit-listens`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Token ${token}`,
    },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

// ─── Queue Processing ────────────────────────────────────────────

async function processQueueItems(): Promise<void> {
  const db = getRawDb();
  const config = getConfig();
  const pending = db
    .prepare(
      "SELECT * FROM scrobble_queue WHERE status = 'pending' AND retries < 5 ORDER BY timestamp ASC LIMIT 50",
    )
    .all() as ScrobbleQueueRow[];

  for (const item of pending) {
    const track: ScrobbleTrack = {
      title: item.track_title,
      artist: item.artist_name,
      album: item.album_title ?? undefined,
      duration: item.duration ?? undefined,
    };

    let success = false;
    try {
      if (item.service === 'lastfm' && config.lastfmEnabled && config.lastfmSessionKey) {
        success = await lastfmScrobble(track, item.timestamp, config.lastfmSessionKey);
      } else if (
        item.service === 'listenbrainz' &&
        config.listenbrainzEnabled &&
        config.listenbrainzToken
      ) {
        success = await listenbrainzSubmit(track, item.timestamp, config.listenbrainzToken);
      }
    } catch (err) {
      logger.debug(`Scrobble failed for ${item.service}: ${err}`);
    }

    if (success) {
      db.prepare("UPDATE scrobble_queue SET status = 'sent' WHERE id = ?").run(item.id);
    } else {
      db.prepare(
        "UPDATE scrobble_queue SET retries = retries + 1, status = CASE WHEN retries >= 4 THEN 'failed' ELSE 'pending' END WHERE id = ?",
      ).run(item.id);
    }
  }
}

let queueProcessing: Promise<void> | null = null;

function processQueue(): Promise<void> {
  if (queueProcessing) return queueProcessing;
  const run = processQueueItems().finally(() => {
    if (queueProcessing === run) queueProcessing = null;
  });
  queueProcessing = run;
  return run;
}

// ─── Public API ──────────────────────────────────────────────────

let queueInterval: ReturnType<typeof setInterval> | null = null;

export const scrobbler = {
  getConfig,
  saveConfig,
  flush: processQueue,

  /** Start periodic queue processing */
  start() {
    if (queueInterval) return;
    queueInterval = setInterval(() => processQueue().catch(() => {}), 30_000);
    logger.info('Scrobbler: Queue processor started (30s interval)');
  },

  stop() {
    if (queueInterval) {
      clearInterval(queueInterval);
      queueInterval = null;
    }
  },

  /** Called when a track starts playing */
  async nowPlaying(track: ScrobbleTrack): Promise<void> {
    const config = getConfig();
    if (config.lastfmEnabled && config.lastfmSessionKey) {
      lastfmUpdateNowPlaying(track, config.lastfmSessionKey).catch(() => {});
    }
    if (config.listenbrainzEnabled && config.listenbrainzToken) {
      listenbrainzNowPlaying(track, config.listenbrainzToken).catch(() => {});
    }
  },

  /** Called when a track should be scrobbled (>50% or >4min listened) */
  scrobble(track: ScrobbleTrack): void {
    const config = getConfig();
    const timestamp = Math.floor(Date.now() / 1000);
    const db = getRawDb();

    if (config.lastfmEnabled && config.lastfmSessionKey) {
      db.prepare(
        'INSERT INTO scrobble_queue (service, track_title, artist_name, album_title, duration, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        'lastfm',
        track.title,
        track.artist,
        track.album || null,
        track.duration || null,
        timestamp,
      );
    }

    if (config.listenbrainzEnabled && config.listenbrainzToken) {
      db.prepare(
        'INSERT INTO scrobble_queue (service, track_title, artist_name, album_title, duration, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        'listenbrainz',
        track.title,
        track.artist,
        track.album || null,
        track.duration || null,
        timestamp,
      );
    }

    // Process immediately
    processQueue().catch(() => {});
  },

  /** Last.fm auth helpers */
  async getLastfmAuthUrl(): Promise<{ url: string; token: string }> {
    const token = await lastfmGetToken();
    return {
      url: `https://www.last.fm/api/auth/?api_key=${LASTFM_API_KEY}&token=${token}`,
      token,
    };
  },

  async authenticateLastfm(token: string): Promise<string> {
    const session = await lastfmGetSession(token);
    saveConfig({
      lastfmEnabled: true,
      lastfmSessionKey: session.key,
      lastfmUsername: session.name,
    });
    return session.name;
  },

  /** Validate ListenBrainz token */
  async validateListenbrainz(token: string): Promise<boolean> {
    const res = await fetch(`${LISTENBRAINZ_API_URL}/validate-token`, {
      headers: { Authorization: `Token ${token}` },
    });
    const data = (await res.json()) as { valid?: boolean };
    if (data.valid) {
      saveConfig({ listenbrainzEnabled: true, listenbrainzToken: token });
      return true;
    }
    return false;
  },
};
