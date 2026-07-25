import type { AuthenticatedMusicProvider, ProviderAuth } from '@audioserver/shared';
import type { Artist, Album, Track, SearchResults, Playlist } from '@audioserver/shared';
import { randomBytes, createHash } from 'crypto';
import { logger } from '../logger.js';
import { saveTokens, loadTokens, deleteTokens } from '../services/tokenstore.js';

const TIDAL_AUTH_URL = 'https://auth.tidal.com/v1/oauth2';
const TIDAL_API_URL = 'https://openapi.tidal.com/v2';
const TIDAL_LEGACY_API = 'https://api.tidal.com/v1';

interface TidalTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface TidalArtworkFile {
  href?: string;
  meta?: { width?: number };
}

interface TidalResourceIdentifier {
  id: string;
  type: string;
}

interface TidalRelationship {
  data?: TidalResourceIdentifier | TidalResourceIdentifier[];
}

interface TidalRelationships {
  artists?: TidalRelationship;
  albums?: TidalRelationship;
  coverArt?: TidalRelationship;
  profileArt?: TidalRelationship;
}

interface TidalArtistAttributes {
  name?: string;
}

interface TidalAlbumAttributes {
  title?: string;
  releaseDate?: string;
  numberOfItems?: number;
}

interface TidalTrackAttributes {
  title?: string;
  duration?: string | number;
}

interface TidalArtistResource extends Partial<TidalArtistAttributes> {
  id: string;
  type: 'artists';
  attributes?: TidalArtistAttributes;
  relationships?: TidalRelationships;
}

interface TidalAlbumResource extends Partial<TidalAlbumAttributes> {
  id: string;
  type: 'albums';
  attributes?: TidalAlbumAttributes;
  relationships?: TidalRelationships;
}

interface TidalTrackResource extends Partial<TidalTrackAttributes> {
  id: string;
  type: 'tracks';
  attributes?: TidalTrackAttributes;
  relationships?: TidalRelationships;
}

interface TidalArtworkResource {
  id: string;
  type: 'artworks';
  attributes?: {
    files?: TidalArtworkFile[];
    mediaType?: string;
  };
}

type TidalResource =
  | TidalArtistResource
  | TidalAlbumResource
  | TidalTrackResource
  | TidalArtworkResource;

interface TidalAlbumItemIdentifier extends TidalResourceIdentifier {
  meta?: { trackNumber?: number; volumeNumber?: number };
}

interface TidalDocument<T> {
  data?: T;
  included?: TidalResource[];
}

interface HydratedResources<T extends TidalResource> {
  resources: T[];
  included: TidalResource[];
}

interface TidalPlaybackInfoResponse {
  manifest?: string;
  manifestMimeType?: string;
  audioQuality?: string;
}

interface TidalStreamUrlsResponse {
  urls?: string[];
}

interface TidalLegacyArtistResponse {
  id: string | number;
  name: string;
  picture?: string;
}

interface TidalLegacyAlbumResponse {
  id: string | number;
  title: string;
  artist?: Pick<TidalLegacyArtistResponse, 'id' | 'name'>;
  artists?: Array<Pick<TidalLegacyArtistResponse, 'id' | 'name'>>;
  releaseDate?: string;
  cover?: string;
  numberOfTracks?: number;
}

interface TidalLegacyTrackResponse {
  id: string | number;
  title: string;
  album?: Pick<TidalLegacyAlbumResponse, 'id' | 'title'>;
  artist?: Pick<TidalLegacyArtistResponse, 'id' | 'name'>;
  artists?: Array<Pick<TidalLegacyArtistResponse, 'id' | 'name'>>;
  trackNumber?: number;
  duration?: number;
}

interface TidalLegacyPlaylistResponse {
  uuid: string;
  title: string;
  description?: string;
  numberOfTracks?: number;
  squareImage?: string;
}

interface TidalLegacyPage<T> {
  items?: T[];
}

interface TidalLegacyPlaylistItem {
  type?: string;
  item?: TidalLegacyTrackResponse;
}

