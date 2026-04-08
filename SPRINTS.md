# AudioServer Improvement Sprints

Sprintplan om alle geidentificeerde issues aan te pakken. Elke sprint is een zelfstandig geheel dat je als prompt aan Claude kunt geven.

---

## Sprint 1 — Security Hardening (Kritiek)

**Doel:** Alle kritieke security issues oplossen zodat de app veilig gedeployed kan worden.

### Prompt:

```
Voer de volgende security hardening uit op het AudioServer project:

1. **JWT secret afdwingen** — In server/src/config.ts: als NODE_ENV=production en JWT_SECRET niet gezet is (of nog 'dev-secret-change-me'), laat de server falen bij startup met een duidelijke foutmelding. Genereer in development automatisch een random secret met een warning in de logs.

2. **Rate limiting op auth endpoints** — Installeer express-rate-limit. Configureer:
   - /api/auth/login: max 5 pogingen per 15 minuten per IP
   - /api/auth/register: max 3 pogingen per uur per IP
   - Globaal: max 100 requests per minuut per IP
   Voeg de middleware toe in server/src/index.ts.

3. **Socket.IO beveiligen** — In server/src/socketio.ts:
   - Vervang `origin: '*'` door een whitelist op basis van een ALLOWED_ORIGINS env var (default: localhost:5173 in dev)
   - Voeg auth middleware toe op Socket.IO connections die het JWT token verifieert (token meegeven als query param of auth header bij connect)
   - Update de client (client/src/context/AudioContext.tsx of waar Socket.IO wordt gebruikt) om het token mee te sturen

4. **Provider tokens versleutelen** — In server/src/services/tokenstore.ts:
   - Gebruik Node.js crypto (aes-256-gcm) om tokens te encrypten voor opslag in de database
   - Gebruik JWT_SECRET als basis voor de encryption key (via PBKDF2 key derivation)
   - Migreer bestaande plaintext tokens bij eerste read (decrypt faalt → re-encrypt)

5. **First-run registratie beveiligen** — In server/src/routes/auth.ts:
   - Na de eerste user registratie, blokkeer het /register endpoint volledig
   - Geef een duidelijke 403 response als er al een user bestaat

Zorg dat alle bestaande tests blijven slagen. Voeg geen nieuwe features toe, alleen security fixes.
```

---

## Sprint 2 — Persistent Playback State & Queue

**Doel:** Playback state en queue overleven een server restart.

### Prompt:

```
Refactor de playback state van in-memory naar persistent storage:

1. **Database schema uitbreiden** — In server/src/db/schema.ts, voeg toe:
   - Tabel `playback_state`: deviceId, trackId, state (playing/paused/stopped), position (seconds), volume, updatedAt
   - Tabel `queue_items`: id (autoincrement), trackId, position (sort order), addedAt
   Voeg ook de corresponderende raw SQL toe in db/index.ts initDatabase() (zolang de duplicatie bestaat).

2. **PlaybackService aanmaken** — Maak server/src/services/playback.ts:
   - Singleton service die playback state beheert
   - Methods: getState(), setState(), getQueue(), addToQueue(), removeFromQueue(), clearQueue(), moveInQueue()
   - Lees state uit DB bij startup, schrijf wijzigingen direct naar DB
   - Houd ook een in-memory cache bij voor snelle reads
   - Emit Socket.IO events bij elke state change

3. **Routes migreren** — Refactor server/src/routes/playback.ts:
   - Vervang alle globale variabelen (nowPlaying, queue) door calls naar PlaybackService
   - Behoud exact dezelfde API endpoints en response formats
   - Verwijder de in-memory state variabelen

4. **Queue auto-advance** — In PlaybackService:
   - Als een track eindigt (state wordt 'stopped' en position >= duration - 2s), speel automatisch het volgende item uit de queue
   - Respecteer repeat modes: repeat-one (herspeel zelfde track), repeat-all (loop queue), none (stop na laatste)
   - Emit 'playback:track-changed' event via Socket.IO

5. **Testen** — Schrijf tests in server/src/__tests__/playback.test.ts:
   - Test queue CRUD operaties
   - Test state persistence (schrijf, lees terug)
   - Test auto-advance logica

Zorg dat de client GEEN aanpassingen nodig heeft — de API responses moeten identiek blijven.
```

