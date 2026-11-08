# AudioServer

Self-hosted music streamer (Roon alternative) with a local library, Qobuz, Spotify (Connect) and Tidal providers, and multi-room output to Sonos, DLNA and Volumio.

## Quick start

```bash
npm install
npm run dev          # starts backend (:3001) + frontend (:5173)
```

The backend must be started with ESM loader for music-metadata compatibility:

```bash
node --import tsx/esm server/src/index.ts        # no watch
node --import tsx/esm --watch server/src/index.ts # with watch
```

The `npm run dev` script uses `concurrently` to start both. The server `dev` script already includes `--import tsx/esm`.

## Project structure

Monorepo with npm workspaces: `shared/`, `server/`, `client/`.

- **shared/** — TypeScript types + interfaces (MusicProvider, DeviceController, Track, Album, etc.)
- **server/** — Express backend, SQLite (better-sqlite3 + Drizzle ORM), Socket.IO
- **client/** — React + Vite + TailwindCSS SPA

## Key architectural decisions

- **Provider pattern**: every music source implements `MusicProvider` interface (shared/src/provider.ts). Local, Qobuz, Spotify (browse + Spotify Connect, no audio stream) and Tidal (browse; streaming unverified) are implemented. Spotify in a room from the server: `services/spotify-rooms.ts`.
- **Device pattern**: every output target implements `DeviceController` interface (shared/src/device.ts): Sonos, DLNA and Volumio are real; the server drives a room's speaker itself (`services/server-player.ts`).
- **UNC paths**: NAS paths must use forward slashes (`//diskstation/Music`) — `path.join()` breaks UNC paths on Windows. The scanner concatenates with `/` directly.
- **ESM + music-metadata**: `tsx` CJS mode can't load `file-type` (pure ESM dep of music-metadata). Use `node --import tsx/esm` instead of `tsx` directly.
- **SQLite timestamps**: Drizzle sends explicit NULL for unset columns, overriding SQL DEFAULT. Timestamp columns are nullable.
- **Cover art**: extracted from embedded audio metadata at request time, cached in-memory (LRU, 200 entries).
- **Focus** (`server/src/services/focus.ts`): one filter language for library lists, facets, bookmarks and smart playlists (OR within a facet, AND across; sort keys whitelisted; values bound). Smart playlists store a definition: Focus query strings ORed, a sort, a limit.
- **Accent-free search**: `*_norm` columns are kept by triggers that call the SQLite function `search_text`, registered in `initDatabase`. Any other program writing artists/albums/tracks must register it too, or its writes fail.

## Tests

```bash
cd server && npx vitest run
```

## Docker

```bash
MUSIC_PATH=/path/to/music docker compose up --build
```

In production, the server serves the client static files from `client/dist/`.

## Environment variables

See `.env.example`. Key vars: `MUSIC_LIBRARY_PATHS`, `DATABASE_PATH`, `PORT`.