interface TidalLegacyFavorite<T> {
  item: T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstManifestUrl(manifest: unknown): string | null {
  if (!isRecord(manifest) || !Array.isArray(manifest.urls)) return null;
  const firstUrl = manifest.urls[0];
  return typeof firstUrl === 'string' ? firstUrl : null;
}

/**
 * Tidal provider with OAuth2 Authorization Code + PKCE flow.
 *
 * Setup:
 * 1. Register at https://developer.tidal.com
 * 2. Set TIDAL_CLIENT_ID and TIDAL_CLIENT_SECRET in .env
 * 3. Call POST /api/providers/tidal/auth/init to get the login URL
 * 4. After user authorizes, Tidal redirects to callback URL with ?code=...
 * 5. Call POST /api/providers/tidal/auth/callback with the code
 *
 * Once authenticated, all browse/search/play methods work against the Tidal API.
 */
export class TidalProvider implements AuthenticatedMusicProvider {
  readonly type = 'tidal' as const;
  readonly name = 'Tidal';
  isAvailable = false;

  private tokens: TidalTokens | null = null;
  private clientId: string;
  private clientSecret: string;

  auth: ProviderAuth = {
    isAuthenticated: false,
    login: async (credentials) => {
      // Called with { code, redirectUri } after OAuth callback
      await this.exchangeCode(credentials.code, credentials.redirectUri);
    },
    logout: async () => {
      this.tokens = null;
      this.auth.isAuthenticated = false;
      deleteTokens('tidal');
    },
    refreshToken: async () => {
      await this.refreshAccessToken();
    },
  };

  constructor() {
    this.clientId = process.env.TIDAL_CLIENT_ID || '';
    this.clientSecret = process.env.TIDAL_CLIENT_SECRET || '';
    this.isAvailable = !!(this.clientId && this.clientSecret);
  }

  // PKCE state
  private codeVerifier: string | null = null;

  async initialize(): Promise<void> {
    if (!this.clientId || !this.clientSecret) {
      logger.info('Tidal: No client credentials configured, skipping');
      return;
    }
    try {
      const stored = loadTokens('tidal');
      if (stored) {
        this.tokens = stored;
        this.auth.isAuthenticated = true;
        logger.info('Tidal: Restored tokens from database');
        if (Date.now() >= stored.expiresAt - 60_000) {
          await this.refreshAccessToken();
          logger.info('Tidal: Refreshed expired token');
        }
      } else {
        logger.info('Tidal: Provider initialized (awaiting authentication)');
      }
    } catch (err) {
      logger.warn(`Tidal: Failed to restore tokens: ${err}`);
    }
  }

  async dispose(): Promise<void> {
    this.tokens = null;
  }

  // ─── OAuth Flow ──────────────────────────────────────────────