---

## Sprint 3 — Real-time Device Sync (WebSocket)

**Doel:** Vervang client-side polling door server-push via Socket.IO.

### Prompt:

```
Vervang de 2-seconde polling op de client door real-time WebSocket events:

1. **Server-side device polling** — Maak server/src/services/device-monitor.ts:
   - Singleton die actieve devices pollt (elke 2s) voor playback status
   - Vergelijk nieuwe status met vorige status
   - Bij verschil: emit Socket.IO event 'device:playback-update' met { deviceId, state, position, duration, volume }
   - Start polling alleen voor devices die actief aan het afspelen zijn
   - Stop polling als device stopt of geen clients meer luisteren

2. **Device ↔ Server state sync** — In de device monitor:
   - Als een device extern gestopt wordt (bijv. via fysieke remote), update de PlaybackService state
   - Als een track eindigt op een extern device, trigger queue auto-advance via PlaybackService
   - Log state transitions voor debugging

3. **Socket.IO events centraliseren** — In server/src/socketio.ts:
   - Definieer alle event types als TypeScript interface (ServerToClientEvents, ClientToServerEvents)
   - Events: 'playback:state', 'playback:queue', 'playback:track-changed', 'device:playback-update', 'device:discovered', 'device:lost'
   - Voeg client→server event handlers toe: 'device:subscribe' (start monitoring), 'device:unsubscribe'

4. **Client migreren** — In client/src/context/AudioContext.tsx:
   - Installeer socket.io-client als dependency (als dat nog niet is)
   - Connect met Socket.IO bij mount, stuur JWT token mee
   - Luister naar 'device:playback-update' voor positie/state updates
   - Luister naar 'playback:track-changed' voor auto-advance
   - VERWIJDER de 2-seconde setInterval polling logica
   - Houd een fallback: als WebSocket disconnected, val terug op polling

5. **Testen** — Verifieer dat:
   - Externe device pause/stop reflected wordt in de UI zonder delay
   - Track auto-advance werkt via server-push
   - WebSocket reconnect na disconnect werkt
```

---

## Sprint 4 — Database Consolidatie & Paginatie

**Doel:** Elimineer schema duplicatie en voeg paginatie toe voor grote libraries.

### Prompt:

```
Ruim de database laag op en voeg paginatie toe:

1. **Elimineer schema duplicatie** — In server/src/db/index.ts:
   - Verwijder de volledige raw SQL CREATE TABLE/INDEX statements uit initDatabase()
   - Gebruik Drizzle's push of migrate functionaliteit om het schema te synchroniseren
   - Als Drizzle push niet geschikt is voor SQLite, gebruik dan drizzle-kit generate + migrate
   - Zorg dat de database correct aangemaakt wordt op een verse installatie
   - Test dat bestaande databases niet breken (backwards compatible)

2. **Paginatie op library endpoints** — In server/src/routes/library.ts:
   - GET /api/library/artists: accepteer ?page=1&limit=50 (default limit=50)
   - GET /api/library/albums: accepteer ?page=1&limit=50
   - GET /api/library/tracks: accepteer ?page=1&limit=100
   - GET /api/library/search: accepteer ?limit=20
   - Response format: { data: [...], meta: { page, limit, total, totalPages } }
   - Sorteer consistent: artists op naam, albums op titel, tracks op albumId+trackNumber

3. **Provider paginatie** — In server/src/providers/local.ts:
   - Update getArtists(), getAlbums() om limit/offset te accepteren
   - Voeg COUNT queries toe voor totalen

4. **Client aanpassen** — In de relevante pages:
   - ArtistsPage: implementeer infinite scroll of "load more" button
   - AlbumsPage: idem
   - Gebruik een custom hook useInfiniteLoad(fetchFn, limit) voor hergebruik
   - Toon totaal aantal items in de header

5. **API client updaten** — In client/src/api/client.ts:
   - Update getArtists(), getAlbums() etc. om page/limit params te accepteren
   - Return type moet meta informatie bevatten
```

