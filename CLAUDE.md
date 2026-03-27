# AudioServer

Self-hosted music streamer (Roon alternative) with local library, streaming service stubs, and multi-room device output.

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

- **Provider pattern**: every music source implements `MusicProvider` interface (shared/src/provider.ts). Local is implemented; Tidal/Spotify are stubs.
- **Device pattern**: every output target implements `DeviceController` interface (shared/src/device.ts). Currently mock devices.
- **UNC paths**: NAS paths must use forward slashes (`//diskstation/Music`) — `path.join()` breaks UNC paths on Windows. The scanner concatenates with `/` directly.
- **ESM + music-metadata**: `tsx` CJS mode can't load `file-type` (pure ESM dep of music-metadata). Use `node --import tsx/esm` instead of `tsx` directly.
- **SQLite timestamps**: Drizzle sends explicit NULL for unset columns, overriding SQL DEFAULT. Timestamp columns are nullable.
- **Cover art**: extracted from embedded audio metadata at request time, cached in-memory (LRU, 200 entries).

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
