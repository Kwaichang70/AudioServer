import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { resolveApiKey } from '../services/api-keys.js';
import {
  ControlError,
  listPlaylists,
  listRooms,
  nowPlaying,
  pauseRoom,
  playInRoom,
  resolveRoom,
  resumeRoom,
  setRoomVolume,
  skipInRoom,
  stopInRoom,
} from '../services/remote-control.js';
import { searchLocal } from '../services/local-search.js';
import { transferZone, TransferError } from '../services/zone-transfer.js';
import { zones } from '../services/zones.js';
import type { PlaybackOrigin } from '../types/socket-events.js';
import { logger } from '../logger.js';

/**
 * MCP server for assistants (step 3): Grok (grok.com → Connectors → Custom),
 * Jarvis, or any MCP client. Streamable HTTP, stateless: every POST builds a
 * fresh server for the caller, so nothing is kept between requests.
 *
 * Only API keys get in (Settings → Account → API keys), sent as
 * "Authorization: Bearer as_…" or "X-API-Key: as_…", or — for a client that
 * cannot send headers — in the address: /mcp/as_…. The tools are the simple
 * commands of /api/control, so a key can do here exactly what it can there.
 */
export const mcpRouter = Router();

interface Caller {
  userId: string;
  keyId: string;
}

function callerOf(req: Request): Caller | null {
  const auth = req.headers.authorization;
  const header = req.headers['x-api-key'];
  const candidates = [
    typeof req.params.key === 'string' ? req.params.key : null,
    auth?.startsWith('Bearer ') ? auth.slice(7) : null,
    typeof header === 'string' ? header : null,
  ];
  for (const candidate of candidates) {
    const key = candidate ? resolveApiKey(candidate) : null;
    if (key) return { userId: key.userId, keyId: key.keyId };
  }
  return null;
}

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

/** Run a tool; a ControlError becomes a readable tool error with the names that exist. */
async function tool(run: () => unknown | Promise<unknown>) {
  try {
    return text(await run());
  } catch (err) {
    if (err instanceof ControlError || err instanceof TransferError) {
      const options = err instanceof ControlError && err.options.length ? err.options : undefined;
      return { ...text({ error: err.message, options }), isError: true };
    }
    logger.warn(`MCP tool failed: ${err}`);
    return { ...text({ error: 'Something went wrong on the server.' }), isError: true };
  }
}

const room = z
  .string()
  .optional()
  .describe(
    'Room name as shown by list_rooms. May be left out when there is only one speaker room.',
  );

export function buildMcpServer(caller: Caller): McpServer {
  const origin: PlaybackOrigin = { clientId: `mcp:${caller.keyId}`, sessionId: null };
  const server = new McpServer({ name: 'audioserver', version: '1.0.0' });

  server.registerTool(
    'list_rooms',
    {
      title: 'List rooms',
      description:
        'The rooms (speakers) of the house, with what plays in each and the volume. Call this first to learn the room names.',
      annotations: { readOnlyHint: true },
    },
    () => tool(() => listRooms()),
  );

  server.registerTool(
    'list_playlists',
    {
      title: 'List playlists',
      description: "The user's playlists and smart playlists by name.",
      annotations: { readOnlyHint: true },
    },
    () => tool(() => listPlaylists(caller.userId)),
  );

  server.registerTool(
    'search_library',
    {
      title: 'Search the music library',
      description:
        'Find artists, albums and tracks in the local library. Names need no exact case or accents.',
      inputSchema: {
        query: z.string().min(1).describe('What to look for, e.g. "prince purple"'),
        limit: z.number().int().min(1).max(25).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ query, limit }) =>
      tool(() => {
        const found = searchLocal(query, { limit: limit ?? 10 });
        return {
          artists: found.artists.map((a) => a.name),
          albums: found.albums.map((a) => ({ title: a.title, artist: a.artistName, year: a.year })),
          tracks: found.tracks.map((t) => ({
            title: t.title,
            artist: t.artistName,
            album: t.albumTitle,
          })),
        };
      }),
  );

  server.registerTool(
    'now_playing',
    {
      title: 'What is playing',
      description: 'What plays in a room right now: track, artist, album, state and volume.',
      inputSchema: { room },
      annotations: { readOnlyHint: true },
    },
    ({ room: r }) => tool(() => nowPlaying(r)),
  );

  server.registerTool(
    'play',
    {
      title: 'Play music in a room',
      description:
        'Play a playlist, an album or an artist in a room, by name. Give exactly one of playlist, album or artist (artist may be added to album to pick the right one). Replaces what the room was playing.',
      inputSchema: {
        room,
        playlist: z.string().optional().describe('Playlist name (list_playlists)'),
        album: z.string().optional().describe('Album title'),
        artist: z
          .string()
          .optional()
          .describe('Artist name; alone it plays the artist, album by album'),
        shuffle: z.boolean().optional().describe('Shuffle the tracks'),
      },
    },
    (args) => tool(() => playInRoom(caller.userId, args, origin)),
  );

  for (const [name, title, run] of [
    ['pause', 'Pause', (r?: string) => pauseRoom(r, origin)],
    ['resume', 'Resume', (r?: string) => resumeRoom(r, caller.userId, origin)],
    ['stop', 'Stop', (r?: string) => stopInRoom(r)],
    ['next_track', 'Next track', (r?: string) => skipInRoom(r, 'next', origin)],
    ['previous_track', 'Previous track', (r?: string) => skipInRoom(r, 'previous', origin)],
  ] as const) {
    server.registerTool(
      name,
      { title, description: `${title} in a room.`, inputSchema: { room } },
      ({ room: r }) => tool(() => run(r)),
    );
  }

  server.registerTool(
    'set_volume',
    {
      title: 'Set the volume',
      description: 'Set the volume of a room, 0 to 100.',
      inputSchema: { room, volume: z.number().min(0).max(100) },
    },
    ({ room: r, volume }) => tool(() => setRoomVolume(r, volume, origin)),
  );

  server.registerTool(
    'move_music',
    {
      title: 'Move the music to another room',
      description:
        'Move what plays in one room to another: the queue and the position go along, the first room stops.',
      inputSchema: {
        from: z.string().describe('Room that plays now'),
        to: z.string().describe('Room to move the music to'),
      },
    },
    ({ from, to }) =>
      tool(async () => {
        const source = resolveRoom(from);
        const target = resolveRoom(to);
        const result = await transferZone(source.id, target.id, caller.userId, origin);
        return {
          from: result.from.name,
          to: result.to.name,
          resumedAtPosition: result.resumedAtPosition,
          note: result.note,
          track: zones.sessionFor(target.id).getCurrentTrack()?.title ?? null,
        };
      }),
  );

  return server;
}

async function handle(req: Request, res: Response): Promise<void> {
  const caller = callerOf(req);
  if (!caller) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'An AudioServer API key is required (Settings → Account → API keys).',
      },
      id: null,
    });
    return;
  }
  const server = buildMcpServer(caller);
  // Plain JSON answers: nothing streams, and a reverse proxy cannot buffer them.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

/** Stateless: no event stream to open and no session to end. */
function notAllowed(_req: Request, res: Response): void {
  res
    .status(405)
    .set('Allow', 'POST')
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Use POST.' }, id: null });
}

const asyncRoute =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

mcpRouter.post('/', asyncRoute(handle));
mcpRouter.post('/:key', asyncRoute(handle));
mcpRouter.get(['/', '/:key'], notAllowed);
mcpRouter.delete(['/', '/:key'], notAllowed);