---

## Sprint 5 — Code Kwaliteit & DRY

**Doel:** Elimineer duplicatie, verbeter type safety, voeg Error Boundary toe.

### Prompt:

```
Verbeter de code kwaliteit van het AudioServer project:

1. **Shared utilities extraheren** — Maak client/src/utils/format.ts:
   - Verplaats formatDuration() (komt voor in AlbumPage, PlaylistPage, SearchPage, NowPlayingBar) naar dit bestand
   - Verplaats andere gedupliceerde helpers (formatTime, getGradient, etc.) als die bestaan
   - Update alle imports in de bestaande files

2. **API client consistentie** — In client/src/api/client.ts:
   - Zoek alle plekken waar direct fetch() wordt gebruikt i.p.v. de api wrapper (health endpoint, provider endpoints, etc.)
   - Migreer ze naar de fetchApi wrapper
   - Voeg ontbrekende typed methods toe voor alle endpoints die nu inline fetch() gebruiken

3. **TypeScript strictness** — Door het hele client/ project:
   - Zoek en vervang alle `as any` type assertions door correcte types
   - Definieer response types voor API calls (gebruik shared types waar mogelijk)
   - Voeg types toe voor de Socket.IO events (gedeeld met server als dat praktisch is)

4. **Error Boundary** — Maak client/src/components/ErrorBoundary.tsx:
   - Class component met componentDidCatch
   - Toon een user-friendly error pagina met "Herlaad" knop
   - Log errors naar console
   - Wrap de main App routes in deze ErrorBoundary (in App.tsx)

5. **Hardcoded device namen verwijderen** — In client/src/context/AudioContext.tsx:
   - Zoek de hardcoded device name matching ("Cocktail", "X35", etc.)
   - Maak dit configureerbaar: sla device-to-provider mappings op in localStorage of haal ze uit een settings endpoint
   - Alternatief: gebruik het device type veld i.p.v. name matching

6. **Constants centraliseren** — Maak client/src/constants.ts:
   - Polling intervals, API paths, localStorage keys, default waarden
   - Vervang alle magic strings/numbers door deze constants

Voer geen functionele wijzigingen door. Alleen refactoring en type improvements.
```

---

## Sprint 6 — Client Testing

**Doel:** Testcoverage toevoegen voor de kritieke client logica.

### Prompt:

```
Voeg een test setup en tests toe aan het AudioServer client:

1. **Test setup** — In client/:
   - Installeer vitest + @testing-library/react + @testing-library/jest-dom + jsdom
   - Configureer vitest in vite.config.ts (environment: jsdom, globals: true)
   - Maak client/src/test/setup.ts met jsdom setup

2. **API client tests** — client/src/api/__tests__/client.test.ts:
   - Mock fetch globally
   - Test dat auth token wordt meegestuurd
   - Test error handling (non-200 responses)
   - Test elke API method (minimaal: getArtists, getAlbums, login, register)

3. **AudioContext tests** — client/src/context/__tests__/AudioContext.test.tsx:
   - Test queue management: add, remove, clear, reorder
   - Test shuffle mode: toggleShuffle produceert random volgorde
   - Test repeat modes: none (stopt na laatste), one (herhaalt), all (loopt)
   - Test playTrack: juiste stream URL constructie per provider type
   - Test volume control: set, mute/unmute
   - Mock de useAudio hook en api calls

4. **Utility tests** — client/src/utils/__tests__/format.test.ts:
   - Test formatDuration met edge cases (0, undefined, negatief, grote waarden)
   - Test andere utility functies

5. **Component tests** — client/src/components/__tests__/:
   - NowPlayingBar: toont track info, play/pause toggle, progress bar
   - Toast: auto-dismiss na timeout, meerdere toasts tegelijk
   - ErrorBoundary: vangt errors, toont fallback UI

6. **npm script** — Voeg toe aan client/package.json:
   - "test": "vitest run"
   - "test:watch": "vitest"
   - Update root package.json: "test": "npm run test --workspaces"
```

---

## Sprint 7 — Provider Maturiteit (Tidal & Qobuz)

**Doel:** Tidal provider implementeren, Qobuz afmaken.

