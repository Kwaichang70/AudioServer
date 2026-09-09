import { providers } from '../providers/registry.js';
import { radioProvider } from '../providers/radio.js';
import { QobuzProviderError } from '../providers/qobuz.js';
import { getRawDb } from '../db/index.js';
import { signSystemStreamToken } from '../middleware/auth.js';
import { getLanAddress } from '../utils/network.js';
import { config } from '../config.js';

/**
 * Playback resolver (V04.1): ONE place that knows, per source, what the
 * server can do with a track and how to turn a track id into something an
 * output can play.
 *
 * - `local`   files on the NAS, streamed by this server (LAN URL + token)
 * - `qobuz`   full tracks via a short-lived signed CDN URL (fresh per play)
 * - `radio`   station stream URL
 * - `spotify` never a URL: plays through the Web Playback SDK in a browser
 *             or Spotify Connect on a speaker (external player)
 * - `tidal`   catalog/preview only, no full playback
 *
 * Both the client and the server-side player consult this instead of
 * sprinkling id-prefix checks around.
 */

export type PlaybackSource = 'local' | 'qobuz' | 'spotify' | 'tidal' | 'radio';

export interface SourceCapabilities {
  source: PlaybackSource;
  /** The server can hand a URL to a DLNA/Sonos/Volumio renderer itself. */
  serverDispatch: boolean;
  /** A browser tab can play it (audio element or SDK). */
  browser: boolean;
  /** Plays through a third-party player instead of a stream URL. */
  externalPlayer: 'spotify-connect' | null;
  /** Stream URLs expire and must be resolved right before playing. */
  ephemeralUrl: boolean;
  /** Why serverDispatch/browser is false right now (auth, config). */
  reason?: string;
}

export interface ResolvedStream {
  source: PlaybackSource;
  trackId: string;
  url: string;
  mimeType?: string;
  /** Epoch ms after which `url` must not be reused. */
  expiresAt?: number;
  /** Metadata the renderer shows (and needs for DIDL-Lite). */
  metadata: {
    title: string;
    artist: string;
    album: string;
    duration?: number;
    coverUrl?: string;
    mimeType?: string;
  };
}

export type PlaybackResolveCode =
  | 'unsupported_source'
  | 'external_player_only'
  | 'provider_not_configured'
  | 'provider_not_authenticated'
  | 'stream_unavailable'
  | 'track_not_found'
  | 'no_lan_address';

export class PlaybackResolveError extends Error {
  constructor(
    readonly code: PlaybackResolveCode,
    message: string,
    /** True when trying again later (re-auth, network) can succeed; false for policy. */
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'PlaybackResolveError';
  }
}

export interface TrackLike {
  id: string;
  title?: string;
  artistName?: string;
  albumTitle?: string;
  albumId?: string;
  duration?: number;
  source?: string;
}

const MIME_BY_FORMAT: Record<string, string> = {
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  opus: 'audio/opus',
};

export function sourceOf(trackId: string): PlaybackSource {
  if (trackId.startsWith('spotify:')) return 'spotify';
  if (trackId.startsWith('qobuz:')) return 'qobuz';
  if (trackId.startsWith('radio:')) return 'radio';
  if (trackId.startsWith('tidal:')) return 'tidal';
  return 'local';
}

export function getCapabilities(source: PlaybackSource): SourceCapabilities {
  switch (source) {
    case 'local':
      return {
        source,
        serverDispatch: true,
        browser: true,
        externalPlayer: null,
        ephemeralUrl: false,
      };
    case 'qobuz': {
      const status = providers.qobuz.getStatus();
      const ok = status.streamingAvailable;
      return {
        source,
        serverDispatch: ok,
        browser: ok,
        externalPlayer: null,
        ephemeralUrl: true,
        reason: ok ? undefined : status.reason,
      };
    }
    case 'radio':
      return {
        source,
        serverDispatch: true,
        browser: true,
        externalPlayer: null,
        ephemeralUrl: false,
      };
    case 'spotify':
      return {
        source,
        serverDispatch: false,
        browser: providers.spotify.auth.isAuthenticated,
        externalPlayer: 'spotify-connect',
        ephemeralUrl: false,
        reason: providers.spotify.auth.isAuthenticated
          ? 'Spotify plays through the Web Playback SDK or Spotify Connect, not a stream URL'
          : 'Spotify is not connected',
      };
    case 'tidal':
      return {
        source,
        serverDispatch: false,
        browser: false,
        externalPlayer: null,
        ephemeralUrl: false,
        reason: 'Tidal is catalog/preview only',
      };
  }
}

export function getAllCapabilities(): SourceCapabilities[] {
  return (['local', 'qobuz', 'radio', 'spotify', 'tidal'] as PlaybackSource[]).map(getCapabilities);
}