  getAuthUrl(redirectUri: string): string {
    // Generate PKCE code verifier and challenge
    this.codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(this.codeVerifier).digest('base64url');

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      scope:
        'user.read collection.read collection.write playlists.read playlists.write entitlements.read recommendations.read playback search.read search.write',
    });
    return `https://login.tidal.com/authorize?${params}`;
  }

  private async exchangeCode(code: string, redirectUri: string): Promise<void> {
    const body: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: this.clientId,
    };
    // Include PKCE code verifier if available
    if (this.codeVerifier) {
      body.code_verifier = this.codeVerifier;
      this.codeVerifier = null; // Single use
    }

    const res = await fetch(`${TIDAL_AUTH_URL}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams(body),
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Tidal auth failed: ${error}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    this.auth.isAuthenticated = true;
    saveTokens('tidal', this.tokens);
    logger.info('Tidal: Authenticated successfully');
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.tokens?.refreshToken) throw new Error('No refresh token');

    const res = await fetch(`${TIDAL_AUTH_URL}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.tokens.refreshToken,
      }),
    });

    if (!res.ok) throw new Error('Tidal token refresh failed');

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    this.tokens.accessToken = data.access_token;
    if (data.refresh_token) this.tokens.refreshToken = data.refresh_token;
    this.tokens.expiresAt = Date.now() + data.expires_in * 1000;
    saveTokens('tidal', this.tokens);
  }

  private async apiRequest<T>(path: string): Promise<T> {
    if (!this.tokens) throw new Error('Not authenticated');

    // Auto-refresh if expired
    if (Date.now() >= this.tokens.expiresAt - 60_000) {
      await this.refreshAccessToken();
    }

    const url = `${TIDAL_API_URL}${path}`;
    logger.debug(`Tidal API request: ${url}`);
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.tokens.accessToken}`,
        'Content-Type': 'application/vnd.tidal.v1+json',
      },
    });

    if (!res.ok) {
      const err = await res.text();
      logger.error(`Tidal API ${res.status}: ${url} → ${err.slice(0, 300)}`);
      throw new Error(`Tidal API error: ${res.status} ${err.slice(0, 100)}`);
    }
    return (await res.json()) as T;
  }

  private async legacyApiRequest<T>(path: string): Promise<T> {
    if (!this.tokens) throw new Error('Not authenticated');

    if (Date.now() >= this.tokens.expiresAt - 60_000) {
      await this.refreshAccessToken();
    }

    const separator = path.includes('?') ? '&' : '?';
    const res = await fetch(`${TIDAL_LEGACY_API}${path}${separator}countryCode=US`, {
      headers: {
        Authorization: `Bearer ${this.tokens.accessToken}`,
      },
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Tidal legacy API error: ${res.status} ${err}`);
    }
    return (await res.json()) as T;
  }

  // ─── MusicProvider Implementation ────────────────────────────

  async getArtists(_page?: number, _pageSize?: number) {
    // Tidal doesn't have a "list all artists" — return from user's collection
    if (!this.auth.isAuthenticated) return { items: [] as Artist[], total: 0 };
    // TODO: GET /v2/my/artists
    return { items: [] as Artist[], total: 0 };
  }

  async getArtist(id: string): Promise<Artist | null> {
    if (!this.auth.isAuthenticated) return null;
    try {
      const rawId = id.replace('tidal:', '');
      const response = await this.apiRequest<TidalDocument<TidalArtistResource>>(
        `/artists/${rawId}?include=profileArt`,
      );
      return response.data ? this.mapArtist(response.data, response.included) : null;
    } catch {
      return null;
    }
  }

  async getAlbums(_page?: number, _pageSize?: number) {
    if (!this.auth.isAuthenticated) return { items: [] as Album[], total: 0 };
    return { items: [] as Album[], total: 0 };
  }

  async getAlbum(id: string): Promise<Album | null> {
    if (!this.auth.isAuthenticated) return null;
    try {
      const rawId = id.replace('tidal:', '');
      // Tidal v2 exposes artist and artwork metadata as JSON:API relationships.
      const response = await this.apiRequest<TidalDocument<TidalAlbumResource>>(
        `/albums/${rawId}?include=artists,coverArt`,
      );
      const albumData = response.data;
      if (!albumData) return null;
      logger.debug(`Tidal getAlbum v2: ${JSON.stringify(albumData).slice(0, 300)}`);
      return this.mapAlbum(albumData, response.included);
    } catch (err) {
      logger.error(`Tidal getAlbum failed: ${err}`);
      return null;
    }
  }

  async getAlbumTracks(albumId: string): Promise<Track[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const rawId = albumId.replace('tidal:', '');
      // Use v2 API relationships endpoint
      const response = await this.apiRequest<TidalDocument<TidalAlbumItemIdentifier[]>>(
        `/albums/${rawId}/relationships/items?include=items&page[limit]=100`,
      );
      const identifiers = (response.data || []).filter((item) => item.type === 'tracks');
      const hydrated = await this.hydrateResources<TidalTrackResource>(
        response,
        'tracks',
        identifiers.map((item) => item.id),
        ['artists', 'albums'],
      );
      const tracksById = new Map(hydrated.resources.map((track) => [track.id, track]));
      logger.info(`Tidal getAlbumTracks: found ${hydrated.resources.length} tracks`);
      return identifiers.flatMap((identifier) => {
        const track = tracksById.get(identifier.id);
        return track ? [this.mapTrack(track, hydrated.included, identifier.meta?.trackNumber)] : [];
      });
    } catch (err) {
      logger.error(`Tidal getAlbumTracks failed: ${err}`);
      return [];
    }
  }

  async getArtistAlbums(artistId: string): Promise<Album[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const rawId = artistId.replace('tidal:', '');
      const data = await this.apiRequest<TidalDocument<TidalResourceIdentifier[]>>(
        `/artists/${rawId}/relationships/albums?include=albums&page[limit]=50`,
      );
      const hydrated = await this.hydrateResources<TidalAlbumResource>(
        data,
        'albums',
        relationshipIds(data, 'albums'),
        ['artists', 'coverArt'],
      );
      return hydrated.resources.map((album) => this.mapAlbum(album, hydrated.included));
    } catch {
      return [];
    }
  }

  async search(query: string, limit = 10): Promise<SearchResults> {
    if (!this.auth.isAuthenticated) return { artists: [], albums: [], tracks: [], playlists: [] };
    try {
      // JSON:API format: fetch relationships separately
      const q = encodeURIComponent(query);
      const [artistsRes, albumsRes, tracksRes] = await Promise.allSettled([
        this.apiRequest<TidalDocument<TidalResourceIdentifier[]>>(
          `/searchResults/${q}/relationships/artists?include=artists&page[limit]=${limit}`,
        ),
        this.apiRequest<TidalDocument<TidalResourceIdentifier[]>>(
          `/searchResults/${q}/relationships/albums?include=albums&page[limit]=${limit}`,
        ),
        this.apiRequest<TidalDocument<TidalResourceIdentifier[]>>(
          `/searchResults/${q}/relationships/tracks?include=tracks&page[limit]=${limit}`,
        ),
      ]);

      const [artistData, albumData, trackData] = await Promise.all([
        artistsRes.status === 'fulfilled'
          ? this.hydrateResources<TidalArtistResource>(
              artistsRes.value,
              'artists',
              relationshipIds(artistsRes.value, 'artists'),
              ['profileArt'],
            )
          : emptyHydrated<TidalArtistResource>(),
        albumsRes.status === 'fulfilled'
          ? this.hydrateResources<TidalAlbumResource>(
              albumsRes.value,
              'albums',
              relationshipIds(albumsRes.value, 'albums'),
              ['artists', 'coverArt'],
            )
          : emptyHydrated<TidalAlbumResource>(),
        tracksRes.status === 'fulfilled'
          ? this.hydrateResources<TidalTrackResource>(
              tracksRes.value,
              'tracks',
              relationshipIds(tracksRes.value, 'tracks'),
              ['artists', 'albums'],
            )
          : emptyHydrated<TidalTrackResource>(),
      ]);

      const artists = artistData.resources.map((artist) =>
        this.mapArtist(artist, artistData.included),
      );
      const albums = albumData.resources.map((album) => this.mapAlbum(album, albumData.included));
      const tracks = trackData.resources.map((track) => this.mapTrack(track, trackData.included));

      return { artists, albums, tracks, playlists: [] };
    } catch (err) {
      logger.error(`Tidal search failed: ${err instanceof Error ? err.stack : err}`);
      return { artists: [], albums: [], tracks: [], playlists: [] };
    }
  }

  async getStreamUrl(trackId: string): Promise<string | null> {
    if (!this.auth.isAuthenticated) return null;
    const rawId = trackId.replace('tidal:', '');
    try {
      // Try legacy API playbackinfopostpaywall endpoint
      const data = await this.legacyApiRequest<TidalPlaybackInfoResponse>(
        `/tracks/${rawId}/playbackinfopostpaywall?audioquality=LOSSLESS&playbackmode=STREAM&assetpresentation=FULL`,
      );
      if (data.manifest) {
        // Manifest is base64-encoded JSON containing URLs
        const manifest = JSON.parse(
          Buffer.from(data.manifest, 'base64').toString('utf-8'),
        ) as unknown;
        const manifestUrl = firstManifestUrl(manifest);
        if (manifestUrl) {
          logger.info(`Tidal: Got stream URL for track ${rawId} (${data.audioQuality})`);
          return manifestUrl;
        }
      }
      // Fallback: direct manifestMimeType check
      if (data.manifestMimeType === 'application/vnd.tidal.bts' && data.manifest) {
        logger.info(`Tidal: Got BTS manifest for track ${rawId}`);
        return data.manifest; // BTS manifest URL
      }
      logger.warn(`Tidal: No stream URL in playbackinfo response for ${rawId}`);
      return null;
    } catch (err) {
      // Fallback: try the v2 API track URL endpoint
      try {
        const data = await this.legacyApiRequest<TidalStreamUrlsResponse>(
          `/tracks/${rawId}/urlpostpaywall?urlusagemode=STREAM&audioquality=LOSSLESS&assetpresentation=FULL`,
        );
        if (data.urls?.[0]) {
          logger.info(`Tidal: Got stream URL via urlpostpaywall for track ${rawId}`);
          return data.urls[0];
        }
      } catch (err2) {
        logger.debug(`Tidal: urlpostpaywall also failed for ${rawId}: ${err2}`);
      }
      logger.warn(`Tidal: Stream URL retrieval failed for ${rawId}: ${err}`);
      return null;
    }
  }

  async getPlaylists(): Promise<Playlist[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const data = await this.legacyApiRequest<TidalLegacyPage<TidalLegacyPlaylistResponse>>(
        '/users/me/playlists?limit=50',
      );
      return (data.items || []).map((playlist) => ({
        id: `tidal:${playlist.uuid}`,
        name: playlist.title,
        description: playlist.description || '',
        trackCount: playlist.numberOfTracks ?? 0,
        coverUrl: playlist.squareImage
          ? `https://resources.tidal.com/images/${playlist.squareImage.replace(/-/g, '/')}/320x320.jpg`
          : undefined,
        source: 'tidal',
      }));
    } catch (err) {
      logger.warn(`Tidal: Failed to get playlists: ${err}`);
      return [];
    }
  }

  async getPlaylistTracks(playlistId: string): Promise<Track[]> {
    if (!this.auth.isAuthenticated) return [];
    const rawId = playlistId.replace('tidal:', '');
    try {
      const data = await this.legacyApiRequest<TidalLegacyPage<TidalLegacyPlaylistItem>>(
        `/playlists/${rawId}/items?limit=100`,
      );
      return (data.items || [])
        .map((item) => (item.type === 'track' ? item.item : undefined))
        .filter((track): track is TidalLegacyTrackResponse => Boolean(track))
        .map((track) => this.mapLegacyTrack(track));
    } catch (err) {
      logger.warn(`Tidal: Failed to get playlist tracks: ${err}`);
      return [];
    }
  }

  async getFavoriteAlbums(): Promise<Album[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const data = await this.legacyApiRequest<
        TidalLegacyPage<TidalLegacyFavorite<TidalLegacyAlbumResponse>>
      >('/users/me/favorites/albums?limit=50&order=DATE&orderDirection=DESC');
      return (data.items || []).map((item) => this.mapLegacyAlbum(item.item));
    } catch (err) {
      logger.warn(`Tidal: Failed to get favorite albums: ${err}`);
      return [];
    }
  }

  async getFavoriteTracks(): Promise<Track[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const data = await this.legacyApiRequest<
        TidalLegacyPage<TidalLegacyFavorite<TidalLegacyTrackResponse>>
      >('/users/me/favorites/tracks?limit=100&order=DATE&orderDirection=DESC');
      return (data.items || []).map((item) => this.mapLegacyTrack(item.item));
    } catch (err) {
      logger.warn(`Tidal: Failed to get favorite tracks: ${err}`);
      return [];
    }
  }

  async getFavoriteArtists(): Promise<Artist[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const data = await this.legacyApiRequest<
        TidalLegacyPage<TidalLegacyFavorite<TidalLegacyArtistResponse>>
      >('/users/me/favorites/artists?limit=50&order=DATE&orderDirection=DESC');
      return (data.items || []).map((item) => ({
        id: `tidal:${item.item.id}`,
        name: item.item.name,
        imageUrl: item.item.picture
          ? `https://resources.tidal.com/images/${item.item.picture.replace(/-/g, '/')}/320x320.jpg`
          : undefined,
        source: 'tidal' as const,
      }));
    } catch (err) {
      logger.warn(`Tidal: Failed to get favorite artists: ${err}`);
      return [];
    }
  }

  private async hydrateResources<T extends TidalResource>(
    relationshipDocument: TidalDocument<unknown>,
    resourceType: T['type'],
    requestedIds: string[],
    include: string[],
  ): Promise<HydratedResources<T>> {
    const fallbackIncluded = relationshipDocument.included || [];
    const ids = requestedIds.length
      ? requestedIds
      : fallbackIncluded.filter((item) => item.type === resourceType).map((item) => item.id);
    if (ids.length === 0) return emptyHydrated<T>();

    try {
      const params = new URLSearchParams();
      ids.forEach((id) => params.append('filter[id]', id));
      if (include.length) params.set('include', include.join(','));
      const response = await this.apiRequest<TidalDocument<T[]>>(
        `/${resourceType}?${params.toString()}`,
      );
      const resources = response.data || resourcesOfType<T>(response.included, resourceType);
      const byId = new Map(resources.map((resource) => [resource.id, resource]));
      return {
        resources: ids.flatMap((id) => {
          const resource = byId.get(id);
          return resource ? [resource] : [];
        }),
        included: response.included || [],
      };
    } catch (error) {
      logger.warn(`Tidal: failed to hydrate ${resourceType} relationships: ${error}`);
      const fallback = resourcesOfType<T>(fallbackIncluded, resourceType);
      const byId = new Map(fallback.map((resource) => [resource.id, resource]));
      return {
        resources: ids.flatMap((id) => {
          const resource = byId.get(id);
          return resource ? [resource] : [];
        }),
        included: fallbackIncluded,
      };
    }
  }

  // ─── Mappers ─────────────────────────────────────────────────

  // JSON:API format: { id, type, attributes: { title, ... }, relationships: { ... } }
  private mapArtist(data: TidalArtistResource, included: TidalResource[] = []): Artist {
    const attrs = data.attributes || {};
    const artwork = firstRelatedResource<TidalArtworkResource>(
      data.relationships?.profileArt,
      included,
      'artworks',
    );
    return {
      id: `tidal:${data.id}`,
      name: attrs.name || 'Unknown',
      imageUrl: bestArtworkUrl(artwork),
      source: 'tidal',
    };
  }

  private mapAlbum(data: TidalAlbumResource, included: TidalResource[] = []): Album {
    const attrs = data.attributes || {};
    const artist = firstRelatedResource<TidalArtistResource>(
      data.relationships?.artists,
      included,
      'artists',
    );
    const artwork = firstRelatedResource<TidalArtworkResource>(
      data.relationships?.coverArt,
      included,
      'artworks',
    );
    return {
      id: `tidal:${data.id}`,
      title: attrs.title || 'Unknown',
      artistId: artist ? `tidal:${artist.id}` : '',
      artistName: artist?.attributes?.name || 'Unknown',
      year: attrs.releaseDate ? new Date(attrs.releaseDate).getFullYear() : undefined,
      coverUrl: bestArtworkUrl(artwork),
      trackCount: attrs.numberOfItems,
      source: 'tidal',
    };
  }

  private mapTrack(
    data: TidalTrackResource,
    included: TidalResource[] = [],
    trackNumber?: number,
  ): Track {
    const attrs = data.attributes || {};
    const artist = firstRelatedResource<TidalArtistResource>(
      data.relationships?.artists,
      included,
      'artists',
    );
    const album = firstRelatedResource<TidalAlbumResource>(
      data.relationships?.albums,
      included,
      'albums',
    );
    return {
      id: `tidal:${data.id}`,
      title: attrs.title || 'Unknown',
      albumId: album ? `tidal:${album.id}` : '',
      albumTitle: album?.attributes?.title || '',
      artistId: artist ? `tidal:${artist.id}` : '',
      artistName: artist?.attributes?.name || 'Unknown',
      trackNumber,
      duration: parseTidalDuration(attrs.duration),
      source: 'tidal',
    };
  }

  // Legacy API mappers (api.tidal.com/v1 has different field names)
  private mapLegacyTrack(data: TidalLegacyTrackResponse): Track {
    return {
      id: `tidal:${data.id}`,
      title: data.title,
      albumId: `tidal:${data.album?.id || ''}`,
      albumTitle: data.album?.title || '',
      artistId: `tidal:${data.artist?.id ?? ''}`,
      artistName: data.artist?.name || data.artists?.[0]?.name || 'Unknown',
      trackNumber: data.trackNumber,
      duration: data.duration,
      source: 'tidal',
    };
  }

  private mapLegacyAlbum(data: TidalLegacyAlbumResponse): Album {
    return {
      id: `tidal:${data.id}`,
      title: data.title,
      artistId: data.artist?.id ? `tidal:${data.artist.id}` : '',
      artistName: data.artist?.name || data.artists?.[0]?.name || 'Unknown',
      year: data.releaseDate ? new Date(data.releaseDate).getFullYear() : undefined,
      coverUrl: data.cover
        ? `https://resources.tidal.com/images/${data.cover.replace(/-/g, '/')}/640x640.jpg`
        : undefined,
      trackCount: data.numberOfTracks,
      source: 'tidal',
    };
  }
}