### Prompt:

```
Maak de streaming providers productieklaar:

1. **Tidal provider voltooien** — In server/src/providers/tidal.ts:
   - Implementeer token persistence: laad opgeslagen tokens uit DB bij initialize()
   - Implementeer token refresh flow
   - Implementeer getArtists(), getAlbums(), getAlbumTracks() via Tidal API v2
   - Implementeer search() met mapping naar shared types
   - Implementeer getStreamUrl() — Tidal biedt HiFi/MQA streams via hun API
   - Implementeer getPlaylists() en getPlaylistTracks()
   - Voeg OAuth callback handling toe in server/src/routes/providers.ts
   - Voeg Tidal login UI toe in client/src/pages/SettingsPage.tsx (vergelijkbaar met Spotify)

2. **Qobuz provider verbeteren** — In server/src/providers/qobuz.ts:
   - Fix/implementeer de stream URL signing (HKDF signature indien nodig)
   - Voeg token refresh toe (re-login bij expiry)
   - Implementeer getPlaylists() en getPlaylistTracks()
   - Test met een echt Qobuz account

3. **Provider status in UI** — In client/src/pages/SettingsPage.tsx:
   - Toon per provider: connected/disconnected status, account naam, subscription tier
   - Toon "laatst gesynchroniseerd" timestamp
   - Voeg disconnect/logout knop toe per provider

4. **Zoekresultaten deduplicatie** — In server/src/providers/registry.ts:
   - Bij searchAll(): detecteer duplicaten tussen providers (zelfde track titel + artiest)
   - Markeer duplicaten met een 'availableOn: ["local", "spotify"]' veld
   - Geef voorkeur aan local > qobuz > tidal > spotify voor stream URL

5. **Tests** — In server/src/__tests__/providers.test.ts:
   - Unit tests voor elke provider met gemockte HTTP responses
   - Test token refresh flows
   - Test search result mapping naar shared types
   - Test deduplicatie logica
```

---

## Sprint 8 — DLNA Robuustheid & Device UX

**Doel:** DLNA playback betrouwbaarder maken, device UX verbeteren.

### Prompt:

```
Verbeter de device/DLNA laag:

1. **DLNA state machine** — In server/src/devices/dlna.ts:
   - Vervang de hardcoded 1s waits door een state machine: IDLE → LOADING → PLAYING → PAUSED → STOPPED
   - Na elke SOAP command, poll de device status (max 5 pogingen, 500ms interval) tot de verwachte state bereikt is
   - Timeout na 5s met duidelijke error
   - Log elke state transitie

2. **Device health checks** — In server/src/devices/manager.ts:
   - Voeg een periodic health check toe (elke 60s) voor actieve devices
   - Stuur een simpele GetTransportInfo SOAP request
   - Markeer device als offline als 3 opeenvolgende checks falen
   - Emit 'device:lost' Socket.IO event bij offline
   - Emit 'device:discovered' bij terugkeer

3. **Device grouping (Sonos)** — In server/src/devices/sonos.ts:
   - Detecteer Sonos groepen via de ZoneGroupTopology service
   - Toon groepen in de UI (bijv. "Woonkamer + Keuken")
   - Play naar een groep = play naar de group coordinator

4. **Device UX verbeteren** — In de client:
   - Voeg een device selector component toe (dropdown of modal)
   - Toon per device: naam, type icoon, online/offline status, huidige volume
   - Toon "Now playing on [device]" in de NowPlayingBar
   - Voeg volume slider per device toe
   - Onthoud laatst gebruikte device in localStorage

5. **Fallback bij device failure** — In server/src/devices/manager.ts:
   - Als play naar een device faalt, probeer opnieuw (1x retry)
   - Als retry faalt, emit error event naar client
   - Client toont toast: "Kan niet afspelen op [device]. Terugvallen op browser?"
```

---

## Sprint 9 — Library Scanner & Metadata

**Doel:** Scanner robuuster en sneller maken, metadata verbeteren.

### Prompt:

```
Verbeter de library scanner en metadata handling:

1. **Incrementele scan** — In server/src/services/scanner.ts:
   - Bij een rescan, vergelijk file modification time met de opgeslagen updatedAt
   - Skip bestanden die niet gewijzigd zijn
   - Verwijder tracks uit de DB waarvan het bestand niet meer bestaat
   - Verwijder albums/artists zonder tracks (orphan cleanup)
   - Toon stats: "X nieuwe, Y updated, Z verwijderd"

2. **Scan progress via WebSocket** — In scanner.ts + socketio:
   - Emit 'library:scan-progress' events: { phase, processedFiles, totalFiles, currentFile, newTracks, updatedTracks }
   - Fasen: 'discovering' (bestanden zoeken), 'scanning' (metadata lezen), 'cleaning' (orphans), 'done'
   - Client: vervang de polling in SettingsPage/AlbumsPage door WebSocket listener

3. **Cover art persistent cache** — In server/src/services/coverart.ts:
   - Sla geextraheerde covers op als bestanden in een cache directory (data/covers/)
   - Bestandsnaam: albumId.jpg
   - Check disk cache voor LRU memory cache
   - Voeg een endpoint toe: GET /api/library/albums/:id/cover (serveert uit cache)
   - Bij scan: extract covers direct en sla op

4. **Betere metadata parsing** — In scanner.ts:
   - Parse genre tags en sla op in albums tabel
   - Parse composer/conductor tags (klassieke muziek)
   - Detecteer compilations/various artists albums
   - Handle multi-value artist tags (feat., &, vs.)

5. **Watcher mode** — In scanner.ts:
   - Gebruik fs.watch() of chokidar om MUSIC_LIBRARY_PATHS te monitoren
   - Bij nieuwe/gewijzigde bestanden: automatische incrementele scan
   - Debounce: wacht 5s na laatste change voor scan start
   - Configureerbaar via WATCH_LIBRARY=true env var
```

---

## Sprint 10 — Polish & Production Readiness

**Doel:** Laatste verbeteringen voor een productiewaardige release.

### Prompt:

```
Laatste polish voor production readiness:

1. **Logging verbeteren** — In server/src/logger.ts:
   - Voeg request logging middleware toe (method, path, status, duration)
   - Log level configureerbaar via LOG_LEVEL env var
   - In production: JSON format voor structured logging
   - In development: pretty print met kleuren
   - Voeg correlation IDs toe aan requests

2. **Graceful shutdown** — In server/src/index.ts:
   - Handle SIGTERM en SIGINT
   - Stop device monitoring
   - Sluit Socket.IO connections
   - Sluit database connection
   - Stop librespot process als die draait
   - Timeout na 10s: force exit

3. **Health endpoint uitbreiden** — In server/src/routes/health.ts:
   - Voeg toe: database status, aantal tracks/albums/artists
   - Provider statussen (connected/disconnected per provider)
   - Actieve devices
   - Librespot status
   - Uptime en memory usage

4. **Docker optimalisatie** — In Dockerfile:
   - Multi-stage build: build stage (npm ci + build) → runtime stage (alleen production deps)
   - Voeg healthcheck toe: HEALTHCHECK CMD curl -f http://localhost:3001/api/health
   - Reduceer image size
   - Pin Node.js versie exact

5. **Environment validatie** — In server/src/config.ts:
   - Valideer alle env vars bij startup
   - Check dat MUSIC_LIBRARY_PATHS directories bestaan en leesbaar zijn
   - Check dat DATABASE_PATH directory schrijfbaar is
   - Geef duidelijke foutmeldingen per ontbrekende/ongeldige var
   - Toon een startup summary in de logs: welke providers actief, welke paths, welke devices geconfigureerd

6. **Client build optimalisatie** — In client/vite.config.ts:
   - Code splitting per route (lazy imports)
   - Compressie plugin (gzip/brotli)
   - Bundle analyse script
   - Service worker voor offline album art caching (optioneel)

7. **README updaten** — Update de root README.md:
   - Installatie instructies (Docker + bare metal)
   - Configuratie overzicht (alle env vars)
   - Screenshots
   - Supported devices lijst
   - Troubleshooting sectie
```

---

## Sprint 11 — Essentials UI