interface LocalTrackRow {
  id: string;
  title: string;
  artist_name: string;
  album_title: string;
  album_id: string | null;
  duration: number | null;
  format: string | null;
}

/**
 * Resolve a track to a URL the SERVER hands to a renderer. Always fresh:
 * Qobuz URLs are signed per call, local URLs get a new system token.
 */
export async function resolveForDevice(track: TrackLike): Promise<ResolvedStream> {
  const source = sourceOf(track.id);
  const caps = getCapabilities(source);
  if (!caps.serverDispatch) {
    if (caps.externalPlayer) {
      throw new PlaybackResolveError(
        'external_player_only',
        `${source} tracks play through ${caps.externalPlayer}; the NAS cannot stream them`,
      );
    }
    if (source === 'tidal') {
      throw new PlaybackResolveError('unsupported_source', caps.reason ?? 'Unsupported source');
    }
    const code: PlaybackResolveCode =
      caps.reason === 'qobuz_not_configured'
        ? 'provider_not_configured'
        : 'provider_not_authenticated';
    throw new PlaybackResolveError(code, `Qobuz: ${caps.reason ?? 'unavailable'}`, true);
  }

  switch (source) {
    case 'local':
      return resolveLocal(track);
    case 'qobuz':
      return resolveQobuz(track);
    case 'radio':
      return resolveRadio(track);
    default:
      throw new PlaybackResolveError('unsupported_source', `Cannot resolve ${source}`);
  }
}

function lanBase(): string {
  const lanAddress = getLanAddress();
  if (!lanAddress) {
    throw new PlaybackResolveError(
      'no_lan_address',
      'No LAN address available to build a stream URL for the device',
      true,
    );
  }
  return `http://${lanAddress}:${config.port}`;
}

function resolveLocal(track: TrackLike): ResolvedStream {
  const row = getRawDb()
    .prepare(
      'SELECT id, title, artist_name, album_title, album_id, duration, format FROM tracks WHERE id = ?',
    )
    .get(track.id) as LocalTrackRow | undefined;
  if (!row) {
    throw new PlaybackResolveError('track_not_found', `Track ${track.id} is not in the library`);
  }
  const base = lanBase();
  const token = encodeURIComponent(signSystemStreamToken());
  const mimeType = MIME_BY_FORMAT[row.format ?? ''] ?? 'audio/mpeg';
  return {
    source: 'local',
    trackId: row.id,
    url: `${base}/api/library/tracks/${row.id}/stream?t=${token}`,
    mimeType,
    metadata: {
      title: row.title,
      artist: row.artist_name,
      album: row.album_title,
      duration: row.duration ?? track.duration,
      coverUrl: row.album_id
        ? `${base}/api/library/albums/${row.album_id}/cover?t=${token}`
        : undefined,
      mimeType,
    },
  };
}

async function resolveQobuz(track: TrackLike): Promise<ResolvedStream> {
  try {
    const stream = await providers.qobuz.getStreamInfo(track.id);
    const mimeType = stream.formatId === '5' ? 'audio/mpeg' : 'audio/flac';
    return {
      source: 'qobuz',
      trackId: track.id,
      url: stream.url,
      mimeType,
      expiresAt: stream.expiresAt ? stream.expiresAt * 1000 : undefined,
      metadata: {
        title: track.title ?? 'Qobuz track',
        artist: track.artistName ?? '',
        album: track.albumTitle ?? '',
        duration: track.duration,
        mimeType,
      },
    };
  } catch (err) {
    if (err instanceof QobuzProviderError) {
      const code: PlaybackResolveCode =
        err.code === 'qobuz_not_configured'
          ? 'provider_not_configured'
          : err.code === 'qobuz_not_authenticated' || err.code === 'qobuz_invalid_credentials'
            ? 'provider_not_authenticated'
            : 'stream_unavailable';
      throw new PlaybackResolveError(code, err.message, code !== 'stream_unavailable');
    }
    throw new PlaybackResolveError('stream_unavailable', String(err), true);
  }
}

async function resolveRadio(track: TrackLike): Promise<ResolvedStream> {
  const uuid = track.id.slice('radio:'.length);
  const cached = getRawDb()
    .prepare('SELECT stream_url, name, genre FROM radio_stations WHERE uuid = ?')
    .get(uuid) as { stream_url: string; name: string; genre: string | null } | undefined;
  const station = cached
    ? { streamUrl: cached.stream_url, name: cached.name, genre: cached.genre ?? undefined }
    : await radioProvider.getStation(uuid);
  if (!station?.streamUrl) {
    throw new PlaybackResolveError('track_not_found', `Radio station ${uuid} not found`);
  }
  return {
    source: 'radio',
    trackId: track.id,
    url: station.streamUrl,
    metadata: {
      title: track.title ?? station.name,
      artist: 'Live Radio',
      album: station.genre ?? '',
    },
  };
}