function relationshipIds(document: TidalDocument<unknown>, type: string): string[] {
  if (Array.isArray(document.data)) {
    return document.data
      .filter(
        (item): item is TidalResourceIdentifier =>
          typeof item === 'object' && item !== null && 'id' in item && 'type' in item,
      )
      .filter((item) => item.type === type)
      .map((item) => item.id);
  }
  return (document.included || []).filter((item) => item.type === type).map((item) => item.id);
}

function resourcesOfType<T extends TidalResource>(
  included: TidalResource[] | undefined,
  type: T['type'],
): T[] {
  return (included || []).filter((item) => item.type === type) as T[];
}

function emptyHydrated<T extends TidalResource>(): HydratedResources<T> {
  return { resources: [], included: [] };
}

function firstRelatedResource<T extends TidalResource>(
  relationship: TidalRelationship | undefined,
  included: TidalResource[],
  type: T['type'],
): T | undefined {
  const data = relationship?.data;
  const identifiers = Array.isArray(data) ? data : data ? [data] : [];
  const id = identifiers.find((identifier) => identifier.type === type)?.id;
  return included.find((item) => item.type === type && (!id || item.id === id)) as T | undefined;
}

function bestArtworkUrl(artwork: TidalArtworkResource | undefined): string | undefined {
  const files = artwork?.attributes?.files || [];
  return (
    files.find((file) => (file.meta?.width ?? 0) >= 320)?.href ||
    [...files].sort((left, right) => (right.meta?.width ?? 0) - (left.meta?.width ?? 0))[0]?.href
  );
}

function parseTidalDuration(value: string | number | undefined): number | undefined {
  if (typeof value === 'number') {
    // Older v2 snapshots exposed milliseconds; the current API uses ISO-8601.
    return Number.isFinite(value) ? value / 1000 : undefined;
  }
  if (!value) return undefined;

  const match = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value);
  if (!match) return undefined;
  const seconds = Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
  return Number.isFinite(seconds) ? seconds : undefined;
}