**Doel:** De meest gevraagde ontbrekende UI-features toevoegen met minimale inspanning — backend API's bestaan al.

### Wijzigingen:

1. **Favorieten pagina** — `client/src/pages/FavoritesPage.tsx`:
   - Tabs voor Albums / Artiesten / Tracks
   - Albums en artiesten in grid-layout met covers
   - Tracks als klikbare lijst met album art, duur, en play-actie
   - Gebruikt bestaande `GET /api/history/favorites?type=` endpoints
   - Nieuw backend endpoint: `GET /api/history/favorites/tracks` voor verrijkte track-favorieten

2. **Geschiedenis pagina** — `client/src/pages/HistoryPage.tsx`:
   - Drie views: "All Plays" (chronologisch), "Recent Albums", "Top Artists"
   - Track-level geschiedenis met relatieve tijden ("2h ago", "Yesterday")
   - Paginatie met "Load More" knop
   - Nieuw backend endpoint: `GET /api/history/tracks?page=1&limit=50` voor track-level history

3. **Recentelijk Toegevoegd op Homepage** — `client/src/pages/HomePage.tsx`:
   - Nieuwe sectie boven "Recently Played" met laatst toegevoegde albums
   - Nieuw backend endpoint: `GET /api/library/albums/recent?limit=20` gesorteerd op `created_at DESC`

4. **Navigatie-update** — `client/src/components/Layout.tsx`:
   - "Favorites" en "History" toegevoegd aan de navigatiebalk
   - Routes toegevoegd in `client/src/App.tsx`

---

## Sprint 12 — Interactie & Shortcuts

**Doel:** De app voelt professioneel en responsief met keyboard shortcuts, queue editing, fullscreen view en statistieken.

### Wijzigingen:

1. **Keyboard shortcuts** — `client/src/hooks/useKeyboardShortcuts.ts`:
   - Spatie: play/pause
   - Shift+←/→: vorige/volgende track
   - Shift+↑/↓: volume omhoog/omlaag
   - M: mute/unmute
   - S: shuffle toggle
   - R: repeat toggle
   - /: ga naar zoekpagina
   - Negeert input wanneer gebruiker typt in input/textarea velden

2. **Queue bewerking** — `client/src/components/NowPlayingBar.tsx`:
   - Verwijder knop per queue item (hover)
   - Verplaats omhoog/omlaag knoppen (hover)
   - "Clear" knop om hele queue te wissen
   - Queue telt nu tracks in header
   - Nieuwe AudioContext methods: `removeFromQueue()`, `moveInQueue()`
   - API client: `removeFromQueue()`, `moveInQueue()` (backend endpoints bestonden al)

3. **Fullscreen Now Playing** — `client/src/components/NowPlayingFull.tsx`:
   - Volledig scherm met grote album art en blur achtergrond
   - Track info, progress bar met seek, alle playback controls
   - "Up Next" zijpaneel met komende tracks uit queue
   - Openen via klik op album art in NowPlayingBar
   - Sluiten via Escape of chevron-knop
   - Lazy-loaded component

4. **Bibliotheek statistieken** — `server/src/routes/health.ts` + `client/src/pages/HomePage.tsx`:
   - Backend uitgebreid met: totale speeltijd, formaat-verdeling, sample rates, bit depths, top genres
   - Homepage toont: totale speeltijd, top formaat, genre tags

---

## Sprint 13 — Drag-and-Drop & Playlists

**Doel:** Playlist en queue management op Spotify-niveau met drag-and-drop en M3U import/export.

### Wijzigingen:

