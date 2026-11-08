# AudioServer — analyse en verbeterplan

Datum: 8 november 2026. Beoordeelde basis: commit `74c4251` plus de bestaande werkmap.

**Dit document bevat uitsluitend onderzoek en voorgenomen werk. Er zijn geen fixes uitgevoerd en geen appcode, configuratie, dependencies of bestaande documentatie gewijzigd.**

## 1. Beoordeling

De app heeft een bruikbare architectuur: gedeelde domeintypen, provider- en apparaatinterfaces, een servergestuurde wachtrij per kamer, server-side sessies en veel gerichte tests. De interface heeft al een consistente navigatie, mobiele tabs, albumacties en afzonderlijke instellingenpagina's. Een volledige herbouw is niet nodig.

De belangrijkste risico's zitten in gegevensbehoud bij bibliotheekherstel, de afstemming tussen apparaat en wachtrij, sessieherstel en de betrouwbaarheid van webapp-updates. De volledige speler heeft daarnaast aantoonbare problemen op kleine schermen en bij toetsenbordbediening. Eerst deze basis betrouwbaar maken; daarna de interface verfijnen en prestaties verbeteren.

## 2. Onderzoeksopzet en beperkingen

- Codeonderzoek van `shared`, backendroutes, authenticatie, scanner, providers, apparaten, afspeeldiensten, React-state, componenten, service worker en Docker/CI.
- Bestaande backend- en frontendtests uitgevoerd; lint en afzonderlijke controles zonder TypeScript-uitvoer uitgevoerd.
- Gerichte reproducties uitsluitend met geheugenopslag, synthetische gegevens of gemockte netwerkantwoorden. Geen echte provideraccount gebruikt en geen opdrachten naar luidsprekers gestuurd.
- De bestaande frontend visueel bekeken via een tijdelijke API met fictieve bibliotheekgegevens: Home, Albums, Settings en volledige speler. De tijdelijke omgeving en browsertab zijn na afloop gestopt/gesloten.
- Visuele controle bij desktopformaat 1440×900 en telefoonformaten 390×844, 320×568 en 667×375. De waargenomen weergave gebruikte het lichte thema. Donker thema, 200% zoom, schermlezers en echte touchapparaten zijn nog niet integraal getest.
- De fictieve API is geen backendintegratietest. Aantallen, afspeeltijden, apparaatstatus en ontbrekende afbeeldingen uit deze fixture gelden niet als productiefout. Het afsnijden van de interface en de focuspositie zijn wel aan de echte componenten vastgesteld.

Bewijsniveaus in dit plan:

- **Gereproduceerd:** het gedrag is met de echte functie/bibliotheek in een geïsoleerde proef of met de echte interface vastgesteld.
- **Codebevestigd:** het foutieve codepad is aanwijsbaar; een volledige praktijktest met echte apparaten/accounts moet nog volgen.
- **Nader toetsen:** onderbouwd risico of verbetervoorstel; geen vastgestelde productiefout.

### Uitgevoerde controles

