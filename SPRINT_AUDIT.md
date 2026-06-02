# Sprint Audit 8-20

Auditdatum: 2026-06-02

Scope: code-audit op de lokale repository. Deze audit controleert implementatie in code en tests, maar niet live gedrag op Synology NAS, Sonos/DLNA hardware, mobiele browsers of echte streamingaccounts.

## Statusdefinitie

- DONE: de sprint is functioneel geimplementeerd in code; hoogstens resteert handmatige acceptatie.
- PARTIAL: kernonderdelen bestaan, maar een of meer sprint-eisen ontbreken of zijn niet aantoonbaar af.
- REDEFINED: de oorspronkelijke sprint-eis is bewust vervangen door een nieuwere productbeslissing.
- OPEN: geen betekenisvolle implementatie gevonden.

## Samenvatting

| Sprint | Status    | Auditconclusie                                                                                                                      |
| ------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 8      | DONE      | Device state machine, Sonos group metadata, health checks en expliciete browser-fallback zijn aanwezig.                             |
| 9      | PARTIAL   | Incremental scanner, progress-events en watcher bestaan; metadata-verrijking en client-side websocket-progress zijn nog incompleet. |
| 10     | PARTIAL   | Logging, health, shutdown, Docker en env-validatie bestaan; productie-documentatie en client-build polish blijven open.             |
| 11     | DONE      | Favorites, history, recent/recently added en navigatie zijn aanwezig.                                                               |
| 12     | DONE      | Shortcuts, queue-editing, fullscreen now playing en stats zijn aanwezig.                                                            |
| 13     | DONE      | Drag-and-drop queue/playlist plus M3U import/export zijn aanwezig.                                                                  |
| 14     | DONE      | Genres en smart playlists zijn aanwezig.                                                                                            |
| 15     | REDEFINED | Tidal full playback is bewust gedegradeerd naar preview/metadata-only; Qobuz is de full-playback route.                             |
| 16     | DONE      | Last.fm, ListenBrainz, queueing/retry en settings-UI zijn aanwezig.                                                                 |
| 17     | PARTIAL   | Crossfade, quality indicators en DLNA SetNext bestaan; echte gapless/preload flow moet nog worden bewezen en aangescherpt.          |
| 18     | DONE      | Manifest, service worker, meta tags en mobiele CSS bestaan; alleen device-QA resteert.                                              |
| 19     | DONE      | Lyrics service, API-route en fullscreen lyrics UI bestaan.                                                                          |
| 20     | DONE      | Multi-user rollen, admin user management en theme switching bestaan.                                                                |

## Sprint 8 - DLNA Robuustheid en Device UX

Status: DONE

Aanwezig:

- `server/src/devices/dlna.ts` controleert transportstatus, retryt playback en ondersteunt `SetNextAVTransportURI`.
- `server/src/services/device-monitor.ts` pollt devices en emit `device:discovered` en `device:lost`.
- `server/src/devices/state-machine.ts` borgt device states zoals `idle`, `loading`, `playing`, `paused`, `stopped` en `error`.
- `server/src/devices/manager.ts` gebruikt de state machine rond play/pause/resume/stop en expose `playbackState`/`lastError`.
- `server/src/devices/sonos.ts` leest Sonos topology en markeert group membership/coordinator metadata.
- `client/src/components/DeviceSelector.tsx` en `client/src/context/AudioContext.tsx` tonen device status, bewaren de gekozen output en volgen websocket/polling updates.
- `client/src/context/AudioContext.tsx` schakelt bij falende externe Qobuz/radio/lokale playback expliciet terug naar Browser en toont een toast.

Volgende actie:

- Handmatige acceptatie op NAS met echte Sonos/DLNA/Volumio devices.

## Sprint 9 - Library Scanner en Metadata

Status: PARTIAL

Aanwezig:

- `server/src/services/scanner.ts` gebruikt file mtime om ongewijzigde bestanden over te slaan.
- Scannerstatus bevat tellerdata voor processed/new/updated/removed en emit `library:scan-progress`.
- Orphan tracks worden opgeschoond.
- `server/src/services/watcher.ts` ondersteunt `WATCH_LIBRARY=true` met debounce.
- Cover endpoints en cachelogica bestaan via `server/src/services/coverart.ts` en library routes.

Gaten:

- De Settings UI gebruikt nog polling voor scanstatus; websocket-progress wordt niet volledig benut in de client.
- Embedded cover art wordt vooral request-time/in-memory behandeld; permanente cache voor alle embedded covers is niet volledig bewezen.
- Metadata zoals composer, conductor, compilation en multi-artist parsing is niet aantoonbaar volledig.
- Scanfasen zoals discovering/counting/scanning/complete zijn niet zo rijk als de sprint omschrijft.

Volgende actie:

- Vervang scan polling in Settings door websocket-events met polling als fallback.
- Breid metadata-schema en scanner uit voor composer/conductor/compilation.
- Maak persistente cover-cache voor embedded covers expliciet en testbaar.

## Sprint 10 - Polish en Production Readiness

Status: PARTIAL

Aanwezig:

- `server/src/middleware/requestLogger.ts` voegt request IDs toe.
- `server/src/middleware/errorHandler.ts` geeft request IDs terug bij fouten.
- `server/src/routes/health.ts` rapporteert DB, library, providerstatus, librespot en memory.
- `server/src/index.ts` heeft graceful shutdown voor SIGTERM/SIGINT.
- `server/src/config.ts` valideert env vars met Zod en logt configuratiestatus.
- `Dockerfile` is multi-stage en bevat een healthcheck.

Gaten:

- `README.md` ontbreekt nog; er zijn wel `DEPLOY_SYNOLOGY.md`, `NEXT_STEPS.md` en release/security docs.
- Docker gebruikt `node:22-slim`, maar geen exacte patch digest/pin.
- Client build optimalisatie zoals compression/brotli en bundle-analyse is niet aantoonbaar.
- Logging is bruikbaar, maar geen volledige JSON/structured production logging.

Volgende actie:

- Voeg `README.md` toe met quick start, Docker, Synology, env en troubleshooting.
- Pin Docker-images preciezer of documenteer updatebeleid.
- Voeg optionele client build analysis/compression toe.

## Sprint 11 - Essentials UI

Status: DONE

Aanwezig:

- Favorites routes en UI: `server/src/routes/history.ts`, `client/src/pages/FavoritesPage.tsx`.
- Recently played/history: `server/src/routes/history.ts`, `client/src/pages/HistoryPage.tsx`.
- Recently added albums: `server/src/routes/library.ts`, `client/src/pages/HomePage.tsx`.
- Navigatie/routes: `client/src/App.tsx`, `client/src/components/Layout.tsx`.

Restpunt:

- Handmatige UX-check op NAS/mobile blijft nuttig, maar er is geen codegat gevonden.

## Sprint 12 - Interactie en Shortcuts

Status: DONE

Aanwezig:

- Keyboard shortcuts: `client/src/hooks/useKeyboardShortcuts.ts`, `client/src/components/KeyboardShortcuts.tsx`.
- Queue editing: `client/src/context/AudioContext.tsx`, `client/src/components/NowPlayingBar.tsx`.
- Fullscreen now playing: `client/src/components/NowPlayingFull.tsx`.
- Library stats: `server/src/routes/health.ts`, `client/src/pages/HomePage.tsx`.

Notitie:

- De sprint noemde move up/down controls; de app gebruikt drag-and-drop en queue editing. Dat is functioneel sterker, dus dit is als DONE gemarkeerd.

## Sprint 13 - Drag-and-Drop en Playlists

Status: DONE

Aanwezig:

- `client/src/components/SortableList.tsx` gebruikt `@dnd-kit`.
- Queue en playlist reorder gebruiken de sortable list.
- Playlist reorder route: `server/src/routes/playlists.ts`.
- M3U import/export is aanwezig in routes en UI.

Restpunt:

- Geen codegat gevonden.

## Sprint 14 - Music Discovery

Status: DONE

Aanwezig:

- Genres API en pagina: `server/src/routes/library.ts`, `client/src/pages/GenresPage.tsx`.
- Smart playlists schema/routes/UI: `server/src/db/schema.ts`, `server/src/routes/smart-playlists.ts`, `client/src/pages/SmartPlaylistsPage.tsx`.
- Search/provider deduplicatie is aanwezig in `server/src/providers/registry.ts`.

Restpunt:

- Geen codegat gevonden.

## Sprint 15 - Tidal Streaming

Status: REDEFINED

Aanwezig:

- Tidal metadata, favorites en playlistroutes bestaan.
- `server/src/routes/providers.ts` retourneert bewust `410 tidal_preview_only` voor Tidal full playback.
- `client/src/context/AudioContext.tsx` blokkeert Tidal full-track playback en wijst naar Qobuz/lokaal.
- Qobuz is inmiddels als full-playback provider geimplementeerd met status, login en stream-url routes.

Waarom herzien:

- De oorspronkelijke sprint wilde Tidal full-track playback. Dat is niet langer de productrichting, omdat Tidal in deze app betrouwbaar alleen preview/metadata biedt. De nieuwe richting is: local > Qobuz > Tidal metadata/preview > Spotify metadata/stub.

Volgende actie:

- Houd Tidal expliciet preview/metadata-only.
- Plaats eventuele resterende externe full-playback taken onder Qobuz, niet onder Tidal.

## Sprint 16 - Last.fm en ListenBrainz Scrobbling

Status: DONE

Aanwezig:

- `server/src/services/scrobbler.ts` ondersteunt Last.fm en ListenBrainz.
- `server/src/db/schema.ts` bevat `scrobble_config` en `scrobble_queue`.
- `server/src/routes/scrobble.ts` bevat config, auth en disconnect routes.
- `server/src/routes/history.ts` triggert scrobbling/now-playing.
- `client/src/pages/SettingsPage.tsx` bevat Last.fm en ListenBrainz instellingen.

Restpunt:

- Handmatige validatie met echte Last.fm/ListenBrainz credentials blijft acceptatie-QA.

## Sprint 17 - Gapless en Audio Kwaliteit

Status: PARTIAL

Aanwezig:

- `client/src/hooks/useAudio.ts` bevat dual audio elements, crossfade en ReplayGain handling.
- Cross-origin ReplayGain/WebAudio wordt vermeden voor externe streaming URLs.
- `server/src/devices/dlna.ts` en `server/src/routes/devices.ts` ondersteunen `SetNextAVTransportURI`.
- Quality metadata wordt gescand en in UI getoond.
- Crossfade instelling is aanwezig in player UI en context.

Gaten:

- De echte gapless/preload-next flow is nog niet voldoende aantoonbaar end-to-end; de helper bestaat, maar moet in queue playback worden bewezen.
- DLNA SetNext werkt alleen als device het ondersteunt; fallbackgedrag bij unsupported devices moet explicieter.

Volgende actie:

- Voeg tests toe die bewijzen dat de volgende track tijdig wordt gepreload en dat queue-next een verse stream URL haalt.
- Log en toon duidelijk wanneer DLNA SetNext niet beschikbaar is.

## Sprint 18 - PWA en Mobiel

Status: DONE

Aanwezig:

- `client/public/manifest.json`, icons en `client/public/sw.js`.
- `client/src/main.tsx` registreert de service worker.
- `client/index.html` bevat manifest/meta/viewport tags.
- `client/src/index.css` bevat safe-area/mobile styling.

Restpunt:

- Handmatige test op mobiel, PWA install en offline shell blijft acceptatie-QA.

## Sprint 19 - Lyrics en Now Playing

Status: DONE

Aanwezig:

- Lyrics service: `server/src/services/lyrics.ts`.
- Lyrics route: `server/src/routes/library.ts`.
- Lyrics API client: `client/src/api/client.ts`.
- Fullscreen lyrics UI: `client/src/components/LyricsDisplay.tsx`, `client/src/components/NowPlayingFull.tsx`.

Restpunt:

- Handmatige test met tracks waarvoor lyrics beschikbaar zijn blijft nuttig.

## Sprint 20 - Multi-User en Productie

Status: DONE

Aanwezig:

- User roles in schema en auth routes.
- Eerste gebruiker wordt admin; admins kunnen users beheren.
- Settings UI bevat user management.
- Theme switching is aanwezig met dark/light/oled.

Restpunt:

- Productie-hardening kan later worden uitgebreid met audit logs, password reset en sessiebeheer, maar de sprintscope is ingevuld.

## Open werk na deze audit

Prioriteit 1:

- Sprint 9 afronden: websocket scan progress in UI, richer metadata, persistente embedded cover-cache.

Prioriteit 2:

- Sprint 10 afronden: README, Docker pinning/updatebeleid, build compression/analyse, structured logging.
- Sprint 17 afronden: bewijsbare gapless/preload-next flow en DLNA SetNext fallback.

Productbesluit:

- Sprint 15 blijft herzien. Tidal wordt niet opnieuw als full-playback provider behandeld tenzij de productrichting expliciet wijzigt.
