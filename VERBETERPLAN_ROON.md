# AudioServer — analyse en verbeterplan 2: de Roon-lat

**Datum:** 18 september 2026
**Onderzochte versie:** commit 1e3690d op `master` (na V11), werkmap schoon
**Vervolg op:** [VERBETERPLAN_SPRINTS.md](VERBETERPLAN_SPRINTS.md) (V01–V12 uitgevoerd; V12 bleek bij het samenvoegen al gebouwd, zie het uitvoeringslog)
**Doel:** AudioServer laten aanvoelen als Roon voor de dagelijkse luisteraar: rijke, gekoppelde metadata, één bibliotheek over lokaal en Qobuz heen, speelacties die overal werken, en een speler die laat zien wat hij doet.

## 1. Advies in het kort

De eerste elf sprints hebben de fundering gelegd die Roon-gebruikers als vanzelfsprekend ervaren: de server bezit de wachtrij, elke kamer heeft zijn eigen sessie, een album speelt door met een gesloten tablet, luistergeschiedenis is echt, en de app zegt eerlijk wat ze van het audiopad weet. Dat fundament is goed en hoeft niet opnieuw.

Wat ontbreekt ten opzichte van Roon zit nu vrijwel volledig in de **bibliotheeklaag en de bediening**, niet in de afspeelmotor:

1. **Metadata is tekst, geen relaties.** Artiesten, componisten en dirigenten zijn komma-gescheiden strings; alleen de albumartiest krijgt een artiestenrij; een MusicBrainz-id wordt opgehaald voor de cover en daarna weggegooid. Daardoor is er geen biografie, geen credits, geen "verschijnt op", geen edities-tab en geen betrouwbare koppeling met ListenBrainz en Last.fm.
2. **Bladeren is bladeren, geen zoeken.** Albums staan vast op titel gesorteerd, zonder sorteer- of filteroptie; er is geen Focus-achtige facetfilter, geen tags, geen bookmarks, geen zoekbalk in de kop.
3. **Speelacties ontbreken.** Klikken op een nummer vervangt de wachtrij. "Speel hierna", "Zet in wachtrij" en "Start radio" bestaan niet in de UI, en op een netwerkspeler kan niet worden gespoeld.
4. **Lokaal en Qobuz zijn twee werelden.** Een Qobuz-album kan alleen via een providerpagina worden bekeken; het landt nooit tussen de eigen albums. Roon's grootste dagelijkse gemak is precies dat het wél één collectie is.
5. **Na de wachtrij valt het stil.** Er is geen Roon Radio-equivalent, en de ontdekpagina toont niets dat direct kan spelen.

**Aanbevolen volgorde:** eerst de kleine reparaties en speelacties (direct voelbaar), dan het UI-skelet met zoekbalk, dan het identiteitsmodel (MusicBrainz, credits, meerdere artiesten) omdat elke rijke pagina, elke Focus-facet en elke aanbeveling daarop bouwt, daarna artiest- en albumpagina's, Focus en tags, de gedeelde bibliotheek met Qobuz, en pas dan radio en ontdekken. Multi-room-groepen en audioverwerking op de speaker komen als laatste, met een expliciet beslismoment, omdat ze hardware-afhankelijk zijn en de NAS belasten.

Wat bewust **niet** wordt nagebouwd staat in §4: Roon's eigen transportprotocol (RAAT), zijn gelicentieerde metadataleverancier, convolutie-DSP, MQA en ARC. Voor elk daarvan staat een haalbaar alternatief of een onderbouwde afwijzing.

### Onderzoeksmethode