| Controle                                        | Resultaat                                                                         | Betekenis                                                                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint`                                  | Geslaagd, exitcode 0                                                              | Geen ESLint-fouten gevonden.                                                                                                                 |
| Frontendtests, eerste run                       | Twee falende tests: `ZonesSection` en `focus-panel`; ook worker-timeoutmeldingen  | De run draaide tegelijk met de uitgebreide backendtests. Geen stabiel gereproduceerde functionele regressie uit afleiden.                    |
| `npm test --workspace=client -- --maxWorkers=2` | **313 tests geslaagd, 61 testbestanden, exitcode 0**                              | Herhaling met minder gelijktijdige processen is groen. Eerste-runinstabiliteit wel onderzoeken.                                              |
| `npm test --workspace=server`                   | 16 bestanden geslaagd, 69 gefaald; 119 tests geslaagd, 10 gefaald, 1 overgeslagen | Veel suites komen niet aan hun tests toe door ontbrekende geïnstalleerde dependencies. Dit zijn geen 69 bewezen appbugs.                     |
| Client TypeScript, zonder uitvoer               | Geslaagd                                                                          | `tsc -p client/tsconfig.json --noEmit --incremental false`.                                                                                  |
| Server TypeScript, zonder uitvoer               | Niet geslaagd                                                                     | Ontbrekende modules/types en verouderde gegenereerde shared-declaraties beïnvloeden de uitkomst. Nog geen betrouwbare schone-buildconclusie. |
| Volledige productie-/Dockerbuild                | Niet uitgevoerd                                                                   | Eerst reproduceerbaar vanuit een schone installatie uitvoeren; bestaande buildbestanden zijn niet herschreven.                               |

Lokale omgeving: Windows, Node `v24.22.1`, npm `11.19.1`.

De geïnstalleerde dependencies lopen achter op de manifests: onder meer `multicast-dns` en de MCP-SDK zijn niet bruikbaar aanwezig. `multicast-dns` staat wél in `server/package.json` en `package-lock.json`; dit is een lokaal installatieprobleem, geen ontbrekende dependencydeclaratie. De servercontrole leest bovendien `shared/dist` waarin albumvelden ontbreken die al in `shared/src/types.ts` bestaan. Eerst een schone installatie en gedeelde build valideren voordat resterende typefouten als broncodebugs worden aangemerkt.

De zeven metadatafouten in de Windows-scannertests hebben een afzonderlijke verklaring: de scanner bewaart een pad met `/` vóór de bestandsnaam, maar de tests zoeken met Windows-`join()` en dus `\`. De exacte SQL-vergelijking vindt daardoor de reeds ingevoegde track niet. Ook de covercachetest verwacht letterlijk `/data/covers`, waar Windows `\data\covers` teruggeeft. De importordertest meldt daarnaast `EPERM` bij opruimen van een tijdelijke map. Deze platform-/testproblemen eerst corrigeren en vervolgens de werkelijke functionaliteit opnieuw beoordelen.

## 3. Prioriteiten

P1 = als eerste oplossen vanwege gegevensverlies, verkeerde weergave of ongewenste accountkoppeling. P2 = functionele betrouwbaarheid en toegankelijkheid. P3 = verdere gebruikskwaliteit, prestaties en onderhoud. Er is geen bewezen P0 aangetroffen; dit onderzoek is geen volledige penetratietest.

| ID  | Prioriteit | Onderwerp                                                           | Bewijs                                  |
| --- | ---------- | ------------------------------------------------------------------- | --------------------------------------- |
| B01 | P1         | Favorieten van andere gebruikers verdwijnen bij bibliotheekherstel  | Gereproduceerd                          |
| B02 | P1         | Terugspoelen kan wachtrij naar volgend nummer laten springen        | Codebevestigd                           |
| B03 | P1         | Voorbereid volgend nummer veroudert na wachtrijwijziging/slaaptimer | Codebevestigd                           |
| B04 | P1         | OAuthcallback is niet aan de gestarte koppelactie gebonden          | Codebevestigd                           |
| B05 | P2         | Tijdelijke serverstoring wist geldige login                         | Codebevestigd                           |
| B06 | P2         | Socket herverbindt na tokenvernieuwing met oud token                | Codebevestigd                           |
| B07 | P2         | Ontwikkelomgeving mist realtime-proxy                               | Codebevestigd                           |
| B08 | P2         | Webapp-update kan onvolledige of vermengde cache opleveren          | Deels gereproduceerd                    |
| B09 | P2         | Vastlopende provider houdt afspelen onbeperkt in laden              | Codebevestigd                           |
| B10 | P2         | Featured Radio 538/Veronica gebruiken verkeerde referenties         | Gereproduceerd met gemockte fetch       |
| B11 | P2         | Playlistimport kan verkeerde opname kiezen; Unicode-export faalt    | Deels gereproduceerd                    |
| B12 | P2         | Lange wachtwoorden worden stilzwijgend afgekapt                     | Gereproduceerd                          |
| B13 | P2         | Scanner beschadigt slashnamen en houdt oude albumgenres vast        | Codebevestigd                           |
| B14 | P2         | Equivalent geschreven Windows-paden kunnen dubbele tracks geven     | Codebevestigd risico; vervolgtest nodig |
| B15 | P2         | Genrenaam met `%` veroorzaakt foutscherm                            | Gereproduceerd met router               |
| U01 | P2         | Volledige speler snijdt inhoud af op kleine schermen                | Visueel gereproduceerd                  |
| U02 | P2         | Toetsenbordfocus en spatiesneltoets verstoren bediening             | Deels visueel/codebevestigd             |
| U03 | P2         | Foutmeldingen liggen achter volledige speler                        | Codebevestigd                           |

## 4. Bugs en voorgestelde reparaties

### B01 — Behoud favorieten per gebruiker bij opnieuw koppelen

**Bewijs:** `server/src/services/scanner.ts:721–730` zoekt een bestaande favoriet op doeltrack zonder `user_id`. Zodra iemand de doeltrack favoriet heeft, verwijdert de code alle favorieten van de ontbrekende track. Dezelfde ongescopeerde samenvoeglogica staat bij albumherstel op `scanner.ts:533–542`.

**Reproductie:** gebruiker A heeft de ontbrekende track favoriet; gebruiker B heeft de doeltrack favoriet. Na `relinkMissingTrack()` blijft alleen de favoriet van B over. Dit is uitgevoerd met de echte scannerfunctie en SQLite in geheugen.

**Plan:** verplaats favorieten per eigenaar. Voeg alleen dubbele favorieten van dezelfde eigenaar samen. Inventariseer tegelijkertijd alle relaties van tracks/albums, waaronder ratings en tags; die worden door de huidige relink niet volledig meegenomen. Gegevens die al verwijderd zijn niet proberen terug te raden; herstel daarvoor vereist een bruikbare backup.

**Acceptatie:** twee gebruikers behouden hun eigen favorieten bij track- én albumsamenvoeging, inclusief de situatie waarin beiden beide versies favoriet hebben. Playlists, tags, ratings en luisterhistorie blijven volgens een vastgelegd samenvoegbeleid behouden. Voer een reparatie eerst op een kopie van de database uit.

### B02 — Onderscheid seek van echte apparaat-trackwisseling

**Bewijs:** `server/src/services/device-monitor.ts:297–302` beschouwt een terugval van meer dan 30 naar maximaal 5 seconden als een volgende track. `server/src/services/server-player.ts:386–391` controleert alleen of een volgende track voorbereid is.

**Scenario:** A speelt, B is voorbereid voor gapless-overgang. De luisteraar zoekt van 60 naar 1 seconde binnen A. De server kan vervolgens B als huidig nummer registreren, terwijl de luidspreker A blijft spelen. De afhandeling van een reeds voorbereid item op `server-player.ts:497–520` verstuurt B dan ook niet opnieuw. Een bestaande seektest wist de voorbereiding eerst en dekt deze situatie niet af.

**Plan:** bepaal de overgang aan de hand van track-/URI-identiteit en transportinformatie; herken eigen seeks. Een positieterugval alleen is onvoldoende bewijs.

**Acceptatie:** seek naar 0–5 seconden mét voorbereid volgend nummer laat hetzelfde item geselecteerd. Een echte automatische apparaatwissel verhoogt de wachtrij precies één keer. Ook herhaalde tracks, repeat-one en onvolledige apparaatstatus testen.

### B03 — Houd de voorbereide volgende URI actueel en laat timers echt stoppen

**Bewijs:** `server-player.ts:294–310` bereidt een volgende track voor na dispatch/advance. Wachtrijmutaties op `server/src/services/playback.ts:916–988`, shuffle/repeat op `:718–735` en het instellen van de slaaptimer op `server/src/routes/playback.ts:744–769` actualiseren deze voorbereiding niet. `server-player.ts:535–540` geeft bij idle het apparaat vrij zonder het daadwerkelijk te stoppen.

**Scenario:** A speelt, B is voorbereid. Verwijder B, zet C als volgende of stel daarna “stop na dit nummer” in. De renderer bezit nog steeds de URI van B en kan die zelfstandig starten. Bij timerafloop kan de serversessie al gestopt zijn terwijl het apparaat doorgaat.

**Plan:** koppel de voorbereiding aan stabiele itemidentiteit en wachtrijversie. Herbereken of wis de apparaatvoorbereiding bij relevante mutaties, moduswijzigingen en timers. Controleer ook na een asynchrone resolutie opnieuw of de voorbereiding nog geldig is. Laat “stop na nummer” zo nodig een echte stopopdracht naar de renderer sturen.

**Acceptatie:** delete, clear, reorder, play-next, shuffle/repeat en timerwijzigingen ná voorbereiding spelen nooit een verwijderd of ongewenst item. Op echte DLNA/Sonos-uitvoer stopt de timer hoorbaar op de bedoelde grens.

### B04 — Bind OAuth aan één sessie en één koppelactie

**Bewijs:** `server/src/providers/spotify.ts:271` genereert geen `state`; `client/src/pages/OAuthCallbackPage.tsx:13` en `server/src/routes/providers.ts:21` verwerken de callback zonder binding aan een eerdere aanvraag. Tidal bewaart één globale PKCE-verifier op `server/src/providers/tidal.ts:215`, `:248` en `:271`.

**Gevolg:** een geldig verkregen callbackcode wordt niet gecontroleerd tegen de koppelactie van deze admin. Een toegestuurde callbacklink kan daardoor een ongewenste globale providerkoppeling veroorzaken. Gelijktijdige Tidal-koppelacties kunnen elkaars verifier overschrijven. Geen live aanval met een provideraccount uitgevoerd.

**Plan:** server-side OAuthtransacties per sessie/provider, met willekeurige state, gebonden redirectUri, vervaltijd, eenmalig verbruik en bijbehorende verifier. Controleer de transactie vóór tokenuitwisseling.

**Acceptatie:** ontbrekende, verkeerde, verlopen of hergebruikte state faalt; twee gelijktijdige koppelacties blijven gescheiden. De app toont duidelijk welk externe account voor de installatie is gekoppeld.

### B05 en B06 — Maak sessieherstel bestand tegen storing en vernieuwing

**Bewijs B05:** `client/src/context/AuthContext.tsx:78–103` laat elke fout van `/auth/me` uitkomen op het wissen van de lokale sessie, dus ook offline, 502 of 503.

**Plan B05:** onderscheid ongeldigverklaarde sessies van een tijdelijk onbereikbare server. Bewaar het token bij een storing en toon een herstelstatus met opnieuw proberen. Beschermde data blijft uiteraard server-side geautoriseerd.

**Bewijs B06:** `AuthContext.tsx:55–59` vernieuwt alleen localStorage. `client/src/hooks/useSocket.ts:126–155` legt het token eenmalig vast voor de handshake en meldt sessieverlies bij een authenticatiefout. Na het verlopen van het oorspronkelijke token kan een reconnect daardoor de geldige vernieuwde sessie lokaal wissen.

**Plan B06:** laat elke handshake het actuele token gebruiken en stem refresh/reconnect op elkaar af.

**Acceptatie:** offline of tijdens backendherstart herladen verwijdert de login niet. Na herstel synchroniseert de app automatisch. Een ingetrokken sessie logt wél uit. Met een versprongen testklok werken tokenvernieuwing en reconnect voorbij de oorspronkelijke vervaldatum.

### B07 — Herstel realtimegedrag in de gedocumenteerde ontwikkelstart

**Bewijs:** `client/vite.config.ts:40–46` proxyt alleen `/api`. `useSocket.ts:130` gebruikt `io()` zonder backendadres. De Socket.IO-client richt zich daarmee op `:5173/socket.io`, terwijl de server op `:3001` luistert (`server/src/index.ts:59`). Een geïsoleerde clientcontrole bevestigt die bestemming.

**Plan:** voeg een ontwikkelproxy voor `/socket.io` toe met ondersteuning voor WebSocket-upgrades. Productie blijft hetzelfde oorsprongsadres gebruiken.

**Acceptatie:** de normale `npm run dev` geeft een succesvolle handshake; een wachtrijmutatie in tab A en scanvoortgang verschijnen in tab B zonder herladen. Controleer zowel polling als WebSocket-transport.

### B08 — Maak de installatie van een nieuwe webapp-versie atomair

**Bewijs 1:** `client/sw/sw.template.js:29` gebruikt `Promise.allSettled()` voor noodzakelijke shellbestanden. Bij een mislukte JS-download slaagt de installatie toch; activation wist oude caches. Een geheugenproef met de echte workerlogica bevestigt: index aanwezig, noodzakelijke JS afwezig, oude cache verwijderd.

**Bewijs 2:** standaard `VCS_REF=local` in `docker-compose.yml:7` wordt via `Dockerfile:40–41` als `VITE_BUILD_ID` overgenomen. `client/vite.config.ts:16` accepteert deze waarde. Opeenvolgende standaardbuilds delen dan `audioserver-shell-local` (`sw.template.js:19`). Een installer schrijft zo al in de actieve cache vóór de gebruiker de update accepteert.

**Plan:** gebruik een unieke release-/inhoudsidentiteit. Cache verplichte bestanden als één succesvolle installatie; bij een fout de oude werkende versie behouden. Scheid eventuele optionele bestanden van de minimale werkende shell en controleer ook resterende tabbladen tijdens activatie.

**Acceptatie:** twee verschillende composebuilds krijgen verschillende cache-identiteiten. Afgebroken JS/CSS-downloads activeren geen kapotte release. De oude app blijft werken tot een complete update klaarstaat en geaccepteerd wordt; online én offline herladen en meerdere tabs testen.

### B09 — Begrens providerresolutie, niet alleen de apparaatopdracht

**Bewijs:** `server-player.ts:246` wacht op `resolve()` vóór de timeout rond `play()` op `:248–251`. Qobuz-fetch op `server/src/providers/qobuz.ts:432–434` en radiofetch op `server/src/providers/radio.ts:312` hebben geen bijbehorende annulering.

**Plan:** één begrensde afspeelpoging voor resolve plus dispatch, met daadwerkelijke annulering waar mogelijk. Verwerp late antwoorden van een oude poging; onderscheid opnieuw proberen, overslaan en stoppen in UI en logging.

**Acceptatie:** een providerpromise die nooit afrondt houdt de speler niet onbeperkt op laden. Het gekozen skip/stopbeleid treedt binnen een vastgelegde tijd in werking en een oud antwoord kan later geen verkeerd nummer starten.

### B10 — Gebruik één stationsidentiteit voor Featured-radio

**Bewijs:** `server/src/providers/radio.ts:107` en `:159` combineren `radio:538`/`radio:veronica` met uuid's `radio-538`/`radio-veronica`. De speler haalt de uuid uit het id (`client/src/hooks/useTrackPlayback.ts:391`, `server/src/services/playback-resolver.ts:309`), maar de curated lookup op `radio.ts:402` vergelijkt de andere waarde.

**Reproductie:** gemockte resolutie probeert `byuuid/538` en `byuuid/veronica` en vindt geen station.

**Plan:** canonieke ids gebruiken en reeds opgeslagen oude ids blijven herkennen.

**Acceptatie:** iedere Featured-zender resolveert vanuit zijn eigen publieke id zonder onbedoelde directorylookup; eerder opgeslagen stations blijven afspeelbaar.

### B11 — Voorkom verkeerde playlistmatches en maak export Unicodeveilig

**Importbewijs:** `server/src/routes/playlists.ts:311–312` kiest bij ontbrekende exacte padmatch de eerste `filePath.endsWith(filename)`. `song.flac` kan zo ook `other-song.flac` kiezen. Bij meerdere albums met `01.flac` is de keuze evenmin betrouwbaar. De hele tracktabel wordt per niet-exacte regel opnieuw gelezen.

**Exportbewijs:** `playlists.ts:281` zet de ruwe playlistnaam in `Content-Disposition`. Node-headercontrole is uitgevoerd: namen als `Muziek 🎵`, `日本語` en een naam met newline geven `ERR_INVALID_CHAR`. Quotes kunnen de parameter beschadigen.

**Plan:** match exacte genormaliseerde basenames en gebruik aanvullende identiteit; rapporteer ambiguïteit in plaats van stil te kiezen. Maak één lookup/index voor de import en schrijf transactioneel. Genereer een veilige ASCII-exportnaam plus correct gecodeerde Unicodebestandsnaam; verwijder CR/LF uit M3U-metadata.

**Acceptatie:** suffixbotsing en dubbele basename leveren geen verkeerde opname op. Een samenvatting toont gevonden, ontbrekende en ambigue regels. Unicode, quotes en CR/LF veroorzaken geen 500 bij export. Meet een grote import en test Windows-/UNC-paden.

### B12 — Maak de echte wachtwoordlengtegrens expliciet

**Bewijs:** `server/src/routes/auth.ts:27` accepteert 256 tekens; `server/src/middleware/auth.ts:197–202` gebruikt direct bcrypt. Uitgevoerd: twee wachtwoorden met dezelfde eerste 72 bytes en verschillende achtervoegsels worden als hetzelfde wachtwoord geaccepteerd. Multibyteletters bereiken die grens eerder.

**Plan:** valideer de UTF-8-bytegrens bij het instellen/wijzigen en toon een duidelijke fout, of kies een zorgvuldig gemigreerde hashmethode die de volledige invoer ondersteunt. Beperk bestaande logininvoer niet zonder migratiebeleid, omdat bestaande gebruikers dan buitengesloten kunnen raken.

**Acceptatie:** tests met 71, 72 en 73 bytes en Unicode; geen stilzwijgende afkapping bij nieuwe wachtwoorden. Bestaande accounts behouden een expliciet geteste herstel-/migratieroute.

### B13 — Bewaar namen en leid albumgenres opnieuw af

**Namen:** `scanner.ts:1189–1194` splitst ook afzonderlijke artiestnamen op `/`. Via `:955–958` verandert een artiestarray met `AC/DC` zo in twee artiesten en de weergavenaam `AC, DC`. Credits gebruiken dezelfde normalisatie.

**Genres:** `scanner.ts:1339–1353` wist oude trackgenres, maar voegt albumgenres alleen toe. Na het corrigeren van alle tracks van Rock naar Jazz kan Rock in albumfilters blijven staan; Focus gebruikt die relaties (`server/src/services/focus.ts:224`, `:340`, `:702`).

**Plan:** respecteer echte multi-value-metadata en gebruik geen algemene slashsplit. Bereken albumgenres uit de actuele tracks, ook bij verwijderde genres en albumverplaatsingen. Beschrijf een gerichte herstelscan voor bestaande gegevens.

**Acceptatie:** AC/DC blijft één artiest; echte meerdere artiesten behouden hun afzonderlijke credits. Genrevervanging én verwijderen maken de filters actueel zonder een nieuwe bibliotheek op te bouwen.

### B14 — Eén beleid voor equivalente bestandspaden

**Bewijs:** `normalizeScanPath()` op `scanner.ts:384–390` wordt gebruikt voor missing-detectie (`:571–580`), maar niet consequent voor identiteit/opslag (`:410`, `:424`, `:1112`). `findMoveCandidate()` op `:847–859` accepteert een oude equivalente locatie die nog bestaat niet als verplaatsing.

**Risico:** wijzigen van `C:\Music` naar `C:/Music` kan een nieuwe trackrij geven terwijl de oude genormaliseerde locatie ook beschikbaar blijft. Dit volledige scenario is nog niet met echte bestanden gereproduceerd. De falende Windows-tests uit paragraaf 2 bewijzen alleen hun eigen vergelijkingsprobleem.

**Plan:** leg een canoniek padbeleid vast voor opslag, vergelijking, scans en tests. Behoud UNC-prefixen en de bestaande keuze voor forward slashes. Onderzoek bestaande doublures vóór eventuele samenvoeging; geen blinde massaconversie van paden.

**Acceptatie:** equivalent gespelde lokale Windows-roots en geldige UNC-roots behouden dezelfde trackidentiteit en persoonlijke relaties na opnieuw scannen. Linuxpaden en caseverschillen op casegevoelige opslag blijven correct.

### B15 — Decodeer genreparameters één keer

**Bewijs:** `client/src/pages/GenresPage.tsx:45` decodeert een reeds door React Router gedecodeerde parameter opnieuw. Runtimeproef: `/genres/100%25` geeft parameter `100%`; de extra `decodeURIComponent()` gooit `URI malformed`. Een letterlijke naam `R%26B` verandert bovendien ongewenst in `R&B`.

**Plan:** gebruik de routerparameter rechtstreeks en encodeer alleen bij het maken van de link.

**Acceptatie:** genres met `%`, een letterlijke `%20`, Unicode en een slash openen correct zonder ErrorBoundary.

## 5. Interface en toegankelijkheid

### U01 — Volledige speler laten passen bij breedte én hoogte

**Visueel vastgesteld:** op 320×568 wordt de Lyrics-actie rechts afgesneden en verdwijnt een deel van de artiest-/albuminformatie. Op 667×375 valt de nummerinformatie uit de zichtbare hoofdinhoud. Op 390×844 is de verdeling bruikbaarder, maar de actierij blijft compact.

**Oorzaak:** de niet-wrappende header op `client/src/components/NowPlayingFull.tsx:87–110`, vaste hoesformaten en `overflow-hidden` op `:114–116` houden onvoldoende rekening met lage schermen.

**Plan:** schaal hoes en witruimte op beschikbare hoogte, groepeer secundaire acties in een menu en geef noodzakelijke inhoud een scrollmogelijkheid. Houd titel, artiest, play/pauze en uitvoerkeuze altijd bereikbaar. Geef ontbrekende hoesafbeeldingen dezelfde duidelijke fallback als in de bibliotheek; de volledige speler verbergt een mislukte afbeelding nu alleen.

**Acceptatie:** de genoemde formaten, 200% zoom, lange titels en open Lyrics-/uitvoermenu's zijn bruikbaar zonder afgesneden acties. Verifieer daarna op echte telefoon en tablet.

### U02 — Herstel focus, native knoppen en semantiek

**Volledige speler:** `NowPlayingFull.tsx:72` is een gewone overlay zonder dialogsemantiek, focusverplaatsing, focusbegrenzing of focusherstel. Visueel/DOM bevestigd: na openen blijft de focus op de onderliggende knop “Open fullscreen player”; er is geen dialoogrol.

**Sneltoetsen:** `client/src/hooks/useKeyboardShortcuts.ts:17–33` sluit invoervelden uit, maar geen algemene knoppen. Spatie wordt onderschept voor afspelen/pauzeren en kan daardoor native activatie van bijvoorbeeld een Settings-tab of de fullscreenknop verhinderen. Sommige componenten beschermen zichzelf al; de centrale regel blijft onvoldoende.

**Overige plekken:** `DeviceSelector.tsx:145–158` heeft een eigen dropdown zonder volledig focus-/Escape-beheer; Settings-tabs missen pijltjestoetsbediening en roving tabindex. De zoekcombobox mist de koppeling met de actieve suggestie (`SearchBar.tsx:158–166`). Volume en crossfade in de volledige speler missen een toegankelijke naam (`NowPlayingFull.tsx:303–331`).

**Plan:** hergebruik een toegankelijke modal-/menubasis; maak de achtergrond tijdelijk inert en herstel focus bij sluiten. Respecteer interactieve doelen, modifiers, `defaultPrevented` en toetsherhaling in de sneltoetslaag. Maak formulieren, tabs en actieve zoeksuggesties semantisch compleet.

**Acceptatie:** alleen met Tab/Shift+Tab, Spatie, Enter, pijltjes en Escape zijn zoeken, afspelen, kamerkeuze en instellingen te bedienen. Geen bediening achter een geopende overlay. Namen/waarden zijn met een schermlezer begrijpelijk.

### U03 — Maak fouten zichtbaar en onderscheid storing van lege bibliotheek

**Bewijs:** `client/src/components/Toast.tsx:48` gebruikt `z-50`, terwijl de volledige speler `z-[100]` gebruikt. Meldingen kunnen daardoor drie seconden onzichtbaar achter de speler liggen en verlopen (`Toast.tsx:25–28`). De meldingen hebben ook geen live-regionsemantiek.

**Aanvullend:** `client/src/hooks/useInfiniteLoad.ts:103–108` slikt fetchfouten in; meerdere pagina's tonen dan een lege toestand of behouden zonder uitleg hun oude resultaten. Een kortdurende toast alleen is onvoldoende voor een eerste laadfout.

**Plan:** één laagvolgorde voor overlays en meldingen, zichtbare en aangekondigde fouten, paginafout met opnieuw proberen, en behoud van bestaande resultaten tijdens tijdelijke storingen. Maak onderscheid tussen geen muziek, geen filtermatches en server/bron onbereikbaar. Laat offline-/herstelstatus aansluiten op B05.

**Acceptatie:** fouten tijdens volledige-spelerbediening blijven leesbaar en worden aangekondigd. Een 503 toont geen misleidende “geen albums”-toestand. Herstellen kan zonder de hele app opnieuw te laden.

### U04 — Verfijn leesbaarheid, acties en muzieknavigatie

Dit zijn verbeterkansen; geen gemeten toegankelijkheidscertificering of volledige gebruikerstest.

- **Leesbaarheid in licht thema:** de bibliotheek gebruikt donkere kleurovergangen voor ontbrekende hoezen, maar de tekst erover erft themakleuren. In de visuele controle was die tekst moeilijk leesbaar. Geef tekst op zulke hoezen een eigen contrastrijke kleur en meet daarna contrast in alle thema's (`AlbumCover.tsx:54–65`, `client/src/index.css`). Controleer ook de zeer kleine secundaire labels.
- **Home met muziek voorop:** “Getting started” neemt op telefoon veel verticale ruimte in, ook bij een gevulde bibliotheek. Toon een compacte voortgangssamenvatting wanneer niets aandacht nodig heeft en maak de bestaande verbergoptie duidelijk. Bewaar uitgebreide hulp voor de lege/eerste installatie.
- **Directe vervolgstappen:** laat onboardinglinks naar het relevante instellingstab gaan, bijvoorbeeld `?tab=library` en `?tab=providers`, in plaats van alleen `/settings` (`GettingStarted.tsx:115` en de bronnenstap).
- **Acties naar rol:** `AlbumsPage.tsx:79–110` toont Scan Library zonder adminfilter. Een gewone gebruiker krijgt daardoor een actie die de backend niet toestaat. Toon alleen toegestane acties en geef bij scannen voortgang en duidelijke afronding.
- **Hoesweergave:** gebruik één bron-/fallbackketen voor bibliotheek, minispeler en volledige speler. Controleer externe Qobuz-/Spotifyhoezen; `TrackInfo` mist een expliciet `coverUrl`, terwijl de queue die metadata al bewaart.
- **Kamer/uitvoer:** behoud de werkelijke gekozen naam wanneer een apparaat tijdelijk verdwijnt. De fallback “Browser” in `DeviceSelector.tsx:130–134` kan anders een verkeerde indruk geven. Toon status en herstelactie bij de gekozen kamer.
- **Focus/filtertaal:** behoud de krachtige Focus-functie, maar verduidelijk de knop met bijvoorbeeld “Filters en sortering”, actieve filterchips en een vindbare reset. Toets dit met een nieuwe gebruiker voordat de bestaande terminologie wordt vervangen.
- **Taal en aanraakbediening:** bepaal of Nederlands/Engels instelbaar moet worden. Gebruik consistente iconen en labels; meet kleine aanraakdoelen en plaats minder gebruikte speleracties onder Meer. Toets de indeling op een echte telefoon.

## 6. Aanvullende betrouwbaarheid en prestaties

| Onderwerp               | Onderbouwing                                                                                                                                                                | Voorgenomen verbetering en controle                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bibliotheekwatcher      | `server/src/services/watcher.ts:28–31` filtert op audio-extensies; mapwijzigingen en `cover.jpg` vallen erbuiten. `scanner.ts:143` slaat een aanvraag tijdens scannen over. | Coalesce/debounce plus een pending-vervolgscan. Test mapverplaatsing, coverwijziging en events tijdens scannen.                                      |
| Verdwenen apparaat      | Transportmethodes in `server/src/devices/manager.ts:104–106`, `:136–138` retourneren stil als discovery het apparaat niet kent.                                             | Expliciete fout/status en gerichte rediscovery; succes pas melden na een uitgevoerde opdracht. Test verdwijnen tussen selectie en play/pause.        |
| Late apparaatantwoorden | `device-monitor.ts:217–237` beëindigt bij timeout het wachten, niet de oorspronkelijke aanvraag.                                                                            | Annulering waar mogelijk plus aanvraaggeneratie; late antwoorden mogen nieuwere status niet overschrijven.                                           |
| Radio-cache             | `providers/radio.ts:295–312` heeft TTL maar geen omvangslimiet; unieke verlopen keys blijven staan.                                                                         | Begrensde cache en verlopen items opruimen. Test veel unieke zoekopdrachten en geheugengebruik.                                                      |
| Negatieve paginalimiet  | `server/src/routes/history.ts:255` begrenst `limit` niet naar minimaal 1; SQLite behandelt `-1` als onbeperkt.                                                              | Bestaande paginationvalidatie hergebruiken. Test negatieve, nul-, ongeldige en zeer grote waarden.                                                   |
| Streamtokencache        | `client/src/api/client.ts:245–280` kan na `clearStreamToken()` nog door een oudere aanvraag gevuld worden.                                                                  | **Nader toetsen:** vertraagde response plus accountwissel en hoesrequests. Pas bij bevestiging generatie/abort en expliciete gereedstatus toevoegen. |
| Grote bibliotheken      | Import doet herhaald volledige tabellookups; lijstpagina's renderen alle geladen kaarten/rijen.                                                                             | Eerst import verbeteren en meten met 50.000 tracks. Alleen bij aangetoonde browservertraging virtualisatie invoeren; serverpaginatie behouden.       |

## 7. Testbaarheid, bouw en documentatie

1. **Reproduceerbare uitgangspositie:** gebruik bij uitvoering een schone checkout en `npm ci`; bouw shared vóór servertypecontrole. Leg Node/npm vast. Draai de checks opnieuw voordat functionele fixes worden gecombineerd met dependencywerk.
2. **Platformtests:** corrigeer scanner-/coverpadverwachtingen zonder de UNC-afspraak te breken. Sluit databases vóór cleanup en test Windows én Linux. Onderzoek eerste-runinstabiliteit van frontendtests met realistische aantallen workers.
3. **Geïsoleerde opstarttest:** `server/src/__tests__/startup-smoke.test.ts:90–95` wist omgevingsvariabelen, maar `server/src/config.ts:9` laadt vervolgens alsnog `.env`. Providers kunnen daarmee echte credentials/hints krijgen. Maak dotenv en achtergrondintegraties expliciet uitschakelbaar voor de test en controleer dat geen extern netwerk of echte apparaten worden benaderd.
4. **Bestaande CI-verwijdering beoordelen:** `.github/workflows/ci.yml` bestaat in HEAD, maar was vóór deze analyse al lokaal verwijderd. Die wijziging is ongemoeid gelaten. Beslis vóór een commit of de bestaande workflow behouden of vervangen moet worden; claim niet dat het project nooit CI had. HEAD bevat reeds lint, typecheck, tests, builds en Docker-smoke op Node 22/24.
5. **Productiecontrole:** de Dockerbuild bouwt shared/client en voert de backend met tsx uit; de afzonderlijke servertypecontrole blijft dus noodzakelijk. Valideer daarna het image, readiness, schone shutdown, persistente database en twee opeenvolgende frontendreleases op de NASarchitectuur.
6. **Architectuurdocumentatie actualiseren:** AGENTS.md beschrijft nog stubs/mockdevices, terwijl README/code echte Qobuz-, DLNA-, Sonos- en Volumiofunctionaliteit bevatten. Beschrijf eigenaarschap van sessies, apparaten, tokens en herstelacties op één consistente plek. Bestaande modulering behouden en alleen grote verantwoordelijkheden gericht opsplitsen.

## 8. Uitvoeringsvolgorde

Dit is een voorgestelde volgorde, geen autorisatie om het werk alvast uit te voeren. Omvang S = lokaal en beperkt; M = meerdere onderdelen; L = toestand/migratie/apparaattesten. Geen kalenderplanning zonder groene uitgangspositie en beschikbare testapparaten.

| Fase                           | Werk                                                                                                 | Omvang | Voorwaarde om door te gaan                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------- |
| 0 — Betrouwbare basis          | Schone dependency-installatie, shared-build, platformtests en besluit over bestaande CI-verwijdering | M      | Lint, typen en tests reproduceerbaar groen; afwijkingen verklaard.                    |
| 1 — Gegevens en koppelingen    | B01 en B04; backup-/herstelproef op databasekopie                                                    | M      | Persoonlijke gegevens behouden; OAuthtransacties niet uitwisselbaar.                  |
| 2 — Afspeelcorrectheid         | B02, B03 en B09; verdwenen/late apparaatantwoorden meenemen                                          | L      | Queue en echte renderer blijven gelijk bij seeks, mutaties, timeouts en timers.       |
| 3 — Sessies en releases        | B05–B08 en geïsoleerde startup-smoke                                                                 | M–L    | Herstel na netwerkverlies; veilige tokenvernieuwing; twee-release-updateproef slaagt. |
| 4 — Gerichte functionele fixes | B10–B15, watcher en pagination                                                                       | M      | Regressiescenario per bevinding groen; eventuele gegevensreparatie apart getest.      |
| 5 — Interface                  | U01–U03, daarna U04                                                                                  | M      | Mobiel/landscape/zoom/toetsenbord/schermlezer gecontroleerd; fouten zichtbaar.        |
| 6 — Meten en afronden          | Bibliotheekbenchmark, eventuele lijstoptimalisatie, documentatie en NAS-smoke                        | M      | Prestaties meetbaar; productieversie en rollback verifieerbaar.                       |

Werk in kleine afzonderlijke wijzigingen. Voeg per fix een test van het echte foutscenario toe; vermijd grote herstructureringen tegelijk met gegevens- of afspeelcorrecties. Leg databasereparaties los van interfacewijzigingen vast.

## 9. Definitie van gereed bij latere uitvoering

- Geen favorieten, tags, ratings, playlists of luisterhistorie verloren bij scan/relink volgens het vastgelegde samenvoegbeleid.
- Geen verkeerde trackwisseling bij seek of wachtrijmutatie; slaaptimer stopt de echte uitvoer.
- Login overleeft een tijdelijke storing; ongeldige sessies blijven geweigerd.
- Providerkoppeling vereist een geldige eenmalige OAuthtransactie.
- Webapp-updates behouden een complete werkende versie bij netwerkverlies.
- Alle primaire speleracties passen op telefoon/landscape en zijn met toetsenbord en schermlezer bedienbaar.
- Lint, gedeelde/server/clienttypen, beide testsuites, productiebuild en geïsoleerde Docker/NAS-smoke slagen vanuit een schone uitgangspositie.

## 10. Wijzigingsgrens van dit onderzoek

Alleen dit Markdown-bestand is toegevoegd. De reeds verwijderde CI-workflow en het reeds aanwezige ongetrackte `audioserver-qobuz.tar` zijn niet gewijzigd. Er zijn geen fixes, dependency-installaties, migraties, commits of deploys uitgevoerd. Tests kunnen gebruikelijke tijdelijke bestanden en genegeerde toolcaches hebben gemaakt; de echte appdatabase is niet voor dit onderzoek gebruikt.