1. **Drag-and-drop queue reordering** — `client/src/components/NowPlayingBar.tsx`:
   - Queue items zijn nu versleepbaar via @dnd-kit
   - Drag handle (&#9776;) per item
   - Herbruikbaar `SortableList` component

2. **Drag-and-drop playlist tracks** — `client/src/pages/PlaylistPage.tsx`:
   - Tracks in playlists zijn versleepbaar
   - Volgorde wordt opgeslagen via nieuw `POST /playlists/:id/reorder` endpoint
   - Tabel-layout vervangen door compactere SortableList

3. **M3U Export** — `server/src/routes/playlists.ts`:
   - `GET /playlists/:id/export` genereert M3U met #EXTINF metadata
   - "Export M3U" knop op PlaylistPage

4. **M3U Import** — `server/src/routes/playlists.ts` + `client/src/pages/PlaylistsPage.tsx`:
   - `POST /playlists/import` parst M3U en matcht tracks op bestandspad (exact + fuzzy filename)
   - "Import M3U" knop met file picker op PlaylistsPage
   - Toast feedback met aantal gematchte tracks

---

## Sprint 14 — Music Discovery

**Doel:** Bibliotheek verkenning verbeteren met genre browsen en smart playlists.

### Wijzigingen:

1. **Genre browsen** — `server/src/routes/library.ts` + `client/src/pages/GenresPage.tsx`:
   - `GET /api/library/genres` retourneert unieke genres met album- en track-counts
   - `GET /api/library/genres/:genre/albums` retourneert albums per genre (gepagineerd)
   - GenresPage met kleurrijke genre-cards en album grid per genre
   - Navigatie-item "Genres" toegevoegd

2. **Smart Playlists** — `server/src/routes/smart-playlists.ts` + `client/src/pages/SmartPlaylistsPage.tsx`:
   - Nieuwe `smart_playlists` tabel in database schema
   - Rule engine: filter op genre, jaar, formaat, sample rate, bit depth, artiest
   - Operators: equals, contains, greaterThan, lessThan, between
   - Tracks worden altijd dynamisch gegenereerd (niet opgeslagen)
   - CRUD endpoints: GET/POST/PATCH/DELETE + GET /:id/tracks
   - Visuele rule builder UI met dropdowns
   - "Play All" functionaliteit

---

## Sprint 15 — Tidal Streaming

**Doel:** De multi-provider belofte waarmaken door Tidal streaming, playlists en favorites te implementeren.

### Wijzigingen:

1. **Tidal Stream URL** — `server/src/providers/tidal.ts`:
   - `getStreamUrl()` implementeert twee strategieën:
     - Legacy API `playbackinfopostpaywall` endpoint (base64 manifest → URL extractie)
     - Fallback: `urlpostpaywall` endpoint
   - Ondersteunt LOSSLESS audio quality
   - OAuth scope uitgebreid met `playback`
   - Nieuwe legacy API helper (`legacyApiRequest`) voor api.tidal.com/v1

2. **Tidal Playlists** — Provider + routes:
   - `getPlaylists()` haalt user playlists op via legacy API
   - `getPlaylistTracks()` haalt tracks per playlist op
   - Routes: `GET /providers/tidal/playlists`, `GET /providers/tidal/playlists/:id/tracks`

3. **Tidal Favorites/Collection** — Provider + routes:
   - `getFavoriteAlbums()`, `getFavoriteTracks()`, `getFavoriteArtists()`
   - Routes: `GET /providers/tidal/favorites/{albums,tracks,artists}`

4. **Tidal Album Browse** — Routes:
   - `GET /providers/tidal/albums/:id` en `GET /providers/tidal/albums/:id/tracks`
   - `GET /providers/tidal/tracks/:id/stream` voor directe stream URL

5. **Frontend Tidal Playback** — `client/src/context/AudioContext.tsx`:
   - Tidal tracks (`tidal:` prefix) worden nu afgespeeld via stream URL
   - Browser playback: directe URL naar audio element
   - Device playback: stream URL naar DLNA/Volumio/Sonos

6. **API Client** — `client/src/api/client.ts`:
   - 8 nieuwe Tidal API methods (album, tracks, stream, playlists, favorites)

---

## Sprint 16 — Scrobbling & Integraties

**Doel:** Verbinding met het muziek-ecosysteem via Last.fm en ListenBrainz scrobbling.

### Wijzigingen:

1. **Scrobbling Service** — `server/src/services/scrobbler.ts`:
   - Last.fm: `track.scrobble` + `track.updateNowPlaying` met MD5-signed API calls
   - ListenBrainz: `submit-listens` (single + playing_now) met token auth
   - Persistent queue in SQLite (`scrobble_queue` tabel) met retry (max 5)
   - Queue processor draait elke 30 seconden
   - Auto-scrobble bij elke `POST /api/history/played` call

2. **Database** — Nieuwe tabellen:
   - `scrobble_config`: singleton met Last.fm session key + ListenBrainz token
   - `scrobble_queue`: pending/sent/failed scrobbles met retries

3. **API Routes** — `server/src/routes/scrobble.ts`:
   - `GET /config` — huidige scrobbling status
   - `GET /lastfm/auth-url` — Last.fm autorisatie URL
   - `POST /lastfm/auth` — token exchange voor session key
   - `POST /lastfm/disconnect` — Last.fm uitschakelen
   - `POST /listenbrainz/auth` — token validatie en opslag
   - `POST /listenbrainz/disconnect` — ListenBrainz uitschakelen

4. **Settings UI** — `client/src/pages/SettingsPage.tsx`:
   - Last.fm: Authorize knop → token invoer → connected status
   - ListenBrainz: Token invoer → connected status
   - Disconnect knoppen voor beide services
   - Env vars: `LASTFM_API_KEY`, `LASTFM_API_SECRET`

---

## Sprint 17 — Gapless & Audio Kwaliteit

**Doel:** Audiophile features: gapless playback, crossfade, en audio quality indicators.

### Wijzigingen:

1. **Gapless browser playback** — `client/src/hooks/useAudio.ts`:
   - Volledig herschreven met dual-audio-element architectuur
   - Pre-buffer volgende track via `preloadNext(url)`
   - Crossfade met configureerbare duur (0-12 seconden)
   - Bij crossfade > 0: volume fade-out op oude track, fade-in op nieuwe track
   - Bij crossfade = 0: gapless overgang

2. **DLNA gapless** — `server/src/devices/dlna.ts`:
   - `SetNextAVTransportURI` SOAP actie voor gapless queue
   - Graceful fallback als device het niet ondersteunt
   - Route: `POST /devices/:id/set-next` via device manager

3. **Crossfade configuratie** — AudioContext + NowPlayingFull:
   - `crossfade` state (0-12 seconden) opgeslagen in localStorage
   - Crossfade slider in fullscreen Now Playing view
   - 0 = gapless (standaard), >0 = crossfade met die duur

4. **Audio quality indicator** — NowPlayingBar + NowPlayingFull:
   - Track formaat badge (FLAC, MP3, etc.) in NowPlayingBar
   - Sample rate en bit depth weergave (bijv. "44.1kHz / 16-bit")
   - Uitgebreide quality info in fullscreen view

---

## Sprint Volgorde & Afhankelijkheden

```
Sprint 1 (Security)          ← EERSTE: kritieke fixes
Sprint 2 (Persistent State)  ← Basis voor Sprint 3
Sprint 3 (WebSocket Sync)    ← Bouwt op Sprint 2
Sprint 4 (DB & Paginatie)    ← Onafhankelijk, kan parallel met 3
Sprint 5 (Code Kwaliteit)    ← Na 1-4, refactort bestaande code
Sprint 6 (Client Tests)      ← Na Sprint 5 (test de opgeschoonde code)
Sprint 7 (Providers)         ← Onafhankelijk, kan eerder
Sprint 8 (DLNA/Devices)      ← Na Sprint 3 (gebruikt WebSocket)
Sprint 9 (Scanner)           ← Na Sprint 3 (gebruikt WebSocket)
Sprint 10 (Polish)           ← Production readiness
Sprint 11 (Essentials UI)    ← Favorieten, Geschiedenis, Recently Added
Sprint 12 (Interactie)       ← Shortcuts, Queue editing, Fullscreen, Stats
Sprint 13 (Drag & Playlists) ← DnD queue/playlist, M3U import/export
Sprint 14 (Music Discovery)  ← Genres, Smart Playlists
Sprint 15 (Tidal Streaming)  ← Stream URLs, playlists, favorites
Sprint 16 (Scrobbling)       ← Last.fm + ListenBrainz scrobbling
Sprint 17 (Audio Kwaliteit)  ← Gapless, crossfade, quality indicator
```

Geschatte doorlooptijd per sprint: 1-2 sessies met Claude.