- Volledige inventarisatie van client (pagina's, speler, lay-out, thema), server (schema, scanner, zoeken, routes, providers) en afspeellaag (apparaten, zones, dispatch, monitor, resolver, capabilities, transitielog), met regelverwijzingen in §8.
- Bestaand verbeterplan, uitvoeringslog en NAS-acceptatielog vergeleken met de code.
- Testsuites uitgevoerd op Windows (§2).
- Roon-functies genomen uit de eigen kennis van het product: Library/Focus/Tags/Bookmarks, Play Actions, Signal Path, Roon Radio, Versions, credits en composers, zones/groepen, DSP en volume leveling.
- Geen functionele code gewijzigd, geen apparaten aangestuurd, geen provideraccounts aangeraakt.

## 2. Uitgangspositie

| Controle            | Resultaat op 18 september 2026                                                                                                                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Servertests         | 327 van 328 geslaagd, 45 bestanden. Eén fout in `scanner.test.ts` ("locked directory"): Windows dwingt de mapvergrendeling niet af die de test opzet. Omgevingsprobleem, geen productfout; opgelost in R00.5.                                                                                  |
| Clienttests         | 118 van 118 geslaagd, 26 bestanden.                                                                                                                                                                                                                                                            |
| Omvang              | circa 32 000 regels broncode zonder tests. Grootste bestanden: `SettingsPage.tsx` 1410, `playback.ts` 1167, `AudioContext.tsx` 1105, `scanner.ts` 1065.                                                                                                                                        |
| Open NAS-acceptatie | Uit V01–V11 staan nog open: 30 minuten doorspelen met gesloten tablet, twintig overgangen zonder dubbele dispatch, gemeten grens voor "gapless geverifieerd", twee kamers tegelijk, tweede account. Dit plan voegt daar niets aan toe totdat R01 is opgeleverd; §7 herhaalt ze als voorwaarde. |

Wat de app na V11 goed doet en wat dit plan **behoudt**: server-eigendom van de wachtrij met revisies en command-id's; één `PlaybackService` per zone; dispatch met verse URL en `SetNextAVTransportURI`; eerlijk audiopad met "known/reported/unknown"; bibliotheekbehoud bij verplaatsen; persoonlijke favorieten, geschiedenis en scrobbling; setupcode, sessies en rechtenmatrix.

## 3. Roon als referentie: zes thema's

| Thema                                | Wat Roon de gebruiker geeft                                                                                                                                | Waar AudioServer nu staat                                                                                                                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bibliotheek en identiteit**        | Elk album wordt geïdentificeerd; elke naam op een hoes is een link: artiest, componist, producer, muzikant. "Appears on", composers-browser, Versions-tab. | Strings in kolommen; alleen albumartiest krijgt een rij; geen MBID; geen credits; edities worden wél apart gehouden (V07) maar nergens als "versies" getoond.                                                    |
| **Bladeren: Focus, Tags, Bookmarks** | Elke lijst is filterbaar op genre, jaar, kwaliteit, label, bron, speeldatum, met live aantallen; opgeslagen als bookmark; eigen tags op alles.             | Geen sorteer- of filterparameter op `/albums`; smart playlists met zes velden en alleen AND; geen tags, geen bookmarks; favorieten alleen vanaf album-, artiest- en radiopagina.                                 |
| **Speelacties en speler**            | Play now / Play next / Queue / Start radio op elk item; seek overal; hart, lyrics, credits en signal path in het Now Playing-scherm; groepsvolume.         | Klik vervangt de wachtrij; `queue/add` bestaat maar geen UI; geen seek op speakers; volledig scherm zonder hart, zonder kamerkiezer; audiopad in Settings.                                                       |
| **Eén collectie over bronnen**       | Qobuz- en Tidal-albums staan tussen de lokale; favoriet in Qobuz is favoriet in Roon; ontbrekende streamingtitels worden "unavailable", niet verwijderd.   | Alleen de scanner schrijft in `albums`/`tracks`, altijd `source='local'`; Qobuz alleen via `/api/providers/...`; V12.1 (stabiele bronreferentie in playlists) staat nog open.                                    |
| **Radio en ontdekken**               | Roon Radio vult de wachtrij door met verwante muziek uit de eigen bibliotheek en de streamingdienst; Home toont "recent", "nieuw voor jou", "aanbevolen".  | Wachtrij eindigt in stilte; Discover toont ListenBrainz-lijsten zonder cover en zonder speelknop; Home heeft geen speelacties.                                                                                   |
| **Multi-room en audio**              | Zones groeperen, zone overdragen, volume-egalisatie (R128) en DSP per zone, gapless en crossfade op elk eindpunt via RAAT.                                 | Zones zijn onafhankelijk (goed) maar niet te groeperen; Sonos-groepen worden gelezen, niet aangestuurd; ReplayGain en crossfade alleen in de browser; geen formaatadaptatie voor speakers; geen zone-overdracht. |

## 4. Wat Roon doet dat we bewust niet nabouwen

| Roon-functie                                                                               | Waarom niet                                                                                                                                            | Wat wél                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RAAT / Roon Ready** (gesynchroniseerde multi-room over alle merken)                      | Propriëtair protocol; vereist firmware in het eindpunt. Cross-protocol kloksynchronisatie tussen DLNA, Sonos en Volumio is niet betrouwbaar te bouwen. | Native groepen binnen één ecosysteem (Sonos-groepen via de eigen API, R09). Geen synchronisatiebelofte over protocollen heen.                                                                                        |
| **Gelicentieerde metadata** (TiVo/Rovi: recensies, credits per muzikant, genre-hiërarchie) | Betaalde licentie; geen vrije bron met dezelfde diepte.                                                                                                | MusicBrainz voor identiteit en credits, Wikidata/Wikipedia voor biografieën, Last.fm (sleutel is er al) als terugval, Cover Art Archive en Spotify voor beeld. Wat er niet is, wordt niet verzonnen: geen recensies. |
| **DSP-engine** (convolutie, parametrische EQ, upsampling, headroom)                        | NAS-CPU en de eerlijkheid van het audiopad: elke bewerking maakt "bit-perfect" onwaar en moet per eindpunt gemeten worden.                             | Alleen volume-egalisatie en formaatadaptatie, en alleen na een CPU-proef op de NAS (R10). Geen EQ.                                                                                                                   |
| **MQA, DSD**                                                                               | Geen apparatuur in dit huishouden die het vraagt; Qobuz levert FLAC.                                                                                   | FLAC tot 24/192 zoals nu.                                                                                                                                                                                            |
| **Roon ARC** (buitenshuis luisteren via de eigen app)                                      | Aparte mobiele app en NAT-traversal.                                                                                                                   | HTTPS via de Synology reverse proxy bestaat al; OpenSubsonic-proef (E02) blijft de route naar bestaande mobiele apps.                                                                                                |
| **Valence** (machine learning voor aanbevelingen)                                          | Vereist Roon's geaggregeerde luisterdata.                                                                                                              | Eigen luistergeschiedenis, Last.fm-verwantschap en ListenBrainz-aanbevelingen, met uitleg per aanbeveling (R08).                                                                                                     |

## 5. Bevindingen

Elke bevinding noemt bewijs in de code (regelnummers per 1e3690d), het Roon-equivalent en de sprint die het oplost.

### Bibliotheek en metadata

**R-B01 — Artiesten zijn strings, geen relaties.**
`tracks.artist_names` is een komma-gescheiden tekst (`schema.ts:63`, `scanner.ts:994`); `composer` en `conductor` idem (`schema.ts:64-65`). Alleen de albumartiest krijgt een rij in `artists` (`scanner.ts:874-895`); een gastartiest bestaat dus niet als artiest. `normalizePeople` splitst uitsluitend op `;` en `/` (`scanner.ts:1059-1065`), niet op "feat.", "ft." of "&". Roon: elke naam is een link, met rol. → R03.

**R-B02 — MusicBrainz-identiteit wordt gebruikt en weggegooid.**
`coverart-fetch.ts:177-236` zoekt een release-MBID voor de hoes en bewaart hem niet. Er is geen enkele MBID-kolom. Gevolg: ListenBrainz-matching gaat op kleine-lettersnaam (`listenbrainz.ts:68-91`), de "vergelijkbare artiesten" via ListenBrainz zijn afgewezen bij gebrek aan een seed-MBID (`similar-artists.ts:1-5`), en biografieën, credits en edities hebben geen sleutel om aan te haken. Bibliotheken die met Picard getagd zijn, dragen deze id's al in de bestanden mee; de scanner leest ze niet (`scanner.ts:856-1057`). → R03.

**R-B03 — Genre is één string per album.**
`albums.genre` (`schema.ts:29`), gevuld met `common.genre?.[0]` (`scanner.ts:937,1051`). Geen genre per track, geen meerdere genres, geen hiërarchie. `GenresPage` toont alleen albums, zonder zoek, sortering of speelknop (`GenresPage.tsx:95-147`). → R03, R05.

**R-B04 — Geen hoes uit de map, geen biografie, geen artiestenbeeld zonder Spotify.**
Alleen ingesloten hoezen worden gelezen (`scanner.ts:1038-1041`); `folder.jpg`/`cover.jpg` komen nergens voor. Artiestenbeeld komt uitsluitend van Spotify (`coverart-fetch.ts:332-364`). Biografie, label, catalogusnummer, releasedatum, ISRC: geen kolom. → R03, R04.

**R-B05 — Edities bestaan, maar "Versions" niet.**
De scanner houdt FLAC en MP3 van hetzelfde album uit elkaar op `edition_key` (`scanner.ts:906`) en zoeken kent `alternatives[]` per bron (`registry.ts:291-344`). `AlbumPage` toont geen andere editie in de bibliotheek en geen Qobuz-alternatief; `discNumber` wordt geparsed maar nooit gerenderd (`AlbumPage.tsx:16` is de enige vindplaats in `client/src`). → R00 (disc), R04 (versies).

**R-B06 — Bladeren zonder sortering of filter.**
`GET /api/library/albums` sorteert vast op titel (`library.ts:137-160`); geen `sort`, geen filter op genre, jaar, kwaliteit, bron, favoriet of speeldatum; hetzelfde voor artiesten en tracks. De enige facet-UI zit in zoeken (bron en kwaliteit, `SearchPage.tsx:228-274`). Smart playlists: zes velden, vijf operatoren, alleen AND, vaste limiet 200 (`smart-playlists.ts:30-42,176-200`). Roon Focus doet dit op elke lijst met live aantallen. → R05.

**R-B07 — Geen tags, bookmarks of waarderingen; hart op drie plekken.**
Geen tabel, geen UI. Favoriet kan alleen vanaf `AlbumPage`, `ArtistPage` en `RadioPage`; niet vanuit de spelerbalk, zoekresultaten, wachtrij of playlistrijen. → R06.

**R-B08 — Qobuz staat buiten de collectie.**
Alleen de scanner schrijft in `albums`/`tracks`/`artists`, altijd `source='local'` (`scanner.ts:892,930-945,1019-1022`; defaults `schema.ts:15,47,78`). Qobuz-favorieten zijn live providerroutes (`routes/providers.ts:374,611`). Een Qobuz-album dat als favoriet is gemarkeerd, verschijnt niet in `/albums`. Roon's "Add to library" is het dagelijkse gemak dat hier ontbreekt. V12.1 (stabiele bronreferentie in playlists) is hiervan de helft. → R07.

**R-B09 — Zoeken is `LIKE` zonder accentvouwing.**
`local-search.ts` zoekt met `LIKE '%q%'` op naam, titel en artiest; geen genre, componist of dirigent; geen diacritics-folding (dat bestaat alleen in de dedup-sleutel van `registry.ts:37-49`). "Dvorak" vindt "Dvořák" niet. De keuze tegen FTS5 was gemeten (V07.3) en blijft; een genormaliseerde zoekkolom lost het accentprobleem goedkoop op. → R05.

### Speler en bediening

**R-S01 — Geen speelacties.**
Klik op een nummer vervangt de wachtrij (`playAlbum`, `AlbumPage.tsx:208-276`). `POST /queue/add` bestaat (`playback.ts:389`) maar geen enkele rij in de client biedt "Speel hierna" of "Zet in wachtrij"; er is geen "voeg in na huidig" op de server. Geen contextmenu, geen long-press op mobiel. → R01.

**R-S02 — Geen seek op netwerkspelers.**
`DeviceController` heeft geen `seek` (`shared/src/device.ts:23-44`); geen route, geen UI. De DLNA-actielijst wordt al uitgelezen (`dlna.ts:347-356`) dus "Seek" is per apparaat bekend; Sonos en Volumio ondersteunen het native. → R01.

**R-S03 — De browser-preload uit V11.2 is niet aangesloten.**
`useAudio.preloadNext` is geïmplementeerd (`useAudio.ts:374`) en `play()` neemt een voorbereid element over (`:327-349`), maar geen productiecode roept `preloadNext` aan (alleen `useAudio.ts:474,489` exporteren hem; `AudioContext.tsx` bevat geen `preload`). Elke browsergrens loopt dus via `handedOver('reloaded')` (`:357`). De changelog van V11 claimt anders; dit is een concrete afwijking. → R00.

**R-S04 — Het Now Playing-scherm mist wat Roon daar zet.**
`NowPlayingFull` heeft geen hart, geen kamerkiezer, geen credits, geen link naar het audiopad; lyrics wel (`NowPlayingFull.tsx:85-91`). `NowPlayingBar` heeft geen hart en geen lyricsknop. Het audiopad staat in Settings (`AudioPathPanel.tsx`), Roon zet het lampje in de speler. → R01.

**R-S05 — Kamers zijn niet aan te maken vanuit de app.**
`createZone`/`renameZone`/`deleteZone` staan in `api/client.ts:443-451`; geen component roept ze aan. Een beheerder heeft `curl` nodig om een tweede kamer te maken. → R00.

**R-S06 — Geen radio na de wachtrij, geen speelbare ontdekpagina.**
Geen auto-doorspelen; `DiscoverPage` linkt naar album of zoekopdracht, toont geen hoes en geen speelknop (`DiscoverPage.tsx:34-68`); `HomePage` heeft geen speelacties. `similar-artists.ts` (Last.fm) en `listening_sessions` zijn de bouwstenen voor een lokale radio. V12.2–V12.4 dekken dit deels. → R08.

**R-S07 — Slaaptimer en "stop na dit album" ontbreken.**
Nergens aanwezig; backlog E01. Roon heeft dit zelf ook niet, maar op een NAS die 's nachts uitgaat is het praktisch. → R09.

### Multi-room en audio

**R-M01 — Sonos-groepen worden gelezen, niet aangestuurd.**
`sonos.ts:117-135,328-355` vult `groupId`/`isGroupCoordinator` uit `/status/topology`; niets stuurt `x-rincon:` of `BecomeCoordinatorOfStandaloneGroup`. Twee Sonos-spelers in de app zijn twee kamers, nooit één. Backlog E04. → R09.

**R-M02 — Geen zone-overdracht.**
Roon's "Transfer" (wachtrij en positie van kamer A naar B) ontbreekt; de bouwstenen (snapshot, `queue/set` met `startIndex`, seek uit R01) zijn er. → R09.

**R-M03 — Formaatcompatibiliteit wordt gemeld, niet afgedwongen.**
`output-capabilities.ts:122-191` leest `GetProtocolInfo`, maar de resolver stuurt een FLAC ongewijzigd naar een speler die alleen MP3 opgeeft (`playback-resolver.ts:238`; `audio-path.ts:138` zegt letterlijk dat er niets wordt getranscodeerd). ffmpeg zit al in de image en wordt alleen voor librespot gebruikt (`librespot.ts:163-219`). Backlog E06. → R10.

**R-M04 — Volume-egalisatie en crossfade zijn browser-only.**
ReplayGain via `GainNode` (`useAudio.ts:133-160`), niet voor cross-origin (Qobuz) en niet voor speakers (`output-capabilities.ts:187`). Roon egaliseert per zone met R128. Zonder verwerkingspad op de server is dit onmogelijk; hangt aan R-M03. → R10.

**R-M05 — Volumio zonder discovery en zonder next-URI.**
Alleen statisch via `VOLUMIO_DEVICES` (`volumio.ts:32-64`); geen `setNextUri`, dus geen overdracht vooraf. → R09.

### UI-fundament

**R-U01 — Platte bovenbalk met veertien items en geen zoekbalk.**
`Layout.tsx:11-26,46-92`: horizontale nav, mobiel een uitklapmenu, geen zijbalk, geen onderste tabbalk, geen zoekveld in de kop (alleen de `/`-toets). Roon: zijbalk met groepen en een altijd zichtbare zoekbalk. → R02.

**R-U02 — Thema wordt niet geladen bij koude start.**
`data-theme` wordt alleen gezet in `SettingsPage.tsx:820,824`; `main.tsx` en `index.html` doen niets. Wie de app opent zonder Settings te bezoeken, ziet niet zijn gekozen thema. Geen `prefers-color-scheme`. Licht thema bestaat uit zes overschrijfregels (`index.css:23-44`); alle andere hardgecodeerde Tailwind-kleuren blijven donker. → R00 (bootstrap), R02 (tokens).

**R-U03 — Geen gedeelde bouwstenen.**
Geen Button/Menu/Sheet-component; elke knop herhaalt zijn klassenreeks; `tailwind.config.js` kent twee kleurfamilies. Een contextmenu (R01) en Focus-paneel (R05) hebben een menu- en sheetprimitive nodig. → R02.

### Onderhoud

**R-O01 — Scannertest faalt op Windows.** Omgevingsafhankelijk (mapvergrendeling). → R00: platformguard.
**R-O02 — Watcher doet een volledige scan bij elke wijziging** (`watcher.ts:39`). Acceptabel bij 11 000 tracks; noteren, niet nu oplossen.
**R-O03 — Dode stubs.** `spotify-stub.ts` en `tidal-stub.ts` staan niet in het register. → R00: verwijderen.

## 6. Sprintplan

Capaciteit en werkwijze als in het vorige plan: sprints van circa acht werkdagen, elke sprint een zelfstandig te geven opdracht, "wacht op acceptatie" tot hardwarecriteria op de NAS zijn getoetst. Schemawijzigingen volgen het bestaande patroon: versienummer, idempotente migratie, test tegen een kopie van een oude database.

| Sprint | Naam                                                        | Dagen       | Voorwaarde                     |
| ------ | ----------------------------------------------------------- | ----------- | ------------------------------ |
| R00    | Directe reparaties                                          | 3           | geen                           |
| R01    | Speelacties, seek en de speler                              | 8           | R00                            |
| R02    | Navigatie, zoekbalk en thema                                | 7           | R00                            |
| R03    | Identiteit en credits                                       | 9           | geen; liefst na R02            |
| R04    | Artiest en album zoals Roon                                 | 8           | R03                            |
| R05    | Focus: sorteren, filteren, bookmarks                        | 9           | R02, R03                       |
| R06    | Tags, favorieten overal, waarderingen                       | 6           | R05                            |
| R07    | Eén bibliotheek: Qobuz in de collectie                      | 9           | R03, R05; neemt V12.1 op       |
| R08    | Radio en ontdekken                                          | 8           | R03, R07; neemt V12.2–V12.4 op |
| R09    | Multi-room: Sonos-groepen, overdracht, slaaptimer           | 8           | R01                            |
| R10    | Audio op de speaker: formaatadaptatie en egalisatie (proef) | 5 + besluit | R09; NAS-CPU-meting            |

Totaal circa 80 dagen. Beslismomenten in §7.

### R00 — Directe reparaties

**Doel:** de gevonden afwijkingen herstellen die geen ontwerp vragen.

- [x] **R00.1 · 0,5 dag:** `preloadNext` aansluiten in `AudioContext` zodra een nummer speelt en er een volgend lokaal item is; transitielog moet daarna `preloaded` tonen. Test: browsergrens met voorbereid element meldt `how: 'preloaded'`.
      _Gedaan:_ de voorbereiding start niet bij het begin van een nummer maar dertig seconden voor het einde (`PRELOAD_LEAD_SECONDS`), gecontroleerd op de bestaande vijf-secondenlus; anders haalt elke tik op "volgende" een heel bestand op dat niemand hoort. Voorwaarden: browser als uitgang, crossfade uit (crossfade bouwt zijn eigen element en zou het voorbereide weggooien), en een lokaal volgend nummer — een Qobuz-URL is per keer ondertekend en zou bij de grens verlopen zijn. Welk nummer "volgend" is komt uit `peekNextIndex`, dezelfde regel als de server: onder shuffle is er geen antwoord, dus wordt er niets voorbereid.
- [x] **R00.2 · 0,5 dag:** themabootstrap in `main.tsx`: opgeslagen thema vóór de eerste render toepassen, anders `prefers-color-scheme`. Test op koude start.
      _Gedaan:_ `utils/theme.ts` is de enige plek die het thema leest, toepast en opslaat; `main.tsx` past het toe vóór de eerste render en Settings verandert het alleen nog. Geen inline script in `index.html`: de CSP staat geen inline scripts toe en die policy blijft zoals ze is.
- [x] **R00.3 · 0,5 dag:** discnummers als kopjes in `AlbumPage` bij meer dan één disc.
      _Gedaan:_ alleen bij meer dan één disc; een album met één disc krijgt geen "Disc 1" dat niets zegt.
- [x] **R00.4 · 1 dag:** kamers beheren in Settings: aanmaken (apparaat kiezen), hernoemen, verwijderen; 409 bij bezet apparaat netjes tonen.
      _Gedaan:_ `components/ZonesSection.tsx` (admin). De apparaatkiezer laat alleen uitgangen zien die geen kamer heeft geclaimd; wordt een kamer elders aangemaakt, dan komt de 409 van de server als tekst in beeld en wordt de lijst ververs. De standaardkamer biedt geen "Remove" — daar landt een client zonder kamer.
- [x] **R00.5 · 0,5 dag:** scannertest "locked directory" overslaan op `win32` met reden; `spotify-stub.ts` en `tidal-stub.ts` verwijderen.
      _Gedaan:_ `it.skipIf(!canBlockDirectoryAccess)` — Windows negeert de rechten die `chmod` op een map zet, root overal, dus daar zou de test een fout verwachten die niet gebeurt. De interfacetest van de stubs is niet weggegooid maar op de **echte** Tidal- en Spotify-provider gericht; die staan wél in het register, dus dat is strengere dekking dan ervoor.
- [x] **R00.6 · 0,5 dag (toegevoegd tijdens uitvoering):** de service worker registreert niet meer onder `vite dev`.
      _Waarom:_ bij de browsercontrole van R00.2 bediende een service worker uit een eerdere sessie de pagina met een gecachte bundel. `data-theme` bleef leeg terwijl de code op schijf klopte. Dat is de valkuil van een shellcache in ontwikkeling: je kijkt naar andere code dan je hebt. De registratie slaat `import.meta.env.DEV` nu over en ruimt een achtergebleven worker op; `vite preview` is geen DEV, dus de echte updateflow van V08.1 blijft te testen.

**Acceptatie:** alle tests groen op Windows én Linux; transitielog toont `preloaded` in de browser; tweede kamer aangemaakt vanuit de app op de NAS.
_Status: gehaald op Windows (473 tests, 1 overgeslagen met reden); Linux via CI. De laatste twee punten vragen de NAS en een ingelogde sessie — zie het uitvoeringslog._

### R01 — Speelacties, seek en de speler

**Doel:** elke rij in de app kent dezelfde vier acties als Roon, en de speler laat zien wat hij speelt en waarop.

- [x] **R01.1 · 2 dagen:** server: `POST /queue/add` krijgt `position: 'next' | 'end'` (invoegen na het huidige item, met revisie en command-id zoals `queue/move`); `POST /queue/set` krijgt `mode: 'replace' | 'append'`; `POST /playback/seek` per zone. `DeviceController.seek` voor DLNA (`Seek`, `REL_TIME`), Sonos en Volumio (`cmd=seek`); alleen aanbieden als `output-capabilities` `seek: supported` meldt, anders expliciet `unsupported` teruggeven.
      _Gedaan:_ `/queue/add` neemt nu één `track` of een lijst `tracks` plus `position`; herhaald "speel hierna" landt telkens direct achter het huidige item, dus het nieuwste speelt eerst. **Afwijking:** `mode: 'append'` op `/queue/set` is bewust niet gebouwd, want `/queue/add` met `tracks` en `position: 'end'` doet precies dat; twee routes voor één handeling zouden uit elkaar gaan lopen. `/queue/set` blijft "vervang en speel". `/seek` meldt 409 `SeekUnsupported` als de uitgang zelf zegt dat hij het niet kan, 502 `SeekFailed` als hij weigert (en onthoudt dat), en klemt een sprong vóór het einde zodat hij nooit als "volgende" werkt. De eigen klok van de server wordt bij elke sprong herijkt; anders dacht een sessie na een sprong terug dat het nummer bijna af was. Nieuw: `GET /library/artists/:id/tracks`, zodat "speel artiest" één verzoek is.
- [x] **R01.2 · 2,5 dag:** client: één `PlayActions`-component (Speel nu / Speel hierna / Zet in wachtrij / Speel vanaf hier / Voeg toe aan playlist / Favoriet) als contextmenu op desktop en long-press-sheet op mobiel, op track-, album-, artiest-, playlist- en zoekresultaatrijen. Klik op een nummer blijft "speel vanaf hier" (huidig gedrag).
      _Gedaan:_ `components/ui/Menu.tsx` (portal op `document.body`, zodat tabellen en de scrollende wachtrij het niet afknippen; Escape, pijltjes, Home/End, focus terug naar de knop) en `components/PlayActions.tsx`. Op zoekresultaten, album-, playlist-, favorieten-, geschiedenis- en slimme-playlistrijen, en op album- en artiestkaarten in Albums, Artiesten, Genres en de artiestpagina. Rechtsklik opent het menu; in lijsten met roving tabindex ook de contextmenutoets en Shift+F10, zodat Tab niet langs elke rij gaat. "Speel nu" gooit de wachtrij niet weg: het nummer komt achter het huidige en de wachtrij gaat erheen; bij een lege wachtrij start gewoon de lijst. Streamingtracks krijgen geen hart en geen playlistkeuze, want die hebben geen bibliotheek-id. De oude `AddToPlaylist`-knop is opgegaan in het menu. **Afwijking:** geen long-press. Op iOS opent een lange druk op een link het systeemvoorbeeld, en in de wachtrij vecht hij met de sleepgreep. In plaats daarvan is de ⋯-knop op aanraakschermen altijd zichtbaar en opent het menu daar als sheet van onderen, met dezelfde duimgrootte; één tik in plaats van een lange druk.
- [x] **R01.3 · 2 dagen:** `NowPlayingFull`: hart, kamerkiezer, lyricsknop, audiopad-indicator (groen/geel/grijs met de certainty-labels uit `audio-path.ts`) die naar de details linkt; seekbalk actief op speakers die het kunnen. `NowPlayingBar`: hart en lyrics. Wachtrijpagina: "Bewaar als playlist".
      _Gedaan:_ één gedeelde `SeekBar` voor beide spelers; op een uitgang zonder Seek wordt hij een voortgangsbalk die zegt waarom, en bij een Spotify-track ook (die seekbalk deed eerder niets). Seek op een speaker beweegt de balk direct, stuurt het commando pas als het drukken stopt (350 ms, anders krijgt een renderer dertig SOAP-sprongen per seconde) en springt terug als de speaker weigert. De audiopad-indicator volgt de **minst zekere** stap, dus een speakerpad heet nooit volledig vastgesteld. Hart en lyricsknop in de balk alleen op desktop: de telefoonbalk heeft geen ruimte meer en het volledige scherm is één tik weg. "Bewaar als playlist" slaat de wachtrij in volgorde op in één verzoek; streamingitems gaan er niet in (een playlistrij wijst naar de bibliotheek, V12.1/R07.3) en de melding noemt hoeveel.
- [x] **R01.4 · 1,5 dag:** tests: invoegen na huidig met shuffle aan, seek op een speler zonder `Seek` (nette weigering), twee clients met revisieconflict bij "speel hierna"; clienttests voor het menu op muis en touch.
      _Gedaan, met een gevonden fout:_ de shuffletest liet zien dat "speel hierna" onder shuffle **niet** hierna speelde, omdat de server dan een willekeurig volgend nummer kiest. Opgelost met een belofte per sessie: ingevoegde items gaan voor, ook onder shuffle en repeat-one, en `peekNext` geeft ze door voor de gapless-overdracht zodat het klaargezette nummer klopt. Twintig rondes shuffle achter elkaar in de test. Revisieconflict: "speel hierna" is relatief aan wat **nu** speelt, dat alleen de server weet, dus het wordt bewust niet geweigerd op een verouderde revisie; de test laat zien dat een tab die een wijziging miste zijn nummer toch op de goede plek krijgt.

**Acceptatie:** vanaf zoekresultaat, album en playlist kan een nummer "hierna" worden gezet zonder de wachtrij te verliezen; spoelen op de Cocktail Audio, Sonos en Volumio werkt of wordt zichtbaar geweigerd; hart en kamer zijn bereikbaar vanuit het volledige scherm.

### R02 — Navigatie, zoekbalk en thema

**Doel:** het skelet van Roon: zijbalk met groepen op desktop, tabbalk op telefoon, zoekbalk altijd zichtbaar, thema volledig.

- [x] **R02.1 · 2 dagen:** zijbalk (desktop) met groepen: Home, Zoeken · Bibliotheek: Artiesten, Albums, Tracks, Componisten (na R03), Genres, Tags (na R06) · Verzamelingen: Favorieten, Playlists, Slimme playlists, Bookmarks (na R05) · Ontdekken, Radio, Geschiedenis, Statistieken · Wachtrij, Instellingen. Mobiel: onderste tabbalk (Home, Zoeken, Bibliotheek, Wachtrij, Meer). Verborgen groepen tot hun sprint bestaat.
      _Gedaan:_ veertien gelijke links in één rij zijn een zijbalk met groepen geworden (Bibliotheek, Verzamelingen, Ontdekken), en op de telefoon vier tabs plus "Meer", dat de rest als sheet opent. Geen aparte Tracks-ingang: er is geen trackpagina, alleen een gepagineerde lijst zonder eigen scherm; die komt met Focus in R05. Componisten, Tags en Bookmarks staan er nog niet, precies zoals het plan zegt.
- [x] **R02.2 · 1,5 dag:** zoekbalk in de kop met typeahead (eerste vijf artiesten/albums/tracks, lokaal), Enter opent de zoekpagina; `/`-toets focust de balk.
      _Gedaan:_ de balk staat op elke pagina in de kop. De suggestielijst is bewust alleen de **bibliotheek**, zodat hij antwoordt terwijl je typt; Enter opent de zoekpagina, waar de streamingbronnen en filters zitten. Een tracksuggestie springt naar zijn album en speelt niet: een lijst die je leest hoort geen geluid te maken. De `/`-toets zat in de sneltoetsen en navigeerde naar de zoekpagina; die regel is verplaatst naar de balk zelf.
- [x] **R02.3 · 2 dagen:** ontwerptokens: kleuren als CSS-variabelen in `tailwind.config.js` (`surface`, `text`, `muted`, `border`, `accent`) zodat licht, donker en OLED volledig zijn zonder overschrijfregels; primitives `Button`, `Menu`, `Sheet`, `Chip` in `components/ui`.
      _Gedaan:_ alle kleuren zijn variabelen, inclusief de grijstrap, wit/zwart en de rood- en groentinten van meldingen. De klassennamen in de componenten bleven; wat veranderde is dat ze per thema oplossen. De grijstrap en "wit" zijn in licht thema **omgekeerd**, want `text-gray-500` betekent in deze app "secundaire tekst" en die hoort donker te zijn op een witte pagina. Letters op de accentkleur flippen niet mee: `text-on-accent` plus één basisregel voor knoppen die hun tekstkleur erven. De zes overschrijfregels voor licht thema zijn weg. Primitives: `Button` en `Chip` nieuw en meteen in gebruik (zoekfilters, album- en artiestknoppen); `Menu` bestond al uit R01 en bevat de sheet-variant, dus er is geen losse `Sheet`.
- [x] **R02.4 · 1,5 dag:** `SettingsPage` splitsen in secties per bestand (Playback, Library, Providers, Zones, Users, Scrobbling, About) achter een linker tabblad; geen gedragswijziging. Toegankelijkheidscheck (focusvolgorde, labels) op de nieuwe navigatie.
      _Gedaan:_ 1412 regels werden elf bestanden in `pages/settings/` plus een schil van ongeveer 115 regels. De code is per regelbereik verplaatst, niet overgetypt: bij "geen gedragswijziging" is overtypen precies hoe gedrag per ongeluk verandert. Elke sectie laadt nu zijn eigen gegevens in plaats van uit één gedeelde hoop staat. `?tab=` maakt een sectie aanklikbaar deelbaar, en een niet-beheerder krijgt de beheersecties niet te zien, ook niet via het adres.

**Acceptatie:** licht thema zonder donkere restanten op alle pagina's; zoeken vanaf elke pagina in één toetsaanslag; op een telefoon zijn Home, Zoeken en Wachtrij met de duim bereikbaar; Lighthouse-toegankelijkheid niet lager dan vóór de sprint.

### R03 — Identiteit en credits

**Doel:** namen worden relaties, albums krijgen een identiteit. Dit is de fundering voor R04–R08.

- [x] **R03.1 · 2,5 dag:** schema: `artists.mbid`, `albums.mbid`, `albums.release_group_mbid`, `albums.label`, `albums.catalog_number`, `albums.release_date`, `albums.original_year`; `tracks.mbid` (recording), `tracks.isrc`, `tracks.bpm`, `tracks.work`, `tracks.movement`; nieuwe tabellen `track_artists (track_id, artist_id, role, position)` met rollen `main | featured | composer | conductor | performer | producer`, `album_genres (album_id, genre)` en `track_genres`. `artist_names`/`composer`/`conductor`-kolommen blijven als weergavetekst. Idempotente migratie; scanversie 3.
- [x] **R03.2 · 2,5 dag:** scanner: MusicBrainz-tags uit de bestanden lezen (`musicbrainz_*`, `label`, `catalognumber`, `isrc`, `originaldate`, `bpm`, `work`, `movement`, alle genres); `normalizePeople` splitst ook op "feat.", "ft.", "featuring", "&" en "with" met behoud van de oorspronkelijke weergavenaam; elke naam krijgt een artiestenrij en een `track_artists`-rij; `folder.jpg`/`cover.jpg`/`front.jpg` als hoesbron vóór de ingesloten afbeelding.
- [x] **R03.3 · 2 dagen:** identificatiejob (admin, achtergrond, met de bestaande 1,1 s-limiet): albums zonder MBID opzoeken op artiest + titel + aantal tracks + duur; alleen koppelen bij eenduidige match, anders "twijfelgeval" in Settings met handmatige keuze. De hoesjob hergebruikt de gevonden MBID. ListenBrainz- en Last.fm-matching gebruiken MBID als die er is, naam als terugval.
- [x] **R03.4 · 2 dagen:** tests: tagged en ongetagde bestanden, "feat."-splitsing, compilatie met twintig artiesten, klassiek album met componist en dirigent, migratie van een oude database, purge-gedrag voor `track_artists`. Meting: duur van de geforceerde scan op de NAS met 11 000 tracks noteren.

**Acceptatie:** een gastartiest heeft een eigen pagina met "verschijnt op"; een met Picard getagde map krijgt MBID's zonder netwerk; een ongetagde map krijgt ze via de job of blijft eerlijk "niet geïdentificeerd"; geen verlies van favorieten, playlists of geschiedenis na de herscan (V06-garantie blijft).

### R04 — Artiest en album zoals Roon

**Doel:** de twee pagina's waar Roon-gebruikers het verschil zien.

- [x] **R04.1 · 2 dagen:** artiestbiografie: Wikidata via de MBID (url-relatie) naar Wikipedia-samenvatting (nl, dan en); terugval Last.fm `artist.getInfo` (sleutel bestaat al); bron en licentie tonen; cache in de database met vervaldatum. Artiestenbeeld: Spotify zoals nu, plus optioneel fanart.tv achter een sleutel.
- [x] **R04.2 · 2 dagen:** artiestpagina: kopbeeld, biografie (inklapbaar), discografie gesplitst in Albums / Singles & EP's / Compilaties / Verschijnt op, chronologisch of op titel; topnummers uit `listening_sessions`; "Speel artiest", "Shuffle", "Start radio" (radio pas actief na R08); vergelijkbare artiesten zoals nu.
- [x] **R04.3 · 2 dagen:** albumpagina: releasedatum, label, catalogusnummer; credits-blok (componist, dirigent, uitvoerenden, producer) met links; discnummers (R00.3); sectie **Versies**: andere edities in de bibliotheek (zelfde `release_group_mbid` of zelfde artiest+titel, andere `edition_key`) en Qobuz-alternatieven uit de bestaande zoekmerge, elk met kwaliteit en speelknop. Klassiek: tracks gegroepeerd per werk als `work` gevuld is.
- [x] **R04.4 · 2 dagen:** componistenpagina (`/composers`, lijst en detail met werken en albums); tests voor bio-terugval, versies-groepering en werkgroepering; visuele controle op telefoon.

**Acceptatie:** een artiest met biografie op Wikipedia toont die binnen twee seconden na eerste bezoek en daarna uit cache; een album dat als FLAC en MP3 bestaat toont beide onder Versies; een Qobuz-versie in hogere resolutie is vanaf de lokale albumpagina te starten.

### R05 — Focus: sorteren, filteren, bookmarks

**Doel:** elke lijst wordt een vraag aan de bibliotheek, met live aantallen, en die vraag is te bewaren.

- [x] **R05.1 · 2,5 dag:** API: `GET /albums`, `/artists`, `/tracks` krijgen `sort` (title, artist, year, added, lastPlayed, plays, duration) en filters (`genre[]`, `yearFrom/yearTo`, `format[]`, `quality`, `source[]`, `favorite`, `label`, `composer`, `playedWithin`, `addedWithin`, `unplayed`). `GET /albums/facets?…` geeft per facet de aantallen binnen de huidige filterset. Indexen meten met de bestaande benchmark; p95 onder 300 ms op 50 000 tracks blijft de norm.
      _Gedaan:_ één filtertaal in `services/focus.ts` voor albums, artiesten, tracks en de facetten — dezelfde die bookmarks en slimme playlists in R05.3 opslaan. OR binnen een facet, AND ertussen; elke facet telt met alle filters behalve die van zichzelf, zodat "Jazz" aanvinken nog laat zien hoeveel Blues er is. Plays, laatst gespeeld, ongespeeld en favoriet zijn van wie het vraagt (V09). Sorteersleutels uit een whitelist, elke waarde gebonden; onbekende waarden worden genegeerd zodat een oude bookmark nooit een pagina breekt. Zonder query zijn de lijsten wat ze waren. "Verberg dubbele edities" zit er al in (R05.4 hoeft alleen de knop). Gemeten met `npm run bench:search`, uitgebreid met acht Focus-vragen op 50 000 tracks en 40 000 plays: twee knelpunten gevonden en opgelost — dubbele edities was kwadratisch (700 ms bij 10 000 tracks → window-functie, 80 ms bij 50 000) en de facetten liepen tien keer de hele luistergeschiedenis door (430 → 108 ms, de gespeelde albums één keer per verzoek). Nu overal p95 ≤ 135 ms in de container; de NAS is trager, dus daar nog meten.
- [x] **R05.2 · 2,5 dag:** Focus-paneel (sheet op mobiel, zijpaneel op desktop) op Albums, Artiesten, Tracks en Genres: chips per facet met aantallen, meerdere waarden per facet zijn OR, facetten onderling AND; sorteerkeuze; actieve filters als chips boven de lijst; URL bevat de query zodat een filter deelbaar en terug-navigeerbaar is; "Speel alles" en "Shuffle" op het gefilterde resultaat.
      _Gedaan:_ Focus-knop boven Albums, Artiesten en de nieuwe Tracks-pagina (nu ook in de zijbalk). Het paneel is een sheet op de telefoon en een zijpaneel vanaf 640 px, met sorteren (plus richting), kwaliteit, genre, decennium, "van jou" (favorieten, nooit gespeeld, recent gespeeld, recent toegevoegd), formaat, bron (alleen als er meer dan één is), componist, label en "één editie per album". Chips tonen hun aantal; een waarde die niets geeft verdwijnt, behalve als hij aan staat. Het paneel blijft open terwijl je tikt (de lijst herlaadt, wordt niet opnieuw opgebouwd). Actieve filters staan als chips boven de lijst, elk met ×, plus "Wis alles" — de sortering blijft dan staan. De query staat in de URL (vaste volgorde, dus hetzelfde filter = dezelfde link) en elke wijziging is een stap terug met de terugknop. "Speel alles" en "Shuffle" spelen precies de gefilterde tracks, ontbrekende bestanden overgeslagen, maximaal 1000 (en dat wordt gezegd). Twee keuzes om te weten: (1) op Genres is het geen eigen paneel maar een knop "Verfijn in Focus" die Albums opent met dat genre aan — één plek voor filters in plaats van twee; (2) op Artiesten en Tracks tellen de chips albums, en het paneel zegt dat. Server: "één editie" werkt nu ook voor tracks, en tracks sorteren bij gelijke sleutel per album op schijf en tracknummer, zodat "speel alles op jaar" elk album heel afspeelt. Acceptatie eerlijk: "Hi-Res jazz uit de jaren 70 die ik nooit heb gespeeld" kost nu vijf tikken (Focus, Jazz, 1970s, Hi-Res, Nooit gespeeld); met de bookmark uit R05.3 wordt het daarna één.
- [x] **R05.3 · 1,5 dag:** bookmarks: tabel `bookmarks (id, user_id, name, path, query, created_at)`; "Bewaar als bookmark" in het Focus-paneel; groep Bookmarks in de zijbalk. Smart playlists worden opgeslagen Focus-queries (zelfde filtertaal, OR-groepen, sortering en limiet), met migratie van de bestaande zes-veld-regels.
      _Gedaan:_ tabel `bookmarks` (schemaversie 16), privé per gebruiker; "☆ Save" in de Focus-balk bewaart de vraag als bookmark (naam voorgesteld uit de actieve filters), en de groep Bookmarks verschijnt in de zijbalk en in "Meer" zodra je er één hebt. Slimme playlists slaan nu een definitie op: Focus-queries als OR-groepen, één sortering, een limiet tot 1000; vanuit Focus maak je er één, of voeg je de huidige vraag als extra OR-groep toe aan een bestaande. De pagina toont de groepen in woorden met "Open in Focus" en bewerkt groepen, sortering en limiet. De zes-veld-regels zijn geen tweede systeem meer maar een deel van de Focus-taal (`rule=`, exact dezelfde SQL), en de migratie maakt van elke oude playlist één groep met dezelfde voorwaarden, volgorde en limiet; zulke playlists houden de oude regel-editor. Een test vergelijkt zeven regelsets met de oude query, letterlijk overgenomen: dezelfde tracks in dezelfde volgorde. Eén eerlijk verschil: artiesten sorteren nu hoofdletterongevoelig ("abba" naast "ABBA"), dus bij meer dan 200 treffers met zulke namen kan de grens net anders vallen. Gedeelde slimme playlists lezen de luistergegevens van de maker.
- [x] **R05.4 · 1,5 dag:** zoeken: genormaliseerde kolommen (`title_norm`, `name_norm`, NFKD zonder accenten) en zoeken daarop; genre, componist en dirigent doorzoekbaar; "Verberg dubbele edities" als Focus-optie (groep op `release_group_mbid`/artiest+titel, toon de hoogste kwaliteit). Tests en benchmark.
      _Gedaan:_ gevouwen kopieën van de doorzochte tekst (`name_norm`, `title_norm`, `artist_norm`, `album_norm`, plus `genre_norm` op albums en `credits_norm` met componist en dirigent op tracks): NFKD, Latijnse accenten weg, ø/æ/ß/ł enzovoort gevouwen, kleine letters; Japans en andere schriften blijven zoals getypt (ガ is geen カ). Triggers houden ze bij, wie er ook schrijft — scanner, identify-job, later een providersync — ook voor genres en credits in hun eigen tabellen; bestaande rijen worden bij de start één keer gevuld. Daarvoor is `search_text` als SQLite-functie geregistreerd op de verbinding van de app; een ander programma dat de bibliotheektabellen beschrijft zou die functie missen (staat in CLAUDE.md). "Dvorak" vindt nu Dvořák en zijn muziek via de credits, "electronique" een album via het genre, "Talich" een opname via de dirigent; een titeltreffer staat boven een treffer alleen in de credits. "Verberg dubbele edities" zat al in R05.1/R05.2. Benchmark op 50 000 tracks: zoeken p95 ≈ 34 ms (ook zonder accenten), Focus ≤ 120 ms. Kosten: de triggers maken schrijven ongeveer 40 µs per track trager — bij 11 000 tracks een halve seconde per volledige scan.

**Acceptatie:** "Hi-Res jazz uit de jaren 70 die ik nooit heb gespeeld" is in drie tikken een lijst met aantallen en een speelknop, en als bookmark te bewaren; "Dvorak" vindt "Dvořák"; bestaande slimme playlists geven na migratie dezelfde tracks.

### R06 — Tags, favorieten overal, waarderingen

**Doel:** de eigen ordening van de luisteraar, los van metadata.

- [x] **R06.1 · 2 dagen:** tabellen `tags (id, user_id, name, shared)` en `tag_items (tag_id, item_type, item_id)` voor album, artiest, track, playlist; API met eigendom zoals V09 (404 voor andermans tag, `shared` leesbaar voor het huishouden).
      _Gedaan:_ tabellen `tags` en `tag_items` (schemaversie 17), naam uniek per persoon zonder hoofdlettergevoeligheid. API `/api/tags` met dezelfde regels als playlists in V09: bewerken alleen door de eigenaar, een gedeelde tag leesbaar voor het huishouden (met naam van de eigenaar), elke andere tag een 404 — ook voor schrijven op andermans gedeelde tag. Een playlist kun je alleen taggen als je hem mag zien, en een gedeelde tag laat nooit een privé-playlist van een ander zien. `GET /tags/:id/tracks` geeft alles wat de tag betekent om te spelen: de tracks, de tracks van de albums en van de artiesten, zonder ontbrekende bestanden; playlists niet, die hebben hun eigen volgorde en bronnen. `GET /tags/on/:type/:id` geeft de chips voor een album- of artiestpagina. Een album dat uit de bibliotheek verdwijnt telt niet meer mee.
- [x] **R06.2 · 2 dagen:** tag-UI: "Tag toevoegen" in het speelactiemenu, tagbrowser (`/tags`, per tag de items met speelknop), tag als Focus-facet en als bookmarkonderdeel; tags op de albumpagina als chips.
      _Gedaan:_ "Add tag" in het speelactiemenu van albums, artiesten en tracks: je eigen tags met een vinkje waar het item al in zit, plus een veld om meteen een nieuwe tag te maken. Tagpagina `/tags` (jouw tags, daaronder "gedeeld met jou" met de naam van de eigenaar) met Shuffle per tag en een formulier voor een nieuwe tag; per tag `/tags/:id` met Play, Shuffle, "Verfijn in Focus", en — alleen als hij van jou is — hernoemen, delen, verwijderen en items eruit halen. Tags staan in de zijbalk onder "Your tags" en als ingang onder Bibliotheek. Tag is een Focus-facet (en daarmee deel van bookmarks en slimme playlists): een album telt mee via de tag zelf, via de artiest of via een track; een geraden id van andermans privé-tag filtert niets. Album- en artiestpagina tonen hun tags als chips die naar de tag leiden.
- [x] **R06.3 · 1 dag:** hart overal: spelerbalk, volledig scherm, zoekresultaten, wachtrijrijen, playlistrijen, Focus-lijsten. Favorieten van Qobuz blijven Qobuz-favorieten (synchronisatie in R07).
      _Gedaan:_ één gedeelde favorietenstore per type: een lijst vraagt één keer `GET /history/favorites/ids` in plaats van een check per rij, en een hart dat je in de spelerbalk aanzet staat meteen ook aan in de wachtrij, op de albumpagina en in de zoekresultaten (ook wanneer je het via het menu of de paginakop doet). Hetzelfde hart nu in: spelerbalk en volledig scherm (bestond al, nu gedeeld), zoekresultaten, wachtrij, playlist- en slimme-playlistrijen, de Tracks-pagina, albumtracks, tagpagina's, geschiedenis en favorieten; op album- en artiestkaarten (Albums, Artiesten, Genres, tags) linksboven, altijd zichtbaar zodra het een favoriet is. Een klik op het hart speelt de rij niet af; Qobuz-, Spotify- en radio-items krijgen geen hart (geen bibliotheek-id) — Qobuz-favorieten synchroniseren pas in R07. Bij in- en uitloggen begint de store leeg, zodat de volgende persoon nooit andermans hartjes ziet.
- [x] **R06.4 · 1 dag:** waardering 1–5 per track en album (`ratings (user_id, item_type, item_id, rating)`), als Focus-facet en sorteersleutel; tests voor rechten en migratie.
      _Gedaan:_ tabel `ratings` (schemaversie 17, sterren 1–5 afgedwongen door de database), `GET /api/ratings?type=` (alle eigen waarderingen in één keer) en `PUT /api/ratings` (null wist). Persoonlijk zoals favorieten: niemand ziet of filtert op andermans sterren; een gedeelde slimme playlist gebruikt die van de maker. Focus: facet "Your stars" (★ 1+ … ★ 5, met aantallen) en sorteersleutel "My rating" (zonder waardering onderaan). Sterren op de albumkop, bij albumtracks en op de Tracks-pagina (vanaf een breed scherm), uit één gedeelde store zoals de hartjes; nog eens op dezelfde ster klikken wist de waardering. Tests voor rechten, validatie, Focus en de migratie van een oude database (die nu ook bookmarks, tags, tag_items, ratings, `definition` en de zoekkolommen controleert).

**Acceptatie R06, stand:** tag "Zondagochtend" verschijnt in de zijbalk ("Your tags") en opent daar zijn pagina met Shuffle — gebouwd, maar de zijbalk zelf heeft geen test; de clienttest dekt de taglijst met twaalf albums en shuffle met nagemaakte serverdata, de servertest het afspelen van een tag met echte data; het hart werkt vanaf elke trackrij en elke album-/artiestkaart; een gedeelde tag is voor de ander zichtbaar maar niet bewerkbaar (server: 404 op elke schrijfactie; app: geen knoppen). Nog op de NAS te zien: de zijbalk en de hartjes op de telefoon.

**Acceptatie:** een tag "Zondagochtend" met twaalf albums is in de zijbalk te openen en te shufflen; het hart werkt vanaf elke rij; een gedeelde tag is zichtbaar maar niet bewerkbaar voor de ander.

### R07 — Eén bibliotheek: Qobuz in de collectie

**Doel:** Roon's dagelijkse gemak: een Qobuz-album dat je toevoegt, staat tussen je albums, speelt op elke kamer, en verdwijnt niet als de stream even weg is. Neemt **V12.1** op.

- [x] **R07.1 · 2,5 dag:** "Voeg toe aan bibliotheek" voor Qobuz-albums en -tracks: rijen in `albums`/`tracks`/`artists` met `source='qobuz'`, provider-id in een nieuwe `source_ref`-kolom (bron + id + editie, het `TrackReference`-begrip uit §8 van het vorige plan), `availability='streaming'`; hoes en metadata als snapshot. De scanner raakt niet-lokale rijen niet aan (`markMissing`, `pruneEmptyAlbums`, purge). Schemaversie omhoog.
      _Gedaan:_ "+ Add to library" op een Qobuz-albumpagina en "Add to library" in het menu van een Qobuz-track. Het album komt als gewone rijen in `albums`/`tracks` met `source='qobuz'`, `source_ref` (`qobuz:album:123`, `qobuz:track:456`; schemaversie 18), tracks `availability='streaming'` (of `'unavailable'` als Qobuz ze niet meer streamt), en titel, hoes, label en kwaliteit als snapshot. Eén afwijking van de plantekst, bewust: het rij-id is het provider-id (`qobuz:123`), omdat speler, wachtrij en client de afspeelroute op dat voorvoegsel kiezen — zo speelt een toegevoegd album via de bestaande Qobuz-route (verse URL bij afspelen) op elke kamer, en twee keer toevoegen geeft dezelfde rijen in plaats van een kopie. De artiest wordt gekoppeld aan de bestaande artiest met dezelfde naam (één Miles Davis, bestand of stream). Een losse track komt met een albumrij die alleen de toegevoegde tracks bevat. De scanner, de hoezenjob en de identify-job blijven van niet-lokale rijen af (`markMissing` deed dat al, `pruneEmptyAlbums` en de hoezenjob nu ook); een geforceerde herscan laat het album staan (getest). Verwijderen kan alleen voor Qobuz-albums, met bevestiging, en neemt favorieten, tags en sterren van dat album mee. De albumpagina van een toegevoegd album is nu een bibliotheekpagina (tags, sterren, harten). Onderweg gevonden en hersteld: sinds R06 werden tags en sterren in de kop van een lokaal album nooit getoond (`!providerType` was altijd onwaar); regressietest toegevoegd en geverifieerd dat die op de oude code faalt.
- [x] **R07.2 · 2 dagen:** synchronisatie met Qobuz-favorieten (beide richtingen, per persoon, met de bestaande `getAlbums`-favorietenroute): toevoegen in de app is favoriet in Qobuz en andersom; verwijderen vraagt bevestiging. Titels die Qobuz intrekt worden `availability='unavailable'`, met dezelfde gedimde weergave als `missing`.
      _Gedaan:_ bibliotheek ⇄ Qobuz-favorieten met een three-way merge tegen wat de vorige sync afsprak (tabel `qobuz_album_sync`): nieuw op Qobuz → in de bibliotheek; toegevoegd in de app → meteen favoriet op Qobuz (lukt dat niet, dan bij de volgende sync); uit de bibliotheek verwijderd (met bevestiging die zegt dat het ook uit de Qobuz-favorieten gaat) → favoriet weg op Qobuz. Wat jij op Qobuz uit de favorieten haalt, wordt hier níet stil verwijderd: het komt in Instellingen → Bibliotheek → "Qobuz favourites" te staan met Keep / Remove; "Keep" houdt het zonder favoriet en de sync laat het daarna met rust. Sync bij de start (na 30 s) en elke zes uur, plus "Sync now". Ingetrokken titels: een dagelijkse controle per album zet tracks op `unavailable` (album weg op Qobuz → alle tracks), en terug op `streaming` als Qobuz ze weer aanbiedt; overal (album, tracks, zoeken, playlists, tags, shuffle, aanbevelingen) behandeld als een ontbrekend bestand, met het label "not on Qobuz". Afwijking om te weten: de server heeft één Qobuz-login, dus "per persoon" betekent hier: de favorieten van dat ene account; echte per-persoon-sync vraagt een Qobuz-login per gebruiker, die er nog niet is. Ik heb de Qobuz-favorieten-API niet tegen het echte account kunnen testen (alleen tegen een nagemaakt account); `favorite/create`/`favorite/delete` met `album_ids` is de gedocumenteerde vorm, maar dit moet op de NAS bevestigd worden.
- [x] **R07.3 · 2 dagen:** playlists met stabiele bronreferentie (V12.1): `playlist_tracks` verwijst naar `source_ref` en metadata-snapshot; lokaal en Qobuz in één playlist; M3U-export markeert externe items expliciet. Resolver vraagt de verse Qobuz-URL pas bij afspelen (bestaand gedrag).
      _Gedaan:_ de basis lag er al sinds V12.1 (item = bronverwijzing + snapshot, lokaal en extern in één playlist, M3U-export met externe items als gemarkeerd commentaar, verse Qobuz-URL pas bij afspelen). Toegevoegd: kolom `playlist_tracks.source_ref` (`local:track:<id>`, `qobuz:track:123`), bij de start ingevuld voor bestaande rijen en als `sourceRef` in de API; een Qobuz-titel die in de bibliotheek staat kan op id alleen aan een playlist (de bibliotheek beschrijft hem, zoals bij een lokaal bestand); een titel die Qobuz introk staat in de playlist als onbeschikbaar met die reden (die reden gaat voor "niet ingelogd", want inloggen lost hem niet op). Test: een gemengde playlist (lokaal, Qobuz uit de bibliotheek, Qobuz van buiten) is na een herstart identiek, ook als de bronverwijzingen eerst leeg waren.
- [x] **R07.4 · 2,5 dag:** Focus-facet `source` (Lokaal / Qobuz / Beide) op elke lijst; artiestpagina toont lokale en Qobuz-albums samen met bronbadge; Versies (R04.3) toont nu ook toegevoegde Qobuz-edities. Tests: toevoegen, herscan raakt niets, favoriet-sync in beide richtingen, ingetrokken titel, gemengde playlist na herstart, profielscheiding.
      _Gedaan:_ het bronfacet bestond sinds R05.1; met Qobuz-albums in de bibliotheek verschijnt het nu vanzelf in het Focus-paneel, met de namen "Local" en "Qobuz" (beide aan of geen van beide = beide), op albums, artiesten en tracks. De artiestpagina toont lokale en toegevoegde Qobuz-albums samen, Qobuz met een badge. Versies (R04.3) toont een toegevoegde Qobuz-editie als bibliotheekversie ("library · Qobuz") en niet nog eens als Qobuz-suggestie. Tests, verdeeld over `qobuz-library`, `qobuz-sync` en `playlist-sources`: toevoegen, geforceerde herscan raakt niets, sync in beide richtingen, ingetrokken titel, gemengde playlist na herstart, en profielscheiding (één bibliotheek voor het huishouden, sterren en harten per persoon).

**Acceptatie R07, stand:** in tests bewezen: een toegevoegd Qobuz-album staat voor iedereen tussen de albums, blijft na een geforceerde herscan staan, en een gemengde playlist is na herstart identiek. Niet in een test te bewijzen en dus op de NAS na te lopen: toevoegen op de telefoon en zien op de desktop, afspelen via de NAS op de Sonos (de route is de bestaande Qobuz-route, ongewijzigd), en of de Qobuz-favorieten-API zich gedraagt zoals gedocumenteerd.

**Acceptatie:** een Qobuz-album toegevoegd op de telefoon staat op de desktop tussen de albums en speelt via de NAS op de Sonos; na een geforceerde herscan staat het er nog; een gemengde playlist blijft na herstart identiek (V12-acceptatie).

### R08 — Radio en ontdekken

**Doel:** de muziek stopt niet, en de app stelt iets voor dat direct kan spelen. Neemt **V12.2–V12.4** op.

- [x] **R08.1 · 3 dagen:** **Radio** per zone: als de wachtrij leegloopt en radio aanstaat, kiest de server het volgende nummer uit de bibliotheek (lokaal + toegevoegde Qobuz) op basis van seed (artiest, album, track, genre of tag), Last.fm-verwantschap (bestaand), gedeeld genre en gedeelde tags, met uitsluiting van de laatste 50 gespeelde nummers en van onbeschikbare items. Elke keuze draagt een "waarom" (bijv. "verwant aan Miles Davis via Last.fm; genre jazz"). Start radio vanuit het speelactiemenu en de artiestpagina. Aan/uit per zone, zichtbaar in de spelerbalk.
      _Gedaan:_ radio per zone (tabellen `zone_radio`, `radio_picks`; schemaversie 19). Kiest uit de bibliotheek (lokaal + toegevoegde Qobuz) rond een seed — artiest, album, track, genre of tag — of, als je radio alleen aanzet, rond wat er speelt. Nabijheid komt uit Last.fm-verwantschap (bestaande route, met cache van een dag en een time-out van 1,5 s zodat een trage Last.fm de start niet ophoudt), gedeeld genre en gedeelde tags; elke keuze bewaart zijn "waarom" (bijv. "Related to Miles Davis (Last.fm) · genre Jazz"). Nooit gekozen: wat niet kan spelen (ontbrekend of door Qobuz ingetrokken), wat al in de wachtrij staat, en de laatste 50 gespeelde of gekozen nummers. Variatie: hoogstens twee per artiest en één per album per batch, en nooit twee keer achter elkaar dezelfde artiest. De server vult aan bij elke trackstart met minder dan drie nummers te gaan (vijf erbij), ook voor een speaker zonder open tabblad; vindt hij niets meer, dan zegt hij dat en stopt hij. "Start radio" in het speelactiemenu (artiest, album, track) en op de artiestpagina speelt tien keuzes af via de gewone afspeelroute (dus op elke uitgang). Radio-knop in de spelerbalk (desktop) en in het volledige scherm; de spelerbalk en het volledige scherm tonen "Radio · waarom" bij een gekozen nummer. Zelf een nieuwe wachtrij kiezen laat de seed los: radio volgt dan wat er speelt. Bekende grens: zet je radio aan terwijl de laatste track al bijna voorbij is en is de aanvulling er nog niet, dan stopt de muziek eenmalig (in de praktijk vult hij meteen bij het aanzetten).
- [x] **R08.2 · 2 dagen:** Home als Roon's overzicht: Verder luisteren (laatst gespeelde albums met positie), Nieuw in je bibliotheek, Voor jou (ListenBrainz-aanbevelingen met speelbare matches via MBID, V12.2), Genres voor jou, Dagelijkse mix (lokaal gegenereerd uit geschiedenis, zonder externe account); elk blok met hoes en speelactie.
      _Gedaan:_ Home is een overzicht met blokken, elk met hoes en speelactie. **Verder luisteren**: laatst gespeelde albums met de track waar je stopte (halverwege → die track op die positie; afgemaakt → de volgende), een voortgangsbalk, en afgemaakte albums niet; de speler springt naar de positie zodra de track speelt. **Vandaag**: de dagelijkse mix uit je eigen geschiedenis (de bestaande lokale mix, geen extern account), één keer per dag gemaakt en in `user_preferences` bewaard zodat hij de hele dag (ook na een herstart) gelijk blijft; "Why these?" toont per nummer de reden; nummers die sinds de ochtend niet meer kunnen spelen vallen eruit. **For you**: ListenBrainz-aanbevelingen, alleen wat in je bibliotheek staat (match via MBID uit V12.2), apart opgehaald zodat Home er niet op wacht. **Nieuw in je bibliotheek** (ook toegevoegde Qobuz-albums, met badge). **Genres voor jou**: je meest gespeelde genres van de laatste 90 dagen (zonder geschiedenis: de grootste genres van de bibliotheek), met hoes-collage, link naar Focus en "▶ Radio" (genre-radio uit R08.1). Nieuwe route `GET /api/home`.
- [x] **R08.3 · 1,5 dag:** shuffle zonder herhaling per ronde en voorkeur voor minder recent gehoord (V12.3); Discover met hoezen en speelknoppen; uitleg per aanbeveling en uitschakelbaar.
      _Gedaan:_ shuffle in rondes zonder herhaling met voorkeur voor minder recent gehoord bestond al sinds V12.3 (`shuffle-round.test`), net als de uitleg per aanbeveling en het uitschakelen van de persoonlijke basis (V12.2). Nieuw op Discover: een hoes bij elk item dat in de bibliotheek staat, "Play what is in your library" per ListenBrainz-lijst (alleen zekere matches, zoals de losse speelknoppen), en "Show why each item is here" om de uitleg te verbergen — onthouden in deze browser, en de uitleg blijft één klik weg.
- [x] **R08.4 · 1,5 dag:** tests: radio kiest nooit een onbeschikbaar item, herhaalt niets binnen 50, stopt netjes als de bibliotheek geen kandidaat heeft; ontdekmix opslaan als playlist; profielscheiding (V12.4).
      _Gedaan:_ radiotests in `library-radio.test` (nooit een ontbrekend of door Qobuz ingetrokken item, niets herhaald binnen 50 over twaalf aanvullingen, netjes stoppen met melding als er geen kandidaat is, aanvullen bij een echte trackstart, "Start radio" binnen twee seconden met tien nummers, 409 als niets dichtbij genoeg is); ontdekmix opslaan als playlist bestond al (`discovery-mix.test`, V12.4); profielscheiding in `radio-profiles.test`: een privé-tag van een ander kan geen radio starten (404) en wordt nooit als reden genoemd, Home en de dagelijkse mix zijn per persoon (alleen jouw geschiedenis bouwt jouw mix).

**Acceptatie R08, stand:** in tests bewezen: na het laatste nummer speelt de zone door met verwante muziek en elke keuze heeft een reden; een dagelijkse mix bestaat zonder ListenBrainz-account; "Start radio" vanaf een artiest levert binnen twee seconden tien nummers (in de test, zonder echte Last.fm; met Last.fm kapt de time-out van 1,5 s een trage lookup af). Op de NAS te zien: radio op een Sonos zonder open tabblad, en hoe de redenen er in de spelerbalk uitzien.

**Acceptatie:** na het laatste nummer van een album speelt de kamer door met verwante muziek en toont waarom; een dagelijkse mix bestaat zonder ListenBrainz-account; "Start radio" vanaf een artiest vult binnen twee seconden de wachtrij met tien nummers.

### R09 — Multi-room: Sonos-groepen, overdracht, slaaptimer

**Doel:** wat binnen één ecosysteem echt kan, aanbieden; niets beloven over protocollen heen.

_Vrijgegeven op 13 oktober 2026: NAS-test "twintig overgangen zonder dubbele dispatch" geslaagd._

- [x] **R09.1 · 2,5 dag:** Sonos-groepen aansturen: "Groepeer met…" op een Sonos-zone stuurt `SetAVTransportURI x-rincon:<coordinator>` naar het lid; "Verlaat groep" stuurt `BecomeCoordinatorOfStandaloneGroup`. Een groep is één zone (de coördinator); leden zijn niet apart kiesbaar zolang ze gegroepeerd zijn (`zones.device_id` UNIQUE blijft de waarheid). Groepsvolume via `GroupRenderingControl`.
      _Gedaan (13 oktober 2026):_ `server/src/services/sonos-groups.ts` + de Sonos-driver. "Group…" in de speler laat andere Sonos-kamers meespelen (`SetAVTransportURI x-rincon:<leider>` naar het lid) of haalt ze eruit (`BecomeCoordinatorOfStandaloneGroup`). Wat het lid speelde stopt, maar de wachtrij blijft bewaard voor als het de groep verlaat. Een lid kan niet apart bestuurd worden: elk commando krijgt 409 met "speelt mee met …", en "Move to…" biedt het niet aan. In de speler van het lid staat "With Kitchen", met "Steer Kitchen" en "Leave the group". Het volume op de leider is het groepsvolume (`GroupRenderingControl`, met een snapshot zodat de onderlinge balans blijft). De topologie wordt na elke wijziging opnieuw gelezen, en elke minuut, zodat groeperen in de Sonos-app hier ook verschijnt. **Grenzen:** een kamer die zelf een groep leidt, kan niet bij een andere aansluiten (eerst zijn leden eruit halen). DLNA en Volumio groeperen niet. Tests: wat er naar de speaker gaat (nagebootste Sonos), groeperen, het lid weigeren, ontgroepen, weigeringen. **Niet getest op echte Sonos — NAS-acceptatie: twee Sonos in één groep vanuit één wachtrij, groepsvolume, ontgroepen zonder verlies van de wachtrij.**
- [x] **R09.2 · 1,5 dag:** zone-overdracht: "Verplaats naar…" neemt wachtrij, huidig item en positie mee naar een andere zone (`queue/set` + seek uit R01), stopt de oude. Werkt over protocollen heen omdat het geen synchronisatie is.
      _Gedaan (13 oktober 2026, op verzoek vóór de NAS-test gestart):_ `POST /api/playback/transfer` (`server/src/services/zone-transfer.ts`) neemt wachtrij, huidig nummer, positie, shuffle, herhalen en radio mee; de nieuwe kamer start eerst, daarna stopt de oude en laat zijn speaker los. Na de start wacht de server (max. 10 s) tot de speaker speelt en springt dan naar de positie; kan de speaker niet springen, start hij niet op tijd of weigert hij, dan speelt het nummer vanaf het begin en zegt de app dat. In de speler (balk en volledig scherm) staat "Move to…" met alleen kamers die de server zelf kan bespelen. **Grenzen:** een browserkamer of Spotify Connect is geen doel (de server kan geen tabblad starten), wel een bron; de slaaptimer blijft bij de oude kamer; het verzoek duurt tot ~10 s bij een trage speaker. Tests: verplaatsen met positie, radio gaat mee, geen-seek- en niet-gestart-melding, weigeringen. **Niet getest op echte Sonos/DLNA — NAS-acceptatie: Sonos → DLNA en terug, met positie.**
- [x] **R09.3 · 1,5 dag:** slaaptimer en "stop na dit nummer / dit album" per zone, uitgevoerd door de server (ook bij gesloten client), zichtbaar en annuleerbaar in de speler (E01). **Geleverd door E01 (18 september 2026), op master sinds de merge van 6 oktober 2026; wacht nog op NAS-acceptatie.**
- [x] **R09.4 · 2,5 dag:** Volumio: mDNS-discovery proberen (Volumio adverteert zichzelf; op het apparaat verifiëren), anders statisch blijven; onderzoek of `addToQueue` + `play` een next-URI-equivalent geeft voor overdracht vooraf. Tests: groeperen/ontgroepen met een nagebootste topologie, overdracht met positie, timer die een kamer stopt terwijl de andere doorspeelt.
      _Gedaan (13 oktober 2026):_ **mDNS:** Volumio adverteert zich als `_Volumio._tcp` op poort 3000, met TXT-velden `volumioName` en `UUID` (dit staat in de broncode van de volumiodiscovery-plugin; de officiële documentatie zegt er niets over). De server vraagt dat bij elke discovery 3 s na via `multicast-dns`. Een aangekondigde speler wordt alleen opgenomen als hij op `getState` antwoordt, met de naam die de eigenaar eraan gaf. Hij krijgt dezelfde id als een geconfigureerde speler (`volumio-<ip>`), dus een bestaande kamer blijft werken en er ontstaat geen dubbele. `VOLUMIO_DEVICES` blijft werken; `VOLUMIO_MDNS=false` zet het vragen uit. Een rooktest hier (zonder Volumio) gaf 0 spelers en geen fout. **Overdracht vooraf:** `addToQueue` bestaat in de REST-API, maar wat Volumio met een stream-url in de wachtrij doet (aansluitend spelen, en hoe de wachtrij groeit) is niet te verifiëren zonder apparaat. Daarom geen `setNextUri` voor Volumio: de server start elk nummer zelf aan het eind van het vorige. **Bug gevonden en opgelost:** `deviceManager.setNextUri` keerde voor Volumio stil terug, waardoor de server het volgende nummer "overgedragen" vond en daarna op Volumio bleef wachten. Een album stopte zo waarschijnlijk na het eerste nummer. Nu weigert de driver, en de capabilities zeggen "geen overdracht vooraf". **Tweede bug:** de slaaptimer (minutenmodus) stopte alleen de sessie, niet de speaker; nu stopt `stopRoom` ook de speaker zelf. Tests: mDNS-records in willekeurige volgorde, een niet-antwoordende speler, geen dubbele, uitzetten; Volumio-overdracht weigert; een timer stopt de slaapkamer-speaker terwijl de keuken doorspeelt. Groeperen/ontgroepen en overdracht met positie zijn getest in R09.1 en R09.2. **NAS-acceptatie: wordt de Volumio op 192.168.2.42 gevonden zonder `VOLUMIO_DEVICES`, en speelt een album erop door na nummer 1?**

**Acceptatie:** twee Sonos-spelers spelen als één groep vanuit één wachtrij, met één volume; een album gaat van keuken naar woonkamer met behoud van positie; de slaaptimer stopt de kamer met een gesloten tablet. Expliciet niet: Sonos en Cocktail Audio synchroon.

### R10 — Audio op de speaker: formaatadaptatie en egalisatie (proef)

**Doel:** beslissen, met meting, of de NAS audio voor speakers mag bewerken. Alleen starten na R09.

- [ ] **R10.1 · 2 dagen:** proef: ffmpeg-passthrough op `GET /tracks/:id/stream?format=…` uitsluitend wanneer `output-capabilities` zegt dat de speler het bronformaat niet accepteert (FLAC → WAV of MP3 320 naar keuze); één gelijktijdige conversie per zone; CPU en geheugen op de NAS meten bij één en twee kamers; audiopad toont de stap als `known` met de reden.
      _Code gedaan (14 oktober 2026, op verzoek gestart zonder dat een onverenigbare speaker was vastgesteld); NAS-meting open._ `server/src/services/transcode.ts`. Bij elke overdracht vraagt de resolver de formatenlijst van de speaker op (`GetProtocolInfo`). Staat het bronformaat er niet in maar MP3 (of WAV) wel, dan krijgt de speaker `…/stream?format=mp3&zone=…` en zet ffmpeg het bestand op de NAS om naar MP3 320 kbit/s. Hoge samplerates gaan naar 48 of 44,1 kHz; met `TRANSCODE_TARGET=wav` wordt het WAV, 16 of 24 bit. Een speaker zonder formatenlijst krijgt het origineel (stilte is geen "nee"). Ontbreekt ffmpeg, dan gaat ook het origineel. `TRANSCODE_FOR_SPEAKERS=false` zet het helemaal uit. Het audiopad toont "Converted on the NAS to MP3 320" als `known`, met de reden, en zegt dat MP3 lossy is. **Afwijking van het plan:** maximaal _twee_ conversies per zone, niet één: het nummer dat speelt plus het nummer dat vooraf aan de speaker is doorgegeven. Bij één zou de gapless-overdracht het spelende nummer afbreken. Een derde vervangt de oudste. Elke conversie wordt gemeten (CPU-tijd en piekgeheugen uit /proc, elke 2 s) en is te zien op `GET /api/playback/transcodes` (admin). **Referentiemeting (sandbox, Xeon 2,1 GHz, géén NAS):** 4 min FLAC 44,1/16 → MP3 320 kost 2,6 s CPU (1,1% van één kern), 96/24 → MP3 3,4 s (1,4%), naar WAV 0,4–0,7 s; twee tegelijk 5,9 s; ~55 MB geheugen per ffmpeg. ffmpeg werkt in een stoot vooruit en wacht daarna op de speaker. **Grenzen:** de geconverteerde stream heeft geen lengte en geen byte-ranges, dus springen binnen een nummer werkt waarschijnlijk niet op zo'n speaker. Een geweigerde Seek wordt per apparaat onthouden en geldt dan ook voor originele bestanden. Qobuz-streams worden niet geconverteerd (CDN-url, geen proxy). Tests: beslissing (aliassen, geen lijst, geen bruikbaar doel), ffmpeg-argumenten, resolver, ffmpeg ontbreekt, audiopad, twee per zone, een echte conversie 96/24 FLAC → MP3 48 kHz 320 kbit/s (gecontroleerd met ffprobe), ophangen stopt ffmpeg, HEAD start niets. De echte-ffmpeg-tests worden overgeslagen waar ffmpeg ontbreekt. **NAS-acceptatie open:** `GET /api/playback/transcodes` met één en twee kamers tegelijk, en een speaker die alleen MP3 opgeeft (als die er is).
- [ ] **R10.2 · 1,5 dag:** volume-egalisatie op dat pad: ReplayGain uit de database via ffmpeg `volume`, alleen als er toch geconverteerd wordt of als de gebruiker het per zone expliciet aanzet (dan is een lossless FLAC niet langer bit-perfect, en het audiopad zegt dat). Geen EQ.
- [ ] **R10.3 · 1,5 dag:** besluitdocument: gemeten CPU, gehoorde kwaliteit, welke speakers het nodig hadden. Drie uitkomsten: productiseren, alleen-bij-onverenigbaar-formaat houden, of verwijderen.

**Acceptatie:** een FLAC speelt op een speler die alleen MP3 opgeeft, met een audiopad dat de conversie noemt; CPU-belasting op de NAS is vastgelegd; de keuze is genoteerd in dit document.

## 7. Volgorde, beslismomenten en meetpunten

**Voorwaarde vooraf.** De open NAS-acceptatie uit V03–V11 (§2) wordt afgerond tijdens R00–R01; de NAS is alleen overdag beschikbaar, dus plan die tests aan het begin van een werkdag. Zolang "twintig overgangen zonder dubbele dispatch" niet is gezien, start R09 niet. **Gezien op 13 oktober 2026:** Danny voerde de test op de NAS uit, twintig overgangen zonder dubbele dispatch. R09 is daarmee vrijgegeven.

**Beslismomenten**

- **Na R02:** ziet de app er op telefoon en desktop uit als één product? Zo nee, eerst tokens en primitives afmaken voordat R04 en R05 er pagina's op bouwen.
- **Na R04:** levert de identificatiejob op de echte bibliotheek genoeg MBID's op (streefwaarde: 80 % van de albums eenduidig)? Zo nee, eerst de matchregels bijstellen; R07 en R08 leunen erop.
- **Na R06:** eerste bruikbare "Roon-gevoel"-release. Kies expliciet tussen R07 (Qobuz in de collectie) en R08 (radio) op basis van wat het meest gemist wordt.
- **Na R09:** alleen R10 starten als er een speaker is die het bronformaat niet accepteert, of als de gebruiker egalisatie op speakers echt wil.

**Meetpunten** (voorgestelde doelen, geen behaalde resultaten)

| Onderwerp            | Streefwaarde                                                                                          | Vanaf |
| -------------------- | ----------------------------------------------------------------------------------------------------- | ----- |
| Speelacties          | "Speel hierna" vanaf elke rij in maximaal twee tikken; geen wachtrijverlies in tests met twee clients | R01   |
| Seek                 | Positie op speaker binnen 1 s na loslaten; geweigerd met reden waar niet ondersteund                  | R01   |
| Thema en navigatie   | Geen donkere restanten in licht thema; toegankelijkheidsscore niet lager dan vóór R02                 | R02   |
| Identificatie        | Minimaal 80 % van de albums met eenduidige MBID na de job; geforceerde herscan op de NAS gemeten      | R03   |
| Focus                | p95 onder 300 ms voor gefilterde lijst met facet-aantallen op 50 000 tracks                           | R05   |
| Gedeelde bibliotheek | Toegevoegd Qobuz-album overleeft geforceerde herscan en herstart; favoriet-sync binnen 10 s           | R07   |
| Radio                | Geen herhaling binnen 50 nummers; geen onbeschikbaar item; keuze binnen 2 s                           | R08   |
| Groepen              | Twee Sonos in één groep vanuit één wachtrij; ontgroepen zonder verlies van de wachtrij                | R09   |
| Conversie            | CPU op de NAS bij één en twee gelijktijdige conversies vastgelegd                                     | R10   |

**Definitie van afgerond** blijft die van het vorige plan (§9 daar): aantoonbare gebruikersuitkomst, groene controles, gedocumenteerde contracten en migraties, hardwarecriteria op hardware getest, anders "wacht op acceptatie".

## 8. Bronverwijzingen naar de onderzochte code

- Schema: `server/src/db/schema.ts` (artists 11-18, albums 20-50, tracks 52-94, favorites 375-393, zones 200-208, transition_log 217-241, queue_items 264-288).
- Scanner: `server/src/services/scanner.ts` (tags 856-1057, albumidentiteit 897-949, artiestenrij 874-895, `normalizePeople` 1059-1065, fingerprint 815-834, hoes 1038-1041).
- Zoeken: `server/src/services/local-search.ts`, `server/src/providers/registry.ts` (37-49, 291-344), `server/src/services/search.ts`.
- Externe metadata: `server/src/services/coverart-fetch.ts` (177-236, 332-364), `similar-artists.ts` (1-5, 29-46), `listenbrainz.ts` (68-91), `lyrics.ts` (45-97).
- Bibliotheekroutes: `server/src/routes/library.ts` (albums 137-160, stream 257-343, genres 347-384); smart playlists `server/src/routes/smart-playlists.ts` (30-42, 140-200).
- Providers: `server/src/providers/qobuz.ts` (favorieten 485-524, stream 592-631), `tidal.ts` (381-404), `spotify.ts` (627); stubs `spotify-stub.ts`, `tidal-stub.ts`.
- Apparaten: `shared/src/device.ts` (23-44), `server/src/devices/dlna.ts` (251-290, 332-356, 359-377), `sonos.ts` (117-135, 188-208, 328-355), `volumio.ts` (32-64, 86-107), `manager.ts` (41-57, 90-185).
- Afspelen: `server/src/services/playback.ts` (200-289, 684-699, 719-742), `server-player.ts` (201-297, 362-368, 390-447), `playback-resolver.ts` (100-159, 238, 253-306), `device-monitor.ts` (207-239, 296-303, 363-392), `output-capabilities.ts` (88-99, 122-191, 199-225, 262-265), `transitions.ts` (65-104, 153-178), `audio-path.ts` (101-182), `zones.ts` (40-48, 119-162), `librespot.ts` (101-139, 163-219, 277-302).
- Playbackroutes: `server/src/routes/playback.ts` (zones 183-283, queue 389-535, transport 538-667).
- Client speler: `client/src/hooks/useAudio.ts` (ReplayGain 133-160, crossfade 299-325, preload 326-395, 374, 474, 489), `client/src/context/AudioContext.tsx`, `client/src/components/NowPlayingBar.tsx` (136-167, 276-315), `NowPlayingFull.tsx` (85-91, 141-173, 283-309), `DeviceSelector.tsx` (144-249), `AudioPathPanel.tsx`.
- Client pagina's: `client/src/pages/AlbumPage.tsx` (16, 154-276), `ArtistPage.tsx` (87-158), `AlbumsPage.tsx` (32-45, 117-130), `GenresPage.tsx` (43-147), `SearchPage.tsx` (150-162, 228-274, 399-432), `DiscoverPage.tsx` (34-68, 78, 140-157), `HomePage.tsx` (53-76, 102-237), `SmartPlaylistsPage.tsx` (32-197), `SettingsPage.tsx` (277-331, 814-854).
- Lay-out en thema: `client/src/components/Layout.tsx` (11-26, 46-92, 95-126), `client/src/main.tsx`, `client/index.html` (17), `client/src/index.css` (6-52), `client/tailwind.config.js`, `client/src/api/client.ts` (443-451, 824-825).

## 9. Uitvoeringslog

### R00 — 18 september 2026

**Uitgevoerd:** R00.1–R00.6 in code, op branch `claude/sprint-r00-directe-reparaties`. Omgeving: Windows 11, Node 24, lokale werkmap; geen NAS, geen apparaten, geen provideraccounts.

| Controle                 | Voor R00                           | Na R00                                                      |
| ------------------------ | ---------------------------------- | ----------------------------------------------------------- |
| Servertests              | 327 geslaagd, 1 gefaald (45 files) | 326 geslaagd, 1 overgeslagen met reden (45 files)           |
| Clienttests              | 118 geslaagd (26 files)            | 146 geslaagd (30 files)                                     |
| Lint / typecheck / build | groen                              | groen                                                       |
| Browsergrens             | altijd `reloaded`                  | `preloaded` zodra het volgende nummer lokaal is             |
| Thema bij koude start    | altijd donker buiten Settings      | opgeslagen keuze, anders die van het besturingssysteem      |
| Kamers aanmaken          | alleen met `curl`                  | Settings → Rooms (admin)                                    |
| Discnummers              | geparsed, nooit getoond            | kopje per disc bij meer dan één disc                        |
| Service worker in dev    | registreerde en bediende oude code | registreert niet onder `vite dev`, ruimt een oude worker op |

**Browsercontrole (R00.2).** Alleen de client-devserver gestart, zodat de lokale database niet gemigreerd werd. Zonder opgeslagen keuze volgt de app het besturingssysteem (`prefers-color-scheme: light` → `data-theme="light"`, witte achtergrond); met `oled` opgeslagen staat `--surface-dark` op `#000000` op de **inlogpagina**, dus zonder Settings te bezoeken. Dat is precies wat eerder niet gebeurde.

**Wat de browsercontrole opleverde naast het thema:** een service worker uit een eerdere sessie bediende de pagina met een gecachte bundel, waardoor de nieuwe code er niet leek te staan. Dat is R00.6 geworden.

**Niet in de browser gecontroleerd, met reden:** de kamerbeheersectie en de discnummers zitten achter een inlog, en een account aanmaken of een wachtwoord invoeren doe ik niet. Beide zijn wel met tests gedekt (acht tests voor de kamersectie, drie voor de discnummers). Dit blijft daarom **wacht op acceptatie** volgens §7 van het eerste plan.

**Drie omgevingsbevindingen, geen productfouten:**

1. **`node_modules` liep achter op de lockfile.** `music-metadata` stond lokaal op 10.9.1 terwijl de lockfile 11.15.0 voorschrijft, waardoor `npm run typecheck` faalde op `parseFile` in `coverart.ts` en `scanner.ts`. Na `npm ci` groen. Niets in de code aangepast. Wel iets om te weten: een falende typecheck hoeft niet aan de code te liggen.
2. **`npm run format:check` faalt op 159 bestanden, ook op bestanden die deze sprint niet zijn aangeraakt.** Twee oorzaken, gemeten: 155 bestanden hebben CRLF-regeleindes in de werkkopie terwijl `.prettierrc` `endOfLine: "lf"` voorschrijft, en 4 bestanden hebben een echt opmaakverschil — prettier 3.8.3 wil regels van 101 tekens afbreken die de vastgelegde opmaak laat staan (`printWidth: 100`), bijvoorbeeld in `server/src/utils/pagination.ts`. Er is geen `.gitattributes`, en `core.autocrlf` staat op `true`, dus elke git-operatie die bestanden terugzet kan LF in CRLF veranderen; dat gebeurde deze sprint zichtbaar na een `git stash`. CI draait `format:check` niet in de verify-job, dus dit blokkeert niets. Bewust niet in deze sprint opgelost: 159 bestanden aanraken zou de echte wijziging onvindbaar maken. Voorstel als losse opruimactie: een `.gitattributes` met `* text=auto eol=lf`, daarna één normalisatiecommit en `format:check` toevoegen aan CI. De bestanden van deze sprint staan wél op LF en zijn prettier-schoon.
3. **De lokale ontwikkeldatabase is een oude database.** `data/audioserver.db` heeft 11 403 tracks en 1321 albums, maar `users` zonder `role` en geen `zones`-tabel: schemaversie van vóór V02. Dat is dezelfde vorm die op de NAS de storing van 9 september veroorzaakte, en dus bruikbaar testmateriaal voor een migratie. Hij is deze sprint niet gemigreerd (de server is niet gestart); wie dat wil doen, maakt eerst een kopie.

**Openstaand na R00:** de NAS-acceptatie uit V03–V11 die §7 als voorwaarde noemt, plus de twee punten hierboven die een inlog vragen. R01 (speelacties, seek en de speler) kan starten; die sprint raakt de wachtrijcontracten en is de plek om de twintig overgangen op de referentiespeaker te meten.

### R01 — 18 en 19 september 2026

**Uitgevoerd:** R01.1–R01.4 in code, op branch `claude/sprint-r01-speelacties-seek` (gestapeld op R00). Zelfde omgeving als R00.

| Controle                 | Na R00                             | Na R01                                                  |
| ------------------------ | ---------------------------------- | ------------------------------------------------------- |
| Servertests              | 326 geslaagd, 1 overgeslagen (45)  | 364 geslaagd, 1 overgeslagen (47)                       |
| Clienttests              | 146 geslaagd (30)                  | 181 geslaagd (33)                                       |
| Lint / typecheck / build | groen                              | groen                                                   |
| "Speel hierna"           | bestond niet in de UI              | op elke track-, album- en artiestrij, ook onder shuffle |
| Seek op een speaker      | kon niet; balk bewoog, muziek niet | DLNA, Sonos, Volumio, of zichtbaar geweigerd met reden  |
| Hart in de speler        | nergens                            | volledig scherm en balk (desktop)                       |
| Kamer kiezen             | alleen in de balk                  | ook in het volledige scherm                             |

**Gevonden en opgelost tijdens de sprint:** "speel hierna" onder shuffle speelde niet hierna. De plek in de wachtrij klopte, maar met shuffle aan kiest de server het volgende nummer willekeurig. Zonder de test die het plan voor R01.4 vroeg was dit pas bij gebruik opgevallen, en dan als "werkt soms". Zie R01.4 voor de oplossing.

**Afwijkingen van het plan, bewust:** geen long-press op mobiel (iOS opent dan het linkvoorbeeld, en in de wachtrij botst het met de sleepgreep; de ⋯-knop is op aanraakschermen altijd zichtbaar en opent een sheet), geen `mode: 'append'` op `/queue/set` (dubbel met `/queue/add`), en hart plus lyrics in de spelerbalk alleen op desktop. De kaarten op Home en Ontdekken hebben nog geen menu: R08 herbouwt die pagina's.

**Twee tests kregen een realistisch tijdsbudget, met de reden in de test:** de sessietests rekenen met echte bcrypt-kosten 12, ongeveer een halve seconde per bewerking, en de eerste doet er negen achter elkaar; de importtest laadt alle modules koud en draait elke migratie. Beide meten iets anders dan snelheid. De sessietests faalden ook op de R00-commit zonder deze wijzigingen, dus ze kwamen niet door R01.

**Omgevingsbevinding: workers vallen weg onder geheugendruk.** Met het standaardaantal fork-workers stopten acht workers "onverwacht" terwijl er 3,3 GB van 16 GB vrij was; met `npx vitest run --maxWorkers=2` slagen alle 47 bestanden. Geen codeprobleem. Wie lokaal op een drukke machine test, geeft dat vlaggetje mee.

**Niet in de browser gecontroleerd, met reden:** menu, speler en wachtrij zitten achter een inlog, en een account aanmaken of een wachtwoord invoeren doe ik niet. Alles is met tests gedekt: 38 nieuwe servertests en 35 nieuwe of aangepaste clienttests, waaronder het menu met muis, toetsenbord en als sheet op een smal scherm.

**Wacht op acceptatie (NAS):** spoelen op de Cocktail Audio, de Sonos en de Volumio, of een zichtbare weigering waar het niet kan; "speel hierna" vanuit zoeken, album en playlist tijdens een album op een speaker, met de tablet daarna dicht; "speel hierna" met shuffle aan op een speaker, en kijken of het klaargezette nummer ook het nummer is dat komt; de wachtrij opslaan als playlist met een Qobuz-nummer erin.

**Beslismoment na R01:** R02 (navigatie, zoekbalk, thema) kan starten. De NAS-acceptatie van V03–V11 en R01 blijft de voorwaarde voor R09.

### Samenvoeging met V12 — 19 september 2026

**Correctie op dit plan.** De analyse van 18 september las de lokale werkmap, en die liep achter op GitHub. Een andere sessie had die ochtend V12.1–V12.4 al gebouwd en naar master gepusht: gemengde playlists met bronverwijzing en momentopname, aanbevelingen met herkomst en een lokale mix, shuffle als ronde, en een ontdekmix bewaren. Een sleeptimer (E01) staat op de branch `claude/verbeterplan-sprints-uitvoering-tdav7i`, niet op master. Gevolgen voor dit plan: **R07.3** (gemengde playlists) en **R08.3** (shuffle zonder herhaling) zijn al gedaan, **R08.2** deels, en **R09.3** (slaaptimer) ligt klaar op die branch.

**Wat het samenvoegen vroeg.** Zes conflicten, en drie plekken waar de code wel samenging maar de betekenis niet:

- **Shuffle.** De ronde van V12.3 en de "speel hierna"-belofte van R01 werken samen: de belofte gaat voor, en een beloofd nummer telt als gehoord in de ronde. Mijn invoegfuncties gooiden de ronde niet weg zoals elke andere wachtrijbewerking dat doet; nu wel.
- **Playlists.** V12.1 laat Qobuz- en radio-items in een playlist toe. "Bewaar als playlist" en het menu volgen dat model: externe items gaan mee met hun momentopname, Spotify blijft erbuiten, en een lijst wordt item voor item via V12.1's eigen regels opgeslagen, in één transactie.
- **Playlistpagina.** V12.1 speelt vanaf een rij alleen wat nu kan spelen; het menu gebruikt nu diezelfde lijst, zodat een onbeschikbaar item nooit via "speel vanaf hier" in de wachtrij komt.

**Gecontroleerd:** lint en typecheck groen; client 190 tests groen; server 402 tests groen en 1 bewust overgeslagen. Eén testbestand van V12.4 (`discovery-mix`) meldt daarna een fout bij het opruimen: al zijn zes tests slagen, maar Windows laat de tijdelijke databasemap niet verwijderen. Dat bestand gebruikt de gewijzigde lijst-variant niet; de Linux-CI op GitHub is voor dit punt de maatstaf.

### E01 (slaaptimer) samengevoegd met master — 6 oktober 2026

**Wat er gebeurde:** de sleeptimer uit de oude backlog (§7, E01) lag af op de sprintbranch van verbeterplan 1 maar stond nog niet op master, terwijl master inmiddels vier commits verder was (R00–R02). Een echte merge dus, geen fast-forward. Daarmee is **R09.3 in code klaar** zonder dat R09 zelf is begonnen.

**Drie conflicten, en wat de samenvoeging moest beslissen:**

- `peekNext()` — R01 gaf hier een "speel hierna"-belofte voorrang (ook in shuffle), E01 wilde juist níets vooruit doorgeven als de muziek bij deze grens stopt. Beide blijven, in deze volgorde: eerst wordt bepaald welke positie zou volgen (de belofte, anders de volgende, anders de wikkel bij repeat), dán kijkt de slaaptimer naar díé grens, en pas daarna geldt "shuffle belooft niets". Een beloofd nummer wordt nu dus met het juiste album vergeleken bij "stop na dit album" — met de oude E01-code was dat altijd het nummer ná het huidige.
- `NowPlayingFull` — de importregels liepen uiteen (R01 voegde kamerkiezer, seekbalk, hart en audiopad toe); alles blijft, de slaaptimer staat naast repeat in de transportrij.
- `CHANGELOG.md` — beide blokken blijven, in datumvolgorde: R00–R02 boven E01.

**Gecontroleerd na de merge:** 415 servertests (1 bewust overgeslagen) en 216 clienttests groen, lint en typecheck groen, build van alle workspaces groen. `shared` moest eerst opnieuw gebouwd worden: R01 breidde `DeviceController` uit met `seek`, en de server leest die typen uit `shared/dist`.

**Wacht op acceptatie (NAS):** een timer van vijf minuten zetten, de tablet dichtklappen en controleren dat de speaker vanzelf stopt; "na dit album" op de voorlaatste track; een timer in de slaapkamer terwijl de keuken doorspeelt; de server herstarten met een lopende timer; zetten op het ene tabblad en annuleren op het andere.

### R03 — 10 oktober 2026

**Uitgevoerd:** R03.1–R03.4 in code; 445 servertests (1 bewust overgeslagen), 221 clienttests, lint/typecheck/build groen. Schemaversie 14, scanversie 3.

**De kern: wat uit de bestanden komt en wat niet.** R03.2 leest alleen wat er al in de tags staat — MusicBrainz-id's, label, catalogusnummer, datum, ISRC, BPM, werk en deel, alle genres. Een met Picard getagde map is daarmee geïdentificeerd zonder één netwerkverzoek, en dat is de goedkoopste en betrouwbaarste bron die er is. Wat niet getagd is, blijft leeg tot de job van R03.3 ernaar kijkt; "niet geïdentificeerd" is een bruikbaar antwoord.

**De job weigert te gokken.** Zoeken gebeurt op artiest, titel én aantal tracks (dat laatste in de query, anders matcht één album met een boxset), en koppelen alleen bij precies één kandidaat die op alle drie klopt met score ≥ 90. Meerdere persingen van hetzelfde album blijven één antwoord omdat ze dezelfde release group delen; twee verschillende releases zijn een echte keuze en gaan naar Settings → Library, met per kandidaat label, catalogusnummer, datum en aantal tracks zodat de keuze op bewijs rust. Een verkeerde MBID zou het label, de datum en de credits van een ánder album op het jouwe zetten, en R04, R07 en de ListenBrainz-matching bouwen daarop verder — vandaar de strengheid.

**Twee afwijkingen van de sprinttekst, bewust:**

1. **Niet gesplitst op "&" en "and".** De tekst vraagt dat, maar "Simon & Garfunkel", "Earth, Wind & Fire" en "Nick Cave and the Bad Seeds" zijn elk één act. Splitsen levert een bibliotheek vol halve artiesten, en die fout werkt door in elke pagina en elke match die erop volgt. Wel gesplitst op "feat.", "ft.", "featuring", "with", ";" en "/". Als jouw collectie gevallen heeft waar "&" echt twee acts scheidt, maak ik daar een regel voor.
2. **Scanversie pas verhoogd in R03.2**, niet in R03.1: een bump zonder dat de scanner iets nieuws leest, forceert een volledige herscan die dezelfde data terugschrijft.

**Eén deur naar MusicBrainz.** De limiet van één verzoek per seconde staat nu op één plek. De hoesjob had zijn eigen teller, dus twee jobs zouden samen het dubbele doen terwijl beide dachten netjes te zijn. Die job hergebruikt nu ook de gevonden MBID: kent een album zijn release, dan gaat hij direct naar de Cover Art Archive.

**Wacht op acceptatie (NAS):** de identificatiejob op de echte bibliotheek draaien en het meetpunt van §7 bepalen (streefwaarde 80 % van de albums met eenduidige MBID); de duur van een geforceerde herscan op 11 000 tracks noteren (scanversie 3 leest alles één keer opnieuw); controleren dat favorieten, playlists en geschiedenis die herscan ongeschonden doorkomen (V06-garantie); een gastartiest opzoeken en zien dat "verschijnt op" klopt; een twijfelgeval in Settings beslissen en controleren dat de hoes daarna via de gevonden MBID binnenkomt.

**Beslismoment na R04** blijft staan: levert de job genoeg eenduidige MBID's op? Zo nee, eerst de matchregels bijstellen voordat R07 en R08 erop leunen.

### R04 — 10 oktober 2026

**Uitgevoerd:** R04.1–R04.4 in code; 471 servertests (1 bewust overgeslagen), 234 clienttests, lint/typecheck/build groen. Schemaversie 15.

**Biografie: de herkomst bepaalt de betrouwbaarheid.** De route is bij elke stap identiteit: MBID → MusicBrainz-url-relatie → Wikidata → Wikipedia, Nederlands vóór Engels. Last.fm alleen als terugval, en ook dan op MBID als die er is — op naam vind je bij een veelvoorkomende bandnaam zo een naamgenoot. Bron, link en licentie (CC BY-SA) staan altijd bij de tekst. De cache maakt het tweede bezoek gratis; een misser wordt korter onthouden zodat een later verschenen artikel wordt gevonden, en een mislukte verversing houdt de oude tekst.

**Artiestpagina op de relaties van R03.** Een gast op één track heeft nu een pagina met "Verschijnt op" en de rol die ze daar hebben. "Singles & EP's" is een vuistregel (≤ 6 tracks, < 30 minuten) en de pagina zegt dat; het release-group-type van MusicBrainz zou het echte antwoord zijn maar wordt nog niet opgeslagen. "Start radio" staat er uitgeschakeld tot R08.

**Albumpagina: Versies zonder overdrijving.** Lokale edities op release group of op artiest + titel met een andere editie; Qobuz-versies op artiest + titel in vergelijkingsvorm, met hun beste kwaliteit (de provider gaf die eerst niet door). Een niet-verbonden of trage Qobuz staat er als zodanig — nooit "geen andere versies" op basis van stilte. Klassiek gegroepeerd per werk.

**Componisten per werk.** Opnames staan onder het werk; tracks zonder werktag onder "Overige stukken", niet weggelaten.

**Acceptatie in code:** biografie uit de cache bij tweede bezoek (test: nul verzoeken), FLAC en MP3 van één album beide onder Versies (test), een Qobuz-versie in hogere resolutie start vanaf de lokale albumpagina (test).

**Wacht op acceptatie (NAS):** de eerste biografie binnen twee seconden op de echte verbinding meten (MusicBrainz-rij, Wikidata en Wikipedia achter elkaar); een album dat als FLAC én MP3 bestaat openen en beide onder Versies zien; met Qobuz verbonden een album openen dat daar in 24-bit staat en het vanaf de lokale pagina starten; **visuele controle op telefoon** van artiest-, album- en componistenpagina — die heb ik niet in een browser kunnen doen, omdat de pagina's achter de login zitten (dezelfde grens als bij R02).

**Beslismoment na R04 (§7):** levert de identificatiejob van R03 op de echte bibliotheek genoeg eenduidige MBID's op (streefwaarde 80 %)? Daar hangen de biografieën, de versies op release group en R07/R08 van af.
