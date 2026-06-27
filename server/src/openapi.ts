// Curated OpenAPI 3.1 description of the core AudioServer HTTP API. Served as
// machine-readable JSON at GET /api/openapi.json (public — it's documentation,
// no secrets). Paste the URL into editor.swagger.io / Postman / an IDE to
// browse it. It covers the stable public surface, not every internal endpoint;
// request bodies mirror the zod schemas the routes validate against.

const ok = (description: string) => ({ description });

const Pagination = {
  type: 'object',
  properties: {
    page: { type: 'integer' },
    pageSize: { type: 'integer' },
    total: { type: 'integer' },
    hasMore: { type: 'boolean' },
  },
} as const;

export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'AudioServer API',
    version: '0.1.0',
    description:
      'Self-hosted music streamer: local library, streaming providers (Spotify/Qobuz/Tidal), and multi-room device output. All `/api/*` routes except the public ones below require a Bearer JWT.',
  },
  servers: [{ url: '/api', description: 'Same-origin API root' }],
  tags: [
    { name: 'Auth' },
    { name: 'Health' },
    { name: 'Library' },
    { name: 'Playlists' },
    { name: 'Providers' },
    { name: 'Devices' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      streamToken: {
        type: 'apiKey',
        in: 'query',
        name: 't',
        description: 'Short-lived HMAC token for <img>/<audio> URLs (GET /api/auth/stream-token).',
      },
    },
    schemas: {
      Credentials: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string', minLength: 1 },
          password: { type: 'string', minLength: 8 },
        },
      },
      AuthResult: {
        type: 'object',
        properties: {
          token: { type: 'string' },
          user: {
            type: 'object',
            properties: { id: { type: 'string' }, username: { type: 'string' } },
          },
        },
      },
      Album: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          artistName: { type: 'string' },
          year: { type: 'integer', nullable: true },
          trackCount: { type: 'integer' },
        },
      },
      Track: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          artistName: { type: 'string' },
          albumTitle: { type: 'string' },
          albumId: { type: 'string' },
          duration: { type: 'number' },
          format: { type: 'string' },
        },
      },
      Playlist: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          trackCount: { type: 'integer' },
        },
      },
      Pagination,
      Error: {
        type: 'object',
        properties: { error: { type: 'string' } },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Service health',
        security: [],
        responses: {
          200: ok('db status, last scan, provider state'),
          503: ok('degraded (DB unreachable)'),
        },
      },
    },
    '/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Create the first user (or a new user)',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Credentials' } } },
        },
        responses: {
          200: {
            description: 'Registered',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/AuthResult' } },
            },
          },
          400: {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Log in, returns a JWT',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Credentials' } } },
        },
        responses: {
          200: {
            description: 'Authenticated',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/AuthResult' } },
            },
          },
          401: {
            description: 'Bad credentials',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
    },
    '/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Current user (or whether setup is needed)',
        security: [],
        responses: { 200: ok('user or needsSetup flag') },
      },
    },
    '/auth/stream-token': {
      get: {
        tags: ['Auth'],
        summary: 'Mint a short-lived stream token for media URLs',
        responses: { 200: ok('{ token }') },
      },
    },
    '/library/albums': {
      get: {
        tags: ['Library'],
        summary: 'List albums (paginated)',
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
          { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
          { name: 'search', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          200: {
            description: 'Albums page',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Album' } },
                    meta: { $ref: '#/components/schemas/Pagination' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/library/albums/{id}': {
      get: {
        tags: ['Library'],
        summary: 'Album detail + tracks',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: ok('album with tracks'), 404: ok('not found') },
      },
    },
    '/library/artists': {
      get: {
        tags: ['Library'],
        summary: 'List artists (paginated)',
        responses: { 200: ok('artists page') },
      },
    },
    '/library/tracks/{id}/stream': {
      get: {
        tags: ['Library'],
        summary: 'Stream a track (HTTP range supported)',
        security: [{ bearerAuth: [] }, { streamToken: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: ok('full body'),
          206: ok('partial (range)'),
          416: ok('range not satisfiable'),
        },
      },
    },
    '/library/covers/fetch': {
      post: {
        tags: ['Library'],
        summary: 'Fetch missing cover art from MusicBrainz / Cover Art Archive',
        responses: { 200: ok('fetch status') },
      },
    },
    '/playlists': {
      get: { tags: ['Playlists'], summary: 'List playlists', responses: { 200: ok('playlists') } },
      post: {
        tags: ['Playlists'],
        summary: 'Create a playlist',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string', minLength: 1 },
                  description: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Playlist' } } },
          },
        },
      },
    },
    '/playlists/{id}': {
      get: {
        tags: ['Playlists'],
        summary: 'Playlist detail + tracks',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: ok('playlist'), 404: ok('not found') },
      },
      delete: {
        tags: ['Playlists'],
        summary: 'Delete a playlist',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: ok('deleted') },
      },
    },
    '/playlists/{id}/tracks': {
      post: {
        tags: ['Playlists'],
        summary: 'Add a track to a playlist',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['trackId'],
                properties: { trackId: { type: 'string', minLength: 1 } },
              },
            },
          },
        },
        responses: { 200: ok('added') },
      },
    },
    '/providers': {
      get: {
        tags: ['Providers'],
        summary: 'Provider status (configured / available / authenticated)',
        responses: { 200: ok('per-provider status') },
      },
    },
    '/devices': {
      get: {
        tags: ['Devices'],
        summary: 'Discovered output devices (DLNA / Sonos)',
        responses: { 200: ok('devices') },
      },
    },
  },
} as const;

export type OpenApiSpec = typeof openApiSpec;
