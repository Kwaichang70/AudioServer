# AudioServer — analyse en verbeterplan in sprints

**Datum:** 7 september 2026  
**Onderzochte versie:** commit cd3f094, lokale werkmap AudioServer  
**Status:** analyse afgerond; V01–V03 uitgevoerd op 8 september 2026 en V04 op 9 september 2026 (zie §11), V05–V12 nog te plannen.  
**Doel:** een betrouwbare muziekserver voor de NAS, met een voorspelbare bediening op telefoon/tablet en goede ondersteuning voor lokale muziek en externe bronnen.

## 1. Advies en afbakening

AudioServer heeft al een brede functionele basis. De grootste winst zit in het betrouwbaar laten samenwerken van de bestaande onderdelen: wachtrij, afspeelapparaat, gebruikerssessie, bibliotheek en streamingbron. Nieuwe functies zijn zinvol, maar bouwen nu deels op een onvolledig gedeeld afspeelmodel en onbetrouwbare luistergegevens.

**Aanbevolen volgorde:**

1. Maak releases controleerbaar, werk kwetsbare afhankelijkheden bij en verbeter aanmelding en beheerrechten.
2. Herstel wachtrijen en laat de server lokale muziek én Qobuz zelfstandig doorspelen.
3. Bewaar luistergegevens en bibliotheekrelaties correct, ook na verplaatsen of verwijderen van bestanden.
4. Verbeter zoeken, bronkeuze en mobiele bediening.
5. Voeg daarna persoonlijke profielen, afzonderlijke kamerwachtrijen, aantoonbaar betere trackovergangen en uitgebreidere ontdekfuncties toe.

De bestaande Express/React/SQLite-opzet is hiervoor bruikbaar. Een volledige herschrijving, microservices of een andere database zijn op basis van deze analyse niet nodig. Wel moet één onderdeel verantwoordelijk worden voor de afspeelstatus en moeten gebruikers, zones en bronnen expliciete domeinbegrippen worden.

### Onderzoeksmethode

- Broncode van server, client en gedeelde interfaces bekeken, met nadruk op afspelen, scanner, opslag, authenticatie, providers, apparaten en service worker.
- Bestaande sprintdocumenten vergeleken met de daadwerkelijke implementatie.
- Tests, lint, typecontrole, productiebuild en actuele npm-controle van productieafhankelijkheden uitgevoerd.
- Aanvullende controles uitgevoerd met een tijdelijke SQLite-database **in het geheugen**, zonder de muziekbibliotheek te wijzigen.
- Primaire documentatie van vergelijkbare producten en integraties geraadpleegd; bronnen staan bij de relevante conclusies.

**Niet uitgevoerd:** een visuele gebruikstest in een draaiende browser, een Docker-imagebouw, prestatietests met een grote NAS-bibliotheek, echte audiometingen, of acceptatietests met Synology, Sonos/DLNA/Volumio en streamingaccounts. Uitspraken over deze situaties zijn codebevindingen of nog te toetsen verwachtingen. Een geslaagde unit-test bewijst geen correcte audio-uitvoer op hardware.

Dit document is de nieuwe planningsbasis. [SPRINTS.md][oude-sprints], [SPRINT_AUDIT.md][oude-audit] en [NEXT_STEPS.md][oude-next] blijven historische context; hun nummering wordt niet hergebruikt. De nieuwe sprints krijgen prefix **V**.

## 2. Wat de app al kan

| Onderdeel                      | Aanwezig in code                                                                                    | Beoordeling                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Lokale bibliotheek             | NAS-paden, metadata, incrementele scan, albumedities op map/kwaliteit, covers, genres en paginering | Goede basis; behoud van identiteit en gegevens bij wijzigingen verdient aandacht.                   |
| Browseraudio                   | Lokale bestanden, Qobuz/radio, crossfade, optionele ReplayGain, Media Session en sneltoetsen        | Audiofouten en echte gapless-overgangen moeten beter worden afgehandeld en bewezen.                 |
| Netwerkspelers                 | DLNA, Sonos, Volumio, discovery, apparaatstatus, retries en Sonos-groepsinformatie                  | Dit is echte apparaatcode, niet alleen mocks. Afzonderlijke gelijktijdige wachtrijen ontbreken.     |
| Afspelen zonder actieve tablet | Servergestuurd doorspelen voor lokale nummers op netwerkapparaten                                   | Belangrijke recente verbetering, maar providers en herstel na herstart zijn nog onvolledig.         |
| Qobuz                          | Aanmelding, status, zoeken, albums en opvragen van een verse stream-URL                             | Bestaande hoofdroute voor externe volledige nummers; werking per account/apparaat nog live toetsen. |
| Spotify                        | OAuth, catalogus, Web Playback SDK, Connect, albumcontext en librespot-hulp                         | Meer dan een stub; actuele API-compatibiliteit en foutmeldingen blijven noodzakelijk.               |
| Tidal                          | Catalogus/metadata; volledige playback wordt expliciet geblokkeerd                                  | Bewuste productkeuze behouden totdat een ondersteunde route aantoonbaar haalbaar is.                |
| Muziekbeheer                   | Playlists, M3U import/export, slimme playlists, favorieten en geschiedenis                          | Basis bestaat; persoonlijke scheiding en duurzame verwijzingen naar externe nummers ontbreken.      |
| Ontdekken                      | ListenBrainz-aanbevelingen en nieuwe releases, statistieken, lyrics, internetradio                  | Uitbreiden vanuit deze basis; geen tweede los ontdeksysteem bouwen.                                 |
| Gebruikers en mobiel           | Accounts met rollen, gebruikersbeheer, thema's, responsive CSS, manifest en service worker          | Rollen maken de gegevens nog niet persoonlijk; een betrouwbare offline shell ontbreekt.             |
| Onderhoud                      | Logging, request-ID's, healthroutes, shutdown, OpenAPI, tests, Docker                               | Releasecontrole, readiness en herstelprocedure aanscherpen.                                         |

De [README][project-readme] en oudere auditteksten lopen op punten achter op de code. De oude waarschuwing over opruimen bij onbereikbare NAS-roots is bijvoorbeeld inmiddels afgevangen via succesvolle/mislukte scanroots. Ook API-404-volgorde en graceful shutdown zijn al geïmplementeerd. Deze zaken hoeven niet opnieuw te worden gebouwd.

## 3. Uitgevoerde controles

| Controle                     | Resultaat op 7 september 2026                                                                                              | Betekenis                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| npm test — server            | 150 tests geslaagd, 24 testbestanden                                                                                       | Bestaande serverregressies groen.                                      |
| npm test — client            | 84 tests geslaagd, 17 testbestanden                                                                                        | Bestaande clientregressies groen.                                      |
| npm run lint                 | Geslaagd; geen waarschuwingen/fouten gemeld                                                                                | Statische codecontrole groen.                                          |
| npm run typecheck            | Geslaagd                                                                                                                   | TypeScript-projecten consistent.                                       |
| npm run build                | Geslaagd                                                                                                                   | Server en client bouwen; geen bewijs voor een werkende NAS-release.    |
| Buildmelding                 | Browserslist-browsergegevens circa zes maanden oud                                                                         | Kleine onderhoudstaak; geen buildblokkade.                             |
| npm audit --omit=dev --json  | 19 gemelde kwetsbare pakketten: 11 high, 6 moderate, 2 low, 0 critical                                                     | Remediatie en beoordeling per daadwerkelijk gebruikte codeketen nodig. |
| Aanvullende wachtrijcontrole | Bij A → B → A → C gaat de index na de tweede A terug naar 0; daarna volgt B                                                | Concrete fout buiten de bestaande testdekking.                         |
| Aanvullende opslagcontrole   | Drizzle-insert zonder tijdstempel levert played_at = NULL en created_at = NULL op                                          | SQL-defaults worden niet vanzelf gebruikt door deze schema-inserts.    |
| Aanvullende modulecontrole   | Directe ESM-import van playback.ts faalt op een circulaire afhankelijkheid; vooraf importeren van socketio.ts voorkomt dit | Importvolgordegevoeligheid; geen bewijs dat de normale startup faalt.  |

De lokale controles draaiden op **Node 24.19.0**. Het Dockerfile gebruikt standaard **Node 22**. De releasecontrole moet ook de daadwerkelijke productie-runtime afdekken.

De 19 npm-meldingen zijn **pakketten**, geen 19 bewezen aanvalsroutes. Voorbeelden zijn music-metadata/file-type, drizzle-orm, Engine.IO/Socket.IO/ws, node-ssdp/ip en React Router. Sommige meldingen betreffen functies die deze app mogelijk niet gebruikt, zoals serverrendering. Een automatische downgrade die npm voor node-ssdp suggereert is geen verantwoord herstelplan. Gebruik [de eerdere security-audit][oude-security] als achtergrond, maar neem de nieuwe scan als uitgangspunt.

## 4. Belangrijkste bevindingen

**Prioriteiten:** P1 = betrouwbaarheid, toegang of behoud van gebruikersgegevens; P2 = belangrijke kwaliteit of bruikbaarheid; P3 = uitbreiding na validatie van de behoefte. “Bevestigd” betekent hier codebewijs of een uitgevoerde gerichte controle, niet automatisch een hardwaretest.

### B01 — Releaseborging en afhankelijkheden zijn niet actueel

**P1 · bevestigd · V01**

De historische changelog noemt een CI-workflow, maar in deze checkout staat geen .github/workflows/ci.yml en Git bevat hier geen workflowbestand. Er zijn wel goede lokale scripts. De actuele dependencycontrole meldt bovendien nog relevante kwetsbaarheden.

**Gevolg:** een lokale groene build geeft onvoldoende zekerheid dat een schone installatie of NAS-image dezelfde uitkomst heeft.

**Aanpak:** herstel een geautomatiseerde controle op schone checkout, beoordeel en verhelp de meldingen, test de productie-image en leg een kleine herstelprocedure vast. Zie [Dockerfile][docker] en [testapp][test-app]; die testapp start de zware achtergrondservices bewust niet.

### B02 — Eerste installatie, beheerrechten en verlopen sessies hebben gaten

**P1 · bevestigd · V02**

- Bij nul gebruikers laat [requireAuth][auth] alle API-acties door. De eerste registratie is wel transactioneel beschermd, maar de installatie heeft vóór registratie geen beperkte setupmodus.
- [Importeren van provider-tokens][auth-routes] vereist geen adminrol. Ook globale provider-/scrobble-instellingen en scans hebben geen consistente beheerrolcontrole.
- [App.tsx][app-auth] controleert aanmelding via statistieken. Die controle loopt via een publieke healthroute. Ook de 401-afhandeling gebruikt de aanwezigheid van een opgeslagen token als reden om geen login te tonen.
- JWT's leven 30 dagen; een volledige gebruikerssessie met afmelden/intrekken/wachtwoordherstel ontbreekt. Verwijderde gebruikers worden bij nieuwe API-authenticatie wél gecontroleerd.

**Gevolg:** onduidelijke eerste installatie, gewone gebruikers kunnen globale integraties wijzigen, en een verlopen sessie kan leiden tot een ogenschijnlijk geopende app met falende acties.

**Aanpak:** expliciete setupstatus, beschermde setup, centrale admincontrole, een echte authstatuscontrole en afmelden/herstellen/intrekken. Bestaande actieve sockets moeten dezelfde sessiebeslissing volgen.

### B03 — Dezelfde track kan de wachtrij laten teruglopen

**P1 · gereproduceerd · V03**

[PlaybackService.play()][queue-service] zoekt de positie op via het eerste overeenkomende track-ID. Daardoor springt de tweede A in A → B → A → C terug naar positie 0 en wordt C niet normaal bereikt.

**Aanpak:** geef elke wachtrijpositie een eigen stabiel queueItemId. Gebruik dat voor actuele positie, verplaatsen, verwijderen, hervatten en events. Een track-ID identificeert het muziekstuk; het identificeert niet één voorkomen in een wachtrij.

### B04 — Lege wachtrijen, reconnects en meerdere clients lopen uiteen

**P1 · bevestigd · V03**

[clearQueue()][queue-client] leegt alleen de clientstatus. Het synchronisatie-effect stopt juist als de wachtrij leeg is, zodat een externe speler de oude serverwachtrij kan behouden. Browserwachtrijen worden in deze flow niet volledig naar de server gesynchroniseerd.

De server broadcast trackwijzigingen globaal. [useSocket()][socket-client] verwerkt geen volledige queue/state-snapshot bij reconnect. Het trackwijzigingseffect kan vervolgens in een andere browser opnieuw playback starten, omdat zone-/sessiecontext ontbreekt.

**Aanpak:** één gezaghebbende wachtrij per afspeelsessie, expliciete clear/stop-opdrachten, revisienummers, context in events en snapshot-herstel. Tot echte zones bestaan mag een tweede apparaat de actieve sessie niet onbedoeld overnemen. Zie ook [Socket.IO-server][socket-server].

### B05 — Servergestuurde playback is nog beperkt tot lokale nummers

**P1 · bevestigd · V04**

[server-player.ts][server-player] slaat niet-lokale track-ID's expliciet over en rekent dan op een actieve client. Eigenaar en actief apparaat staan alleen in geheugen. Bij een mislukte dispatch wordt vooral gelogd; de wachtrijstatus kan al naar het volgende nummer zijn doorgeschoven.

Daarnaast schrijft de [device-monitor][device-monitor] updates van bewaakte apparaten naar één playbackservice. Zonder selectie op actieve sessie kan de status van een ander apparaat die status overschrijven. De polling heeft geen expliciete bescherming tegen overlappende langzame verzoeken.

**Gevolg:** Qobuz of gemengde wachtrijen kunnen stilvallen als de tablet slaapt; na serverherstart is een opgeslagen wachtrij nog geen herstelde actieve afspeelsessie.

**Aanpak:** één serverpad voor bronresolutie en dispatch, afgebakende sessies, foutstatus en retrybeleid, herstel na reconnect/herstart en begrensde polling. Spotify Connect blijft een aparte playbackstrategie; het is geen generieke audiostream.

### B06 — Luistergeschiedenis en scrobbles zijn niet betrouwbaar genoeg

**P1 · deels gereproduceerd, verder codebewijs · V05**

De [lokale startflow][track-playback] registreert een play direct, met een lege artistId, voordat bewezen is dat voldoende audio is afgespeeld. De [historyroute][history] geeft daarbij geen playedAt mee. De aanvullende databasecontrole bevestigde NULL als resultaat.

De serverplayer scrobbelt eveneens bij verzending van een nieuwe track. De [scrobbler][scrobbler] toetst zelf niet hoeveel daadwerkelijk is geluisterd. Externe bronnen hebben nog geen gelijkwaardige duurzame historyroute. Dezelfde ontbrekende createdAt-default speelt bij andere Drizzle-inserts.

**Gevolg:** “recent”, topartiesten en aanbevelingen kunnen onvolledig of misleidend worden; snel overgeslagen of mislukte nummers kunnen meetellen.

**Aanpak:** luistersessie met starttijd, werkelijk afgespeelde tijd, trackmetadata en éénmalige verwerking. Voor Last.fm geldt een trackduur van meer dan 30 seconden en luisteren gedurende minimaal de helft of vier minuten, wat het eerst wordt bereikt. Zie [Last.fm Scrobbling 2.0](https://www.last.fm/api/scrobbling).

### B07 — Verplaatsen van muziek kan gebruikersgegevens verwijderen

**P1 · bevestigd · V06**

De [scanner][scanner] herkent een bestaand nummer primair op bestandspad. Een verplaatsing wordt daardoor een nieuw nummer plus verwijdering van het oude. Orphan cleanup verwijdert ook playlistverwijzingen, history en trackfavorieten.

De bescherming tegen onbereikbare roots is al aanwezig en moet behouden blijven. Het aanvullende probleem is het onderscheid tussen “verplaatst”, “tijdelijk niet beschikbaar” en “bewust definitief verwijderd”.

**Aanpak:** stabiele bibliotheekidentiteit, apart bronpad/bestandskenmerk, ontbrekende items eerst markeren en een herstelflow. Gebruik automatische koppeling alleen als een match voldoende zeker is; zelfde titel/artiest is geen bewijs.

### B08 — Zoekresultaten kunnen verschillende versies samenvoegen

**P2 · bevestigd · V07**

[Providerdeduplicatie][registry] groepeert tracks op artiest + titel en albums op artiest + titel, zonder editie, duur of versie. De normalisatie verwijdert tekens buiten a-z/0-9, waardoor verschillende niet-Latijnse namen dezelfde lege sleutel kunnen krijgen. availableOn bewaart bronnamen, geen complete alternatieve itemverwijzingen.

[Lokale zoekopdrachten][local-search] gebruiken LIKE, terwijl facetfilters en expliciete editie-/bronkeuze beperkt zijn.

**Aanpak:** Unicode-veilige vergelijking, behoud van bron-ID's en versies, gerangschikt zoeken en filters. Meet eerst of FTS5 nodig is; voeg het alleen toe met een representatieve benchmark.

### B09 — Een provider-capabilitymodel ontbreekt

**P2 · bevestigd · V04/V07**

De gedeelde providerinterface kent voornamelijk beschikbaarheid en een stream-URL. De client bepaalt de route vaak via een ID-prefix. Volledig afspelen, preview, catalogus, apparaatgeschiktheid, tijdelijke URL's en vereiste accounts zijn daardoor verspreid over meerdere bestanden.

De [Spotify-code][spotify] heeft de zoeklimiet al naar maximaal 10 aangepast, maar haalt playlistitems nog via /playlists/{id}/tracks op. Spotify documenteert voor Development Mode een wijziging naar /items. Dit is een **compatibiliteitsrisico dat per appmodus live moet worden bevestigd**, geen in deze sessie gereproduceerde accountfout. Zie [Spotify-wijzigingen van februari 2026](https://developer.spotify.com/documentation/web-api/references/changes/february-2026).

**Aanpak:** expliciete mogelijkheden en foutredenen per bron/output, centrale timeouts/retries en actuele contracttests.

### B10 — Meerdere accounts delen hun muziekomgeving

**P2; P1 vóór aanbieden als privéprofielen · bevestigd · V09**

[Playlists, favorieten, geschiedenis en scrobbleconfiguratie][schema] hebben geen userId. Provider-tokens zijn globaal per provider opgeslagen. De app ondersteunt dus rollen/accounts, maar nog geen persoonlijke muziekomgevingen.

**Aanpak:** een gedeelde muziekbibliotheek met persoonlijke favorieten, playlists, luistergegevens en scrobbleaccounts. Laat bestaande globale provideraccounts aanvankelijk expliciet door de admin beheren; persoonlijke Qobuz/Spotify-accounts vragen apart ontwerp en acceptatie.

### B11 — Multi-room is nog geen onafhankelijke playback per kamer

**P2 · bevestigd · V10**

Er is één singleton playback_state en één globale queue_items-verzameling. Sonos-groepsmetadata is aanwezig, maar de [apparaatinterface][device-interface] heeft geen eigen zone-/groepsmodel en geen algemene seek-opdracht.

**Aanpak:** aparte wachtrij en sessie per zone, met duidelijke rechten en apparaatmogelijkheden. Bouw native groepering en overdracht tussen kamers als vervolgstap; gelijktijdig afspelen op twee speakers bewijst geen synchronisatie.

### B12 — Gapless is nog niet functioneel afgemaakt

**P2 · bevestigd · V11**

[preloadNext()][audio] bestaat maar wordt niet in de normale playbackflow aangeroepen; de niet-crossfade-tak vervangt de src van het huidige audio-element. Alleen preload aansluiten volstaat niet: de voorbereide audio moet ook werkelijk voor de overgang worden gebruikt.

De [set-next-route][device-routes] en DLNA-ondersteuning bestaan, maar de normale serverqueue stuurt deze voorbereiding nog niet aan. De [manager][device-manager] kan zonder capability ook stilzwijgend terugkeren.

**Aanpak:** betrouwbare voorbereiding en overname, apparaatmogelijkheden expliciet tonen, en overgangen meten. Onderscheid “crossfade”, “naadloze overgang” en “gapless geverifieerd”. Toon geen bit-perfect-status uitsluitend op basis van FLAC of de bronresolutie.

### B13 — De service worker heeft geen gevulde offline shell

**P2 · bevestigd · V08**

De [service worker][sw] schrijft covers naar de cache. Andere verzoeken vallen bij netwerkproblemen terug op caches.match, maar HTML/JS/CSS worden niet in die shellcache opgeslagen. Een verse installatie heeft dus geen bruikbare shellfallback.

De covercache heeft geen expliciete omvang-/ouderdomslimiet. Oude appcaches worden via een brede naamfilter verwijderd.

**Aanpak:** versievaste shellcache, begrensde artworkcache, beheer van alleen eigen caches, bruikbare offlinepagina en een gecontroleerde updateflow. Offline navigatie is iets anders dan offline muziekdownloads.

### B14 — Operationele signalen zijn te optimistisch

**P2 · bevestigd · V01/V06**

De [healthroute][health] antwoordt ook bij degraded met HTTP 200. De Docker-healthcheck gebruikt curl -f en herkent die toestand daardoor niet als fout. lastScanAt is afgeleid van MAX(created_at) van tracks, geen werkelijk scanresultaat.

Migraties zijn verdeeld over [Drizzle-migraties en runtime ALTER TABLE-aanvullingen][database]. Daardoor zijn een test op oude databases en een gecontroleerde herstelprocedure belangrijk.

**Aanpak:** minimale publieke liveness, readiness met passende statuscode, beschermde uitgebreide diagnostiek, scan_run-registratie, versieerbare migraties en bewezen herstel van database plus noodzakelijke configuratie.

## 5. Onderzoek naar verbeterde en nieuwe functies

De vergelijking hieronder is gericht op bruikbare productideeën, geen claim dat AudioServer volledige gelijkwaardigheid met deze producten moet bereiken.

| Product/bron                                                                                        | Relevante observatie uit primaire documentatie                                                                                             | Vertaling naar AudioServer                                                                                |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| [Music Assistant — spelersinstellingen](https://www.music-assistant.io/settings/individual-player/) | Mogelijkheden en uitvoerinstellingen verschillen per speler; doorlopende queuestream kan overgangen helpen, met beperkingen voor metadata. | Capabilitymodel, zichtbare audiokeuzes en een apart haalbaarheidsonderzoek naar continue streaming.       |
| [Music Assistant — groepen](https://www.music-assistant.io/faq/groups/)                             | Groepstypen hebben verschillende wachtrij- en synchronisatie-eigenschappen.                                                                | Eerst afzonderlijke zones; vervolgens alleen aantoonbaar ondersteunde groepen.                            |
| [Navidrome — overzicht](https://navidrome.org/docs/overview/)                                       | Persoonlijke playlists/favorieten, collectiebeheer, transcoding en een ecosysteem van Subsonic-clients.                                    | Profielen hebben directe waarde; OpenSubsonic kan later mobiele clients ontsluiten.                       |
| [Roon — Signal Path](https://help.roonlabs.com/portal/en/kb/articles/signal-path)                   | Bron, verwerking en uitvoer worden zichtbaar gemaakt; de uitvoer wordt niet automatisch als lossless beschouwd.                            | Breid kwaliteitslabels uit tot een begrijpelijk audiopad met bekende én onbekende stappen.                |
| [Spotify — quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)   | Development Mode vereist Premium voor de appeigenaar, maximaal vijf toegelaten gebruikers en kent quota.                                   | Maak accountvoorwaarden en 403/429-herstel zichtbaar; beloof geen onbeperkte publieke Spotify-integratie. |
| [Spotify — Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk)          | Browserplayback is een aparte SDK-route; iOS kent beperkingen rond starten na overdracht.                                                  | Behoud de bestaande SDK-strategie en toets echte browsers; geen generieke proxy als vervanging.           |

### Functiekeuzes

| Functie                                                       | Bestaand, verbeteren of nieuw? | Gebruikerswaarde                                      | Inspanning/risico                    | Advies                                                           |
| ------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| Betrouwbaar doorspelen met gesloten tablet                    | Verbeteren                     | Zeer hoog; kernfunctie van een NAS-muziekserver       | Hoog; bron- en apparaatgedrag        | V03–V04, noodzakelijk.                                           |
| Hervatten en gedeelde bediening zonder wachtrijverlies        | Verbeteren                     | Zeer hoog                                             | Middel/hoog                          | V03, noodzakelijk.                                               |
| Bibliotheekcontrole met ontbrekende/verplaatste bestanden     | Nieuw op bestaande scanner     | Hoog; behoud playlists en favorieten                  | Middel/hoog                          | V06.                                                             |
| Zoeken op bron, editie, genre en kwaliteit                    | Verbeteren                     | Hoog bij grotere collecties                           | Middel                               | V07.                                                             |
| Providerstatus met “waarom kan dit niet spelen?”              | Verbeteren                     | Hoog; minder uitproberen                              | Middel                               | V04 en V07.                                                      |
| Installatiewizard en bruikbare offline shell                  | Verbeteren/nieuw               | Hoog voor telefoon/tablet en beheer                   | Middel                               | V02 en V08.                                                      |
| Persoonlijke profielen                                        | Bestaande rollen uitbreiden    | Hoog bij gedeeld gebruik                              | Hoog; datamigratie                   | V09, kiezen als meerdere mensen de app gebruiken.                |
| Eigen wachtrij per kamer                                      | Nieuw op bestaande apparaten   | Hoog bij echt multi-roomgebruik                       | Hoog                                 | V10.                                                             |
| Audiopad en aantoonbaar betere trackovergangen                | Verbeteren/nieuw               | Hoog bij albumgericht luisteren                       | Hoog; hardwareafhankelijk            | V11.                                                             |
| Gemengde lokale/Qobuz-playlists en lokale ontdekmixen         | Bestaande functies uitbreiden  | Hoog zodra bron-ID's en geschiedenis betrouwbaar zijn | Middel/hoog                          | V12.                                                             |
| Sleeptimer / stoppen na dit album                             | Nieuw                          | Praktisch en relatief klein                           | Laag/middel                          | Optionele backlog E01.                                           |
| OpenSubsonic voor bestaande mobiele apps                      | Nieuw                          | Potentieel hoog buitenshuis                           | Hoog; API-compatibiliteit en auth    | Eerst beperkte proef E02.                                        |
| Cast/AirPlay/Snapcast/Home Assistant                          | Nieuw                          | Afhankelijk van aanwezige apparatuur                  | Hoog                                 | Alleen na concrete apparaatbehoefte; E03.                        |
| Volledige Tidal-playback                                      | Herziening productrichting     | Onzeker naast Qobuz                                   | Hoog; externe afhankelijkheden       | Voorlopig niet plannen; alleen na ondersteunde proof of concept. |
| AI-DJ, uitgebreide DSP, podcasts en offline providerdownloads | Nieuw                          | Nog onvoldoende onderbouwd                            | Hoog; extra scope en bronbeperkingen | Uitstellen.                                                      |

**Productkeuze:** lokaal + Qobuz blijven de kern. Spotify behoudt zijn eigen ondersteunde afspeelroute. Gedeelde catalogus, persoonlijke voorkeuren en zonewachtrijen worden afzonderlijke begrippen.

## 6. Sprintindeling en capaciteit

**Planningsaanname:** één ontwikkelaar, sprints van twee weken, ongeveer acht netto ontwikkel-/testdagen per sprint. Twee dagen blijven beschikbaar voor overleg, review, onvoorziene fouten en acceptatie. De ramingen hieronder zijn eerste indicaties, met circa 40% onzekerheid; hardwarewerk kan hoger uitvallen.

**V01–V08 vormen de aanbevolen basisroute: circa 16 kalenderweken.** Elke sprint levert afzonderlijk bruikbaar resultaat. **V09–V12 zijn uitbreidingssprints: maximaal acht extra kalenderweken als de behoefte bevestigd wordt.** Dit is geen toezegging dat alle uitbreidingen in 24 weken zonder tegenvallers klaar zijn.

De taakdagen hieronder tellen per sprint op tot acht. Bij overschrijding: verklein een verticaal bruikbare scope of voeg een vervolgsprint toe. Schrap geen gegevensbehoud of acceptatie om een datum te halen.

| Sprint | Resultaat                                          | Afhankelijk van                   | Status                                                   |
| ------ | -------------------------------------------------- | --------------------------------- | -------------------------------------------------------- |
| V01    | Herhaalbare, beter beveiligde releasebasis         | Geen                              | Uitgevoerd in code (8 sep 2026); wacht op NAS-acceptatie |
| V02    | Betrouwbare setup, aanmelding en beheerrechten     | V01                               | Uitgevoerd in code (8 sep 2026); wacht op NAS-acceptatie |
| V03    | Correcte wachtrij en herstel tussen clients        | V01–V02                           | Uitgevoerd in code (8 sep 2026); wacht op NAS-acceptatie |
| V04    | Zelfstandige lokale/Qobuz-playback op server       | V03                               | Uitgevoerd in code (9 sep 2026); wacht op NAS-acceptatie |
| V05    | Betrouwbare luistergegevens en tijdstempels        | V03–V04                           | Uitgevoerd in code (9 sep 2026); wacht op NAS-acceptatie |
| V06    | Bibliotheekwijzigingen zonder verlies van relaties | V01, V05                          | Uitgevoerd in code (9 sep 2026); wacht op NAS-acceptatie |
| V07    | Betere zoekresultaten, edities en bronkeuze        | V04, V06                          | Uitgevoerd in code (9 sep 2026); wacht op NAS-acceptatie |
| V08    | Mobiele afronding, onboarding en offline shell     | V02–V07                           | Gepland                                                  |
| V09    | Persoonlijke muziekomgevingen                      | V02, V05–V06                      | Optioneel vervolg                                        |
| V10    | Onafhankelijke wachtrij per zone                   | V03–V04, V09                      | Optioneel vervolg                                        |
| V11    | Audio-inzicht en geverifieerde trackovergangen     | V04; V10 als zones worden gebouwd | Optioneel vervolg                                        |
| V12    | Gemengde playlists en betere ontdekfuncties        | V05, V07; V09 bij profielen       | Optioneel vervolg                                        |

### V01 — Releasebasis en direct herstelbare risico's

**Doel:** elke verandering reproduceerbaar testen en veilig kunnen terugdraaien.  
**Bevindingen:** B01, B14.

- [x] **V01.1 · 1,5 dag:** CI op schone checkout: npm ci, lint, typecheck, tests en build; test de gekozen productieversie van Node. Voeg een startup-/shutdownproef toe die geen echte providers of apparaten benadert.
      _Gedaan:_ `.github/workflows/ci.yml` (Node 22 én 24, daarna productie-image bouwen, starten, readiness, HEALTHCHECK en nette stop). `server/src/__tests__/startup-smoke.test.ts` start het echte entrypoint met tijdelijke database, lege muziekmap en zonder providers/apparaten, controleert live/ready/health en een schone SIGTERM-exit.
- [x] **V01.2 · 3 dagen:** dependencybevindingen opnieuw vastleggen, gebruikte aanvalspaden beoordelen en reparaties in kleine groepen uitvoeren. Begin met parser-, database- en transportketens; test major-upgrades apart.
      _Gedaan:_ productie-audit van 19 naar 2 pakketten (beide dezelfde `node-ssdp → ip`-keten, beoordeeld als onbereikbaar met eigenaar en herbeoordelingsdatum). music-metadata 10→11 en drizzle-orm 0.38→0.45 apart getest; details in `SECURITY_AUDIT.md`.
- [x] **V01.3 · 1,5 dag:** schone productie-image bouwen/starten, readiness van liveness scheiden en de containercontrole daarop laten aansluiten.
      _Gedaan:_ `GET /api/health/ready` (503 zolang de database niet open/gemigreerd is), `/api/health` antwoordt 503 bij degraded, Docker `HEALTHCHECK` gebruikt readiness. Image-bouw en -start draaien in de CI-job `docker`; in de ontwikkelomgeving van deze sprint was geen Docker-daemon beschikbaar, de eerste imagecontrole is de groene CI-run 50 op deze branch (zie §11).
- [x] **V01.4 · 2 dagen:** herstelprocedure met consistente SQLite-back-up, configuratie/sleutelbeheer en restore op een lege testinstallatie. Documentatie en huidige status corrigeren.
      _Gedaan:_ `db:backup` (SQLite online backup, één zelfstandig bestand), `db:verify`, `db:restore` (dry-run, veiligheidskopie, weigert bij open database), schemaversie in `PRAGMA user_version` met startup-weigering bij een nieuwere database, runbook `docs/backup-restore.md` (back-up, update, rollback, herstel op lege installatie, `.env`/`JWT_SECRET`), test die een back-up op een lege installatie terugzet en accounts, bibliotheek, playlist en geschiedenis terugleest.

**Acceptatie:**

- Alle bestaande controles slagen ook buiten de huidige node*modules-map. \_Gehaald: `npm ci` op schone checkout, daarna lint, typecheck, 158 server- en 84 clienttests, build; CI herhaalt dit per push.*
- Iedere resterende high/critical-melding heeft een onderbouwde beoordeling, eigenaar en einddatum; geen aantoonbaar bereikbare high/critical-route blijft ongemitigeerd bij release. _Gehaald: één resterende keten (`node-ssdp → ip`), beoordeling en herbeoordelingsdatum 1 december 2026 in `SECURITY_AUDIT.md`._
- Een onbruikbare database leidt tot niet-ready/HTTP 503; liveness blijft een afzonderlijke controle. _Gehaald: getest in `api.test.ts` (zonder database) en de smoke-test (met database)._
- Een back-up is daadwerkelijk teruggezet; bibliotheek, playlists en accounts zijn gecontroleerd. _Gehaald op testdata (`db-backup.test.ts`, plus handmatige run van de drie scripts). Open: dezelfde restore op de echte NAS-database, tijd vastleggen in `docs/backup-restore.md`._
- Update en rollback bevatten een expliciete controle op databasecompatibiliteit. Alleen de oude image terugzetten geldt niet automatisch als geldige rollback. _Gehaald: schemaversiecontrole bij startup + rollbackprocedure met restore in `docs/backup-restore.md` en `DEPLOY_SYNOLOGY.md`._

**Niet gedaan in V01 (bewust):** de versieerbare testcollectie met echte audiobestanden uit §9 is niet toegevoegd; er is in deze omgeving geen ffmpeg om rechtenvrije MP3/FLAC te genereren. Dit staat als eerste taak in V06 (bibliotheekbehoud), waar de scanner-tests hem nodig hebben. `npm run format:check` slaagt nog niet op 13 bestaande bestanden en is daarom nog geen CI-stap; lint-staged formatteert nieuwe wijzigingen wel.

### V02 — Setup, sessies en beheerrechten

**Doel:** een nieuwe en bestaande gebruiker krijgt een voorspelbare, afgeschermde toegang.  
**Bevinding:** B02.

- [x] **V02.1 · 2 dagen:** setupstatus en eenmalige installatiecode via een lokaal beheerkanaal; alleen setup, statische bestanden en minimale health publiek bij nul gebruikers.
      _Gedaan:_ `GET /api/auth/setup-status`; setupcode (8 hex, `XXXX-XXXX`) wordt bij nul gebruikers in het serverlog gemeld en naast de database in `setup-code.txt` (0600) geschreven, of komt uit `SETUP_CODE`. `/register` maakt uitsluitend de eerste admin aan en eist die code; daarna wordt de code gewist. `requireAuth` laat bij nul gebruikers niets meer door behalve setup-status, login/logout/register, `/auth/me`, `/health/live|ready`, OpenAPI en het CSP-rapport; `/api/health` (volledige diagnostiek) vereist nu een sessie. Socket.IO heeft geen setupbypass meer; het anonieme first-run-streamtoken is verwijderd.
- [x] **V02.2 · 2 dagen:** centrale admincontrole voor globale providerinstellingen, tokenimport, scanbeheer en andere systeemmutaties; expliciete rechtenmatrix met admin/gebruiker.
      _Gedaan:_ `requireAdmin` op gebruikersbeheer, tokenimport, Spotify/Tidal OAuth init/callback/logout, Qobuz login/logout, Last.fm/ListenBrainz koppelen/ontkoppelen, scan-, cover- en artiestenfoto-fetch en Librespot start/stop. Matrix in `docs/permissions.md`; elke admin-rij wordt in `sessions-permissions.test.ts` als gebruiker (403) én anoniem (401) getest. De Settings-pagina toont die secties alleen aan admins.
- [x] **V02.3 · 2,5 dag:** authcontrole via sessiestatus, verlopen token correct afhandelen, afmelden, sessies intrekken en een beheerde herstelroute voor wachtwoorden. Ook socketauth en streamtokens toetsen.
      _Gedaan:_ tabel `sessions` (migratie `0001_sessions`, schemaversie 2); JWT draagt een sessie-id en geldt alleen zolang de rij bestaat, niet ingetrokken en niet verlopen is (30 dagen). Nieuwe routes: logout (idempotent), eigen sessies tonen/intrekken, “overal anders afmelden”, wachtwoord wijzigen; admin: wachtwoord resetten (beëindigt alle sessies van die gebruiker) en sessies intrekken. Ingetrokken sessies krijgen `session:revoked` en hun socket wordt gesloten; streamtokens zijn aan de sessie gebonden, servergestuurde apparaatweergave gebruikt een `system`-token. Client: `AuthContext` bepaalt de status via `/auth/setup-status` + `/auth/me`, een 401 of gesloten socket brengt de app terug naar het loginscherm; uitlogknop in de header, sectie “Account & Sessions” in Settings. Bestaande tokens van vóór deze release zijn ongeldig: iedereen logt één keer opnieuw in.
- [x] **V02.4 · 1,5 dag:** invoervalidatie op de betrokken routes aanvullen; token-URL's uit logs verwijderen; CSP eerst in rapportagemodus toetsen tegen de eigen SPA en Spotify SDK.
      _Gedaan:_ zod-validatie op OAuth init/callback, Qobuz-login, Librespot-start, alle nieuwe auth-routes en padparameters. Gecontroleerd dat request- en errorlogging alleen `req.path` loggen (geen query, dus geen `?t=`-tokens) en dat apparaatlogs de stream-URL niet bevatten. Helmet stuurt `Content-Security-Policy-Report-Only` met `report-uri /api/csp-report`; overtredingen komen als `CSP report:` in het log. Browserflow (Chromium, productiebuild) gaf 0 overtredingen; de Spotify Web Playback SDK is in deze omgeving niet te laden en moet op de NAS met een Spotify-account worden bekeken voordat de policy afdwingend wordt.

**Acceptatie:**

- Zonder setupcode kunnen twee gelijktijdige bezoekers geen beheer over een nieuwe installatie verkrijgen. _Gehaald: zonder/verkeerde code 400/403; met code wint precies één van twee gelijktijdige registraties (`auth-flow.test.ts`); smoke-test leest de code uit `setup-code.txt` zoals een operator._
- Een gewone gebruiker kan geen globale providerverbinding wijzigen; API-tests bewijzen 403. _Gehaald: 24 admin-routes × (gebruiker 403, anoniem 401) in `sessions-permissions.test.ts`._
- Ongeldige/verlopen tokens tonen aanmelding, ook als localStorage nog een waarde bevat. _Gehaald: `AuthContext.test.tsx` en browserflow stap 9 (rommeltoken in localStorage → loginscherm)._
- Afmelden of intrekken beëindigt de eigen sessie en bijbehorende sockettoegang volgens het vastgelegde beleid. _Gehaald: sessie-lifecycle-tests (logout, revoke, revoke-others, wachtwoord wijzigen/resetten), socket wordt bij intrekking gesloten (`socketio-subscriptions.test.ts`), browserflow stap 8: admin trekt sessies in en de tablet-pagina valt terug op login. Beleid in `docs/permissions.md`._
- Setup met lege bibliotheek, bestaande gebruiker en provideruitval is als browserflow getest. _Gehaald in Chromium tegen de productiebuild met lege bibliotheek en zonder providercredentials (Settings toont de providerkaarten als “niet geconfigureerd”): setupscherm → foute code → registratie → admin-Settings → gebruiker aanmaken → uitloggen → inloggen als gebruiker zonder beheersecties → intrekking → stale token → opnieuw inloggen. Het script staat niet in de repo (Playwright is geen projectafhankelijkheid); herhaal het op de NAS bij de eerste uitrol._

### V03 — Wachtrij als één consistente afspeelsessie

**Doel:** dezelfde afspeelsessie blijft correct na bewerken, verversen en opnieuw verbinden.  
**Bevindingen:** B03, B04; eerste begrenzing van B05/B11.

- [x] **V03.1 · 2 dagen:** queueItemId en persistente actieve positie invoeren; herhaalde tracks, verwijderen en verplaatsen op positie-identiteit laten werken.
      _Gedaan:_ migratie `0002_queue_identity` (schemaversie 3): `queue_items.item_id` + `metadata`, `playback_state.queue_item_id` + `revision`. `PlaybackService` werkt op item-identiteit (`playItem`, `removeItem`, `moveItem`, `previous`); `play(track)` valt alleen nog terug op het eerste voorkomen als er geen item-id of actueel item is. Oude wachtrijen krijgen bij het laden stabiele id’s. Client-metadata (ReplayGain, formaat) reist mee in `metadata` zodat een volgend nummer uit de serverwachtrij compleet is.
- [x] **V03.2 · 2 dagen:** expliciete queue-opdrachten met revisie en opdracht-ID. Clear stopt toekomstige items; “stop” stopt het actuele nummer volgens een apart contract.
      _Gedaan:_ `GET /playback/session` (snapshot) en commando’s `queue/set|add|remove|move|clear|play`, `next`, `previous`; elk antwoord is de volledige snapshot met `revision`. `expectedRevision` → `409 StaleRevision` + verse snapshot; `commandId` → idempotent (retry geeft hetzelfde resultaat, één keer toegepast). Mutaties vereisen `X-Client-Id`; een verouderde pagina krijgt `426` met “herlaad de app” in plaats van stil overschrijven. Contract vastgelegd in `docs/architecture.md` en OpenAPI: clear laat het actuele nummer uitspelen, stop stopt direct en bewaart de wachtrij.
- [x] **V03.3 · 2 dagen:** server-snapshot bij laden/reconnect, queue/state-events verwerken en events aan de juiste sessie binden. Voorkom automatisch starten in andere browsers.
      _Gedaan:_ elke socket krijgt `playback:snapshot` bij (re)connect en op `playback:sync`; `playback:queue|state|track-changed` dragen `revision` en `origin` (client-id + sessie of `server`) plus `controllerClientId`. Client (`AudioContext`): de wachtrij is een spiegel van de server met optimistische updates; oudere revisies worden genegeerd; eigen commando’s worden via hun antwoord afgehandeld; wijzigingen uit een andere tab worden alleen getoond; een servergestuurde advance start in deze tab alleen een providertrack als deze tab de controller is. De apparaatmonitor schrijft alleen nog status van het actieve apparaat naar de sessie.
- [x] **V03.4 · 2 dagen:** regressies voor twee clients, verouderde bewerkingen en netwerkherstel. Maak de service onafhankelijk van importvolgorde via geïnjecteerde events/dependencies.
      _Gedaan:_ servertests voor twee tabs (stale edit uit tab B, origin op events), retry met dezelfde `commandId`, snapshot bij connect en `playback:sync`, apparaatmonitor op niet-actief apparaat, herstart met herhaalde track; clienttests voor spiegelen zonder audio, oudere revisies, servergestuurde advance en herstel na 409. `playback.ts` importeert Socket.IO niet meer (event-sink via `setEventSink`), bewezen in `playback-imports.test.ts`. Browsercontrole op de productiebuild: twee tabs, wachtrij gezet in tab A, tab B toont dezelfde items en volgt verwijderen en leegmaken live (zie §11).

**Acceptatie:**

- A → B → A → C speelt elke wachtrijpositie exact volgens die volgorde; herstart herstelt de tweede A als tweede voorkomen. _Gehaald: `playback.test.ts` “A → B → A → C plays every position in order” inclusief herstart via `initialize()`._
- Een leeggemaakte wachtrij blijft leeg op de server en een tweede client; het actuele nummer mag alleen doorlopen als dat het gekozen clear-contract is. _Gehaald: clear-test op de server (wachtrij leeg, actueel nummer speelt door, daarna idle) en de tweetabs-browsercontrole._
- Een retry van dezelfde opdracht maakt geen dubbele items. _Gehaald: `commandId`-tests in service en route._
- Een verouderde queuebewerking wordt herkenbaar geweigerd of opnieuw toegepast op de nieuwe snapshot. _Gehaald: 409 `StaleRevision` met snapshot; de client past de snapshot toe en meldt “Queue changed on another device”._
- Tot V10 is er maximaal één expliciet actieve serverzone; status van een ander bewaakt apparaat verandert die sessie niet. _Gehaald: `setState` negeert een ander apparaat dan het actieve; apparaatmonitor-test “feeds the UI for a non-active device but never touches the session”._

### V04 — De NAS stuurt lokale muziek en Qobuz zelfstandig aan

**Doel:** muziek blijft doorspelen wanneer alle bedienende clients slapen.  
**Bevindingen:** B05, B09.

- [x] **V04.1 · 2 dagen:** gedeeld playbackcontract voor bron, provider-item-ID, tijdelijke URL en capabilities; gebruik één resolver voor lokale bestanden en Qobuz.
      _Gedaan:_ `services/playback-resolver.ts` met per bron `serverDispatch`, `browser`, `externalPlayer`, `ephemeralUrl` en reden; `resolveForDevice()` levert per aanroep een verse URL (lokaal: LAN-URL met nieuw `system`-token en mimetype; Qobuz: nieuw gesigneerde CDN-URL met `expiresAt`; radio: stationstream) plus consistente metadata. Spotify geeft `external_player_only`, Tidal `unsupported_source`. `GET /api/playback/capabilities` voor de client.
- [x] **V04.2 · 2 dagen:** serverdispatch met verse URL per track, consistente metadata en duidelijke loading/playing/error-status na apparaatbevestiging.
      _Gedaan:_ `server-player.dispatch()` resolvet per poging opnieuw, stuurt met timeout (20 s) naar het apparaat, probeert maximaal twee keer en legt de uitkomst vast als `snapshot.dispatch` (`loading` → `playing` | `client` | `skipped` | `error`) met event `playback:dispatch`; de client toont skips en fouten als melding. Beleid voor onafspeelbare nummers: `PLAYBACK_UNPLAYABLE_POLICY=skip` (standaard, maximaal 3 achter elkaar, daarna stop met fout) of `stop`. Spotify op een speaker wordt aan de verbonden controller-tab gelaten; zonder verbonden tab telt het als onafspeelbaar.
- [x] **V04.3 · 2 dagen:** sessie-eigenaar opslaan, herstart/reconnect reconciliëren met apparaatstatus, timeouts en begrensde retries. Polling mag niet overlappen; langdurige uitval vereist een herstelpad.
      _Gedaan:_ migratie `0003_session_owner` (schemaversie 4): `owner_user_id`, `server_managed`. `reconcileAfterRestart()` vraagt na een herstart de speaker om zijn status: speelt nog → sessie blijft servergestuurd; idle → sessie gestopt met zichtbare reden (`restart`); alleen `PLAYBACK_RESUME_ON_RESTART=true` stuurt het actuele nummer opnieuw. Apparaatmonitor: geen overlappende polls per apparaat, statusverzoek time-out 5 s, en bij tien mislukte polls op een vastgezet apparaat meldt hij dit aan de serverspeler, die de sessie stopt in plaats van “playing” te blijven tonen.
- [x] **V04.4 · 2 dagen:** Spotify-contractcontrole inclusief playlistitems/403/429, browser- en providerfouten zichtbaar maken; geautomatiseerde plus echte apparaatacceptatie.
      _Gedaan:_ playlistinhoud via `/playlists/{id}/items` (februari 2026-vorm, `item`) met terugval naar `/tracks` bij 404/403, onthouden per proces; `SpotifyProviderError` met codes `spotify_rate_limited` (429 + `Retry-After`), `spotify_forbidden` (403, noemt Premium/Development Mode), `spotify_not_authenticated`; provider-routes geven die status door in plaats van 500. Contract- en routetests toegevoegd. Echte apparaatacceptatie (30 minuten, drie overgangen, Qobuz op speaker) moet op de NAS gebeuren.

**Acceptatie:**

- Een lokale en een gemengde lokaal/Qobuz-wachtrij spelen minimaal 30 minuten en drie overgangen door terwijl alle clients zijn gesloten. _Open: hardwaretest op de NAS (Sonos/DLNA + Qobuz-account). In code bewezen: dispatch van lokaal en Qobuz via één pad, servergestuurde advance zonder client (`server-player.test.ts`)._
- Een verlopen Qobuz-URL wordt opnieuw opgelost; ontbrekende rechten stoppen of slaan over volgens een expliciet, zichtbaar beleid. _Gehaald: tweede poging resolvet opnieuw (test “re-resolves (new url)”); beleid `skip`/`stop` met limiet, zichtbaar via `playback:dispatch` en toast._
- Bij apparaatuitval wordt geen fictieve “playing”-status vastgehouden en geen nummer onbeperkt opnieuw geprobeerd. _Gehaald: maximaal twee pogingen met timeout; monitor meldt onbereikbaarheid na tien polls en de sessie gaat naar `stopped` met `device_unreachable`._
- Een serverherstart herstelt de queue en herkent de uitvoerstatus; autoplay gebeurt alleen volgens vooraf gekozen herstelinstelling. _Gehaald: `reconcileAfterRestart()`-tests voor speler-speelt-nog, idle (gestopt, wachtrij intact) en `PLAYBACK_RESUME_ON_RESTART`._
- Spotify blijft via SDK/Connect werken; Tidal verschijnt niet als volledige playbackbron. _Gehaald: capabilities `spotify.externalPlayer = spotify-connect`, `tidal.browser = false`; de serverspeler laat Spotify aan de controller-tab._
- Als een apparaat directe Qobuz-HTTPS-URLs weigert, krijgt het die capability niet. Een providerproxy/transcoder wordt dan een afzonderlijke proef met beperkte scope. _Open: te bepalen op de NAS per speaker; bij weigering valt het beleid nu terug op skip/stop met zichtbare reden. Een proxy is niet gebouwd (E06)._

### V05 — Tijdstempels, geschiedenis en scrobbling herstellen

**Doel:** “geluisterd” heeft één betrouwbare betekenis.  
**Bevinding:** B06.

- [x] **V05.1 · 2 dagen:** tijdstempelstrategie in schema en writes corrigeren; migratie voor bestaande NULL-waarden met onderscheid tussen bekende en onbekende historische tijden.
      _Gedaan:_ elke Drizzle-tijdstempelkolom heeft nu een schemadefault (`$defaultFn`), want Drizzle schrijft een expliciete NULL voor een weggelaten kolom en de SQL-default vuurde nooit (test `timestamp-defaults.test.ts`). Migratie `0004_listening_sessions` (schemaversie 5) kopieert `play_history` naar `listening_sessions`; rijen zonder tijd houden `started_at = NULL`, worden als “Time unknown” getoond, sorteren achteraan en zijn nooit “recent”. Geen enkele oude tijd wordt verzonnen.
- [x] **V05.2 · 2 dagen:** luistersessies met echte track-/artiestinformatie en metadata-snapshot; externe nummers ondersteunen zonder verplichte verwijzing naar een lokaal bestand.
      _Gedaan:_ tabel `listening_sessions` met snapshot (titel, artiest, album, lokale ids waar bekend, duur, bron), UTC-starttijd, `listened_ms`, status en `qualified`; geen foreign key naar `tracks`, dus Qobuz/radio/Spotify en verdwenen bestanden houden hun geschiedenis. `services/listening.ts` wordt door `PlaybackService` aangeroepen via een geïnjecteerde `ListeningObserver` (zelfde patroon als de event-sink). De oude `recordPlay` uit client en serverplayer is verwijderd; `POST /history/played` is een no-op voor oude clients.
- [x] **V05.3 · 2 dagen:** werkelijk afgespeelde tijd en unieke scrobbleverwerking; pauze, seek, skip, retry en twee controllers correct behandelen.
      _Gedaan:_ luistertijd is bevestigde speeltijd: apparaatsamples van de device monitor, of `POST /api/playback/progress` elke 10 s vanuit een browser die zelf speelt; elk bevestigd interval is begrensd op 45 s (een verdwenen tab telt hooguit één keer die grens), pauze stopt de klok, seek en skip tellen niets, twee controllers tellen niet dubbel omdat een bevestiging alleen de tijd sinds de vorige crediteert. Kwalificatie volgens Last.fm (> 30 s en ≥ helft of ≥ 4 min). Scrobble-queue kreeg `session_id` met unieke index `(session_id, service)` en `INSERT OR IGNORE`; inzending draagt de starttijd. Radio scrobbelt nooit, Spotify alleen met `SCROBBLE_SPOTIFY=true`. Uitgeschakelde dienst houdt rijen pending in plaats van retries te verbranden; verzonden rijen na 30 dagen opgeruimd. Open sessies van een vorig proces worden bij start gesloten met de opgebouwde tijd.
- [x] **V05.4 · 2 dagen:** geschiedenis/statistieken op de nieuwe gegevens aansluiten; regressies en Last.fm/ListenBrainz-acceptatie uitvoeren.
      _Gedaan:_ `/history/tracks`, `/recent`, `/top-artists` lezen gekwalificeerde sessies (ISO-8601 of `null`), nieuw `GET /api/history/stats?days=` (luisterbeurten, geluisterde tijd, topnummers, topartiesten, per bron) met een blok “On this server” op de statistiekpagina naast ListenBrainz. Tests: `listening-sessions.test.ts` (regel, pauze/seek, skip/fout, dode client, twee controllers, één inzending per dienst, radio/Spotify-beleid, herstart, wezen), contracttest met NULL-tijd, client-heartbeattest. Echte Last.fm/ListenBrainz-inzending is NAS-acceptatie.

**Acceptatie:**

- Nieuwe relevante records krijgen een correcte UTC-tijd; onbekende oude tijden worden niet als verzonnen luistermomenten ingevuld. _Gehaald: schemadefaults plus migratie met `started_at = NULL` voor onbekende tijden; contracttest controleert ISO-8601 én `null`._
- Een mislukte play of onmiddellijke skip telt niet als gekwalificeerde luisterbeurt. _Gehaald: `markPlaybackFailed` → sessie `failed`; skip na 3 s → `ended`, niet gekwalificeerd, geen scrobble (test)._
- Pauzetijd en vooruitzoeken tellen niet mee als werkelijk geluisterde tijd. _Gehaald: alleen bevestigde speeltijd telt; test met 10 minuten pauze en een seek._
- Eén luistersessie leidt per scrobbledienst maximaal tot één inzending, ook na retries/reconnect. _Gehaald: unieke index `(session_id, service)`; tweede `scrobble()` voor dezelfde sessie is een no-op (test)._
- Lokale tracks en Qobuz krijgen geschiedenis met correcte artiest; Spotify-scrobbling is alleen actief met betrouwbare voortgang en beleid tegen dubbele inzending via Spotify zelf. _Gehaald in code: snapshot met artiestnaam en, voor lokaal, artiest-id uit de bibliotheek; Spotify wordt wel in de geschiedenis opgenomen maar pas gescrobbeld met `SCROBBLE_SPOTIFY=true`. Open: echte inzending naar Last.fm/ListenBrainz vanaf de NAS controleren._

### V06 — Bibliotheekbehoud en inzicht in scans

**Doel:** muziekbestanden kunnen veranderen zonder stil verlies van gebruikersgegevens.  
**Bevindingen:** B07, B14.

- [x] **V06.1 · 2 dagen:** bronlocatie en trackidentiteit scheiden; mtime/bestandsgrootte expliciet opslaan. Scanversie of force-rescan toevoegen voor nieuwe metadataregels.
      _Gedaan:_ de rij-id is de identiteit, `file_path` alleen de huidige locatie. Nieuwe kolommen `file_size`, `file_mtime`, `fingerprint` (sha1 van grootte, duur in ms, titel, artiest, album, track- en discnummer), `scan_version`, `availability`, `missing_since` als idempotente ALTER-backfills plus migratie `0005_library_identity` (schemaversie 6). Onveranderd = zelfde grootte én mtime; `SCAN_VERSION`-bump of `POST /api/library/scan?force=true` (“Full rescan” in Settings) leest alles eenmalig opnieuw.
- [x] **V06.2 · 2,5 dag:** verplaatsingen veilig herkennen en ontbrekende items markeren; herstel/koppelactie voor twijfelgevallen. History en playlists behouden als een bestand verdwijnt.
      _Gedaan:_ een bestand op een nieuw pad wordt aan een bestaande track gekoppeld als precies één rij dezelfde vingerafdruk heeft én het oude bestand weg is; playlists, favorieten en geschiedenis volgen de id. Twee kandidaten of een oud bestand dat er nog staat: nieuw, geteld als twijfelgeval. Zelfde titel/artiest is nooit bewijs. Verdwenen bestanden onder een leesbare root worden `missing` (met tijdstip), niets wordt verwijderd; onleesbare roots of submappen markeren niets; teruggekomen bestanden herstellen vanzelf. `GET /api/library/missing` met sterke/zwakke kandidaten, `POST /missing/:id/relink`, `POST /missing/purge` (admin, de enige verwijdering). Stream van een ontbrekend bestand geeft 404 `TrackMissing`; albumpagina toont het gedimd met label. Albumfavoriet volgt een verplaatste albummap bij een eenduidige erfgenaam.
- [x] **V06.3 · 1,5 dag:** scan*runs met start/einde, roots, fouten en tellingen opslaan; UI toont ontbrekende roots en laatst geslaagde scan. Watcherconfiguratie ook via Compose doorgeven.
      \_Gedaan:* tabel `scan_runs` (roots, geslaagde en mislukte roots met mislukte mappen, tellingen nieuw/gewijzigd/verplaatst/ontbrekend/hersteld/fouten, trigger, geforceerd, tijden, uitkomst). `GET /api/library/scan/runs`, `/scan/status` met laatste geslaagde run en geconfigureerde roots, `/api/health.lastScanAt` uit echte runs (niet meer `MAX(created_at)`). Onderbroken runs worden bij start als mislukt gesloten. Settings toont “Last successful scan”, onbereikbare roots, ontbrekende bestanden met koppelknop en “Clean up missing”. `WATCH_LIBRARY` via `docker-compose.yml` en `.env.example`; watcher-scans dragen trigger `watcher`.
- [x] **V06.4 · 2 dagen:** echte migratie van een oudere databasestructuur, UNC-/NAS-foutscenario's en terugzetten van back-up testen.
      _Gedaan:_ `legacy-db-migration.test.ts` bouwt de structuur van de eerste releases na (geen Drizzle-journal, `users` zonder rol, `tracks` zonder identiteitskolommen, history zonder tijd, UNC-pad `//diskstation/...`) met data en controleert na `initDatabase` schemaversie 6, alle kolommen en tabellen, behoud van bibliotheek/account/favorieten/playlist, gekopieerde geschiedenis zonder verzonnen tijden en een tweede start zonder herhaling. Scannertests dekken onbereikbare root, onleesbare submap (permissies), ontbrekend-in-plaats-van-verwijderd, purge, verplaatsing met behoud van id, twijfelgevallen, herstel, skip/force/versie, scan-runs. Back-up terugzetten blijft gedekt door `db-backup.test.ts`; de bestaande restore-test leest ook luistersessies terug.

**Acceptatie:**

- Verplaatsen/hernoemen van een aantoonbaar identiek bestand behoudt favorieten, playlistposities en geschiedenis. _Gehaald: test “a moved file keeps its identity” (vingerafdrukmatch, oud bestand weg)._
- Twijfelachtige matches worden niet automatisch samengevoegd. _Gehaald: zelfde titel met andere duur blijft nieuw (zwakke kandidaat), twee identieke kandidaten blijven aan de admin (test)._
- Onbereikbare root of submap veroorzaakt geen verlies van bestaande items. _Gehaald: tests met onbereikbare root en met onleesbare submap; niets wordt gemarkeerd of verwijderd._
- Een echt verwijderd bestand blijft herkenbaar als niet beschikbaar totdat een expliciete opschoonactie volgt. _Gehaald: `availability = 'missing'` tot `POST /missing/purge`; UI toont het gedimd met “missing” (test)._
- Een volledig geslaagde scan zonder nieuwe bestanden actualiseert de scandatum.
- Beschadigde metadata blokkeert de scan niet blijvend; annuleren of herstarten heeft een gedocumenteerd gedrag.

### V07 — Zoeken, albumversies en bronkeuze

**Doel:** de gebruiker vindt het gewenste nummer en weet welke versie kan afspelen.  
**Bevindingen:** B08, B09.

- [x] **V07.1 · 2 dagen:** bronverwijzingen en editiegegevens bewaren; Unicode-veilige deduplicatie zonder verlies van live-/studio-/remasterversies.
      _Gedaan:_ `normalizeSearchKey` houdt letters en cijfers van elk schrift (`\p{L}\p{N}`), verwijdert accenten en leestekens; verschillende Japanse of Cyrillische namen krijgen dus verschillende sleutels. Nieuwe velden `version` (uit Qobuz/Tidal of geparseerd uit titelsuffixen als “(Live)”, “[2011 Remaster]”, “- Radio Edit”), `alternatives[]` met per bron het eigen item-id, album-id, versie en kwaliteit; `availableOn` blijft voor oude clients. Samenvoegen alleen bij gelijke artiest + basistitel + editiesleutel + duur binnen 10 s.
- [x] **V07.2 · 2 dagen:** filters op bron, genre en audioformaat/kwaliteit; zoekresultaten met expliciete speelbaarheid en bronkeuze.
      _Gedaan:_ `services/search.ts` voegt per track `playability` toe uit dezelfde resolver die afspeelt (browser/server/extern/playable/reden; ontbrekend bestand = `missing-file`) en past filters `sources`, `quality=lossless|hires`, `format` toe. Zoekpagina: bronchips, kwaliteitsfilter, versie- en missing-badges, “▶ qobuz”-knoppen die dezelfde opname vanaf een andere bron starten met het eigen id van die bron. Genrefilter is bewust niet gebouwd: streamingbronnen leveren geen genre bij zoekresultaten en lokaal genre zit al op de albumpagina's; opgenomen in §7 als optioneel.
- [x] **V07.3 · 2 dagen:** lokale zoekbenchmark, rangschikking en geschikte indexen; FTS5 alleen invoeren als de gemeten winst dit rechtvaardigt.
      _Gedaan:_ `services/local-search.ts`: exact > prefix > bevat > ander veld, NOCASE-indexen op `tracks.artist_name`, `tracks.album_title`, `albums.artist_name`, LIKE-jokers ontsnapt, ontbrekende bestanden achteraan. `npm run bench:search` (50.000 synthetische tracks, ook niet-Latijnse namen, 200 rondes): p95 exact 15,5 ms, prefix 18,2 ms, bevat 19,4 ms, artiest 15,6 ms, versiewoord 19,1 ms op de ontwikkelcontainer. Ruim onder 300 ms, dus **geen FTS5**; besluit pas herzien na een meting op de NAS.
- [x] **V07.4 · 2 dagen:** provider-timeouts, gedeeltelijke resultaten en lege/foutstatussen; tests op edities, niet-Latijnse namen en trage bronnen.
      _Gedaan:_ `searchAll` geeft elke bron hetzelfde tijdbudget (`SEARCH_PROVIDER_TIMEOUT_MS`, standaard 6000, ook via Compose); uitkomst per bron in `sources[]` (ok/timeout/error/unavailable met ms en fout), de UI noemt onbereikbare bronnen boven de resultaten. Tests: `registry.test.ts` (accenten, schriften, titelversies, editiesleutels, duurverschil), `search-service.test.ts` (ranking, jokers, filters, speelbaarheid, optieparsing, trage én kapotte provider naast lokale resultaten, bronselectie met eigen id).

**Acceptatie:**

- Studio- en liveversies blijven afzonderlijk bereikbaar; verschillende niet-Latijnse titels verdwijnen niet door een gelijke lege sleutel. _Gehaald: tests “keeps studio, live and remastered versions apart” en “keeps letters of every script”._
- Alternatieve bronkeuze gebruikt het juiste provider-item-ID en behoudt de gekozen versie. _Gehaald: `alternatives[]` per bron; de zoekpagina start het alternatief met dat id en dezelfde versie (test “selected sources … own id”)._
- Een defecte provider blokkeert lokale resultaten niet; de UI noemt de onbereikbare bron. _Gehaald: test met nooit antwoordende Qobuz (timeout) en falende Spotify (error) naast lokale treffers; statusregel in de UI._
- Streefwaarde: lokale zoekrespons p95 onder 300 ms bij 50.000 tracks, gemeten op vastgelegde NAS-hardware en dataset. _Gehaald, gemeten op de NAS (Synology, container, 50.000 tracks, 100 rondes, 9 sep 2026): p95 exact 41,0 ms, prefix 50,8 ms, bevat 50,2 ms, artiest 43,5 ms, versiewoord 44,6 ms; max 66,3 ms. Ontwikkelcontainer: p95 < 20 ms._
- De bestaande paginering/lazy loading blijft werken; virtualisatie alleen toevoegen bij aangetoonde weergaveproblemen. _Gehaald: zoekresultaten blijven op limit 20/50; geen virtualisatie toegevoegd._

### V08 — Mobiele bediening en betrouwbare webapp

**Doel:** de app is dagelijks bruikbaar op telefoon/tablet en herstelt begrijpelijk van netwerk- en updateproblemen.  
**Bevindingen:** B02, B13; afronding basisroute.

- [ ] **V08.1 · 2 dagen:** versievaste shellcache, offlinepagina en veilige updateflow; cache alleen eigen resources en begrens artworkopslag.
- [ ] **V08.2 · 2 dagen:** begeleide eerste ervaring: bibliotheekstatus, bronverbinding en gekozen uitvoer met korte fout-/herstelmeldingen.
- [ ] **V08.3 · 2 dagen:** visuele en toegankelijkheidstest van zoeken → album → wachtrij → uitvoer → instellingen; labels, focus, contrast en touchbediening herstellen waar nodig.
- [ ] **V08.4 · 2 dagen:** browseracceptatie op Android/Chrome en iOS/Safari, achtergrond/voorgrond, tokenvernieuwing en twee opeenvolgende releases; beknopte beheerdiagnostiek toevoegen.

**Acceptatie:**

- Na één succesvol bezoek blijft bij verbroken netwerk een bruikbare app-shell of uitleg beschikbaar, zonder onbehandelde service-workerfout.
- Een nieuwe release veroorzaakt geen witte pagina door oude HTML/nieuwe assets.
- Offline status belooft geen offline audiocache; lopende NAS-playback wordt bij reconnect correct weergegeven.
- Aanmelding, playback en wachtrij zijn met toetsenbord en schermlezerlabels te bedienen; essentiële mobiele knoppen hebben voldoende aanraakruimte.
- Een geweigerde browser-playpromise/autoplay leidt tot een herhaalactie, niet tot een vals “speelt”-signaal.
- Diagnostische export bevat versie en fout-/scanstatus, maar geen tokens, wachtwoorden of onnodige persoonlijke paden.

### V09 — Persoonlijke profielen

**Doel:** meerdere gebruikers hebben een eigen muziekomgeving boven dezelfde collectie.  
**Keuzemoment:** uitvoeren als de app door meerdere mensen wordt gebruikt.  
**Bevinding:** B10.

- [ ] **V09.1 · 2 dagen:** userId/eigendom aan persoonlijke gegevens toevoegen; bestaande gedeelde data gecontroleerd als huishoudcollectie behouden of aan een gekozen eigenaar koppelen.
- [ ] **V09.2 · 2 dagen:** toegang tot playlists, favorieten, history, stats en slimme playlists consequent per gebruiker afhandelen; expliciet delen ondersteunen of voorlopig uitsluiten.
- [ ] **V09.3 · 2 dagen:** persoonlijke scrobbleconfiguratie en bijbehorende cache-/retry-isolatie. Globale muziekproviders blijven zichtbaar als beheerde huishoudverbinding.
- [ ] **V09.4 · 2 dagen:** accounts wisselen, data-overdracht bij verwijderen en privacyregressies op API, UI en sockets testen.

**Acceptatie:**

- Gebruiker A kan persoonlijke gegevens van B niet lezen of wijzigen via een geraden ID.
- Luistergegevens en scrobbles blijven gescheiden, ook bij mislukte inzendingen en opnieuw verbinden.
- Migratie verliest geen bestaande playlists/favorieten; eigenaar en eventuele gedeelde status zijn zichtbaar.
- Browsercache en sessiewissel tonen geen persoonlijke gegevens uit een vorige aanmelding.
- Persoonlijke Spotify/Qobuz-accounts zijn geen verborgen onderdeel van deze sprint; daarvoor volgt apart ontwerp indien gewenst.

### V10 — Afzonderlijke wachtrij per zone

**Doel:** verschillende kamers kunnen onafhankelijk worden bediend.  
**Keuzemoment:** minimaal twee daadwerkelijk gebruikte uitvoerapparaten beschikbaar.  
**Bevinding:** B11.

- [ ] **V10.1 · 2,5 dag:** zones en afspeelsessies modelleren; singleton playbackstate/queue omzetten naar per-zone opslag.
- [ ] **V10.2 · 2 dagen:** dispatch, monitor, events en toegang aan de juiste zone koppelen; één apparaat kan niet onbedoeld twee actieve zones bezetten.
- [ ] **V10.3 · 1,5 dag:** zonekiezer met eigen wachtrij/status/volume en herkenbare gedeelde bediening.
- [ ] **V10.4 · 2 dagen:** gelijktijdig luisteren, tweede controller, offline apparaat en herstart testen op twee outputs.

**Acceptatie:**

- Twee kamers spelen verschillende wachtrijen; pause/next/volume in kamer A verandert B niet.
- Een client bedient de gekozen zone en krijgt na reconnect de juiste snapshot.
- Een apparaatfout blijft binnen de eigen zone.
- Bestaande Sonos-topologie blijft correct zichtbaar; dit levert nog geen nieuw groepsprotocol of gegarandeerd gesynchroniseerde gemengde DLNA-groep.
- Native groeperen en “verplaats muziek naar andere kamer” blijven een aparte vervolgtaak E04.

### V11 — Trackovergangen en audiopad

**Doel:** hoorbare kwaliteit verbeteren en beperkingen eerlijk tonen.  
**Bevinding:** B12.

- [ ] **V11.1 · 1,5 dag:** capabilities per output: ondersteunde formaten, seek, next-URI, ReplayGain, gapless en bekende limieten.
- [ ] **V11.2 · 2,5 dag:** browservoorbereiding en daadwerkelijke overname van het volgende element/buffer; crossfadefouten en promises correct afhandelen.
- [ ] **V11.3 · 2 dagen:** servergestuurde next-URI voor ondersteunde apparaten; unsupported/failed teruggeven als expliciete status.
- [ ] **V11.4 · 2 dagen:** audiopad tonen en testovergangen opnemen/meten op de gekozen referentieoutputs.

**Acceptatie:**

- Referentietracks met aaneengesloten audio gaan twintigmaal achtereen over zonder herstart, dubbele dispatch of overslaan.
- Gebruik “gapless geverifieerd” uitsluitend voor bron/outputcombinaties waarvan de opgenomen grens geen toegevoegde pauze of ontbrekende audio laat zien.
- Bij overige combinaties wordt de gemeten overgangsduur vastgelegd en de beperking benoemd.
- Het audiopad toont bronformaat, eventuele verwerking/conversie, uitvoerroute en onbekende stappen. Bron-FLAC is geen bewijs voor bit-perfect-uitvoer.
- Volledige continue serverstreaming/transcoding is geen stilzwijgende scope-uitbreiding: eerst een proef met één codec/apparaat en NAS-CPU-meting; daarna apart plannen.

### V12 — Gemengde playlists en bruikbaarder ontdekken

**Doel:** meer muziek vinden en bewaren vanuit de bestaande lokale/Qobuz-ervaring.  
**Keuzemoment:** basis betrouwbaar, gebruiker wil daadwerkelijk meer ontdekfuncties.

- [ ] **V12.1 · 2,5 dag:** playlistitems met stabiele bronreferentie en metadata-snapshot; lokale en Qobuz-nummers in dezelfde playlist, inclusief tijdelijk niet-beschikbare items.
- [ ] **V12.2 · 2 dagen:** bestaande ListenBrainz-aanbevelingen uitbreiden met direct afspeelbare matches en “waarom deze aanbeveling?”; lokale mix mogelijk zonder externe accountverbinding.
- [ ] **V12.3 · 1,5 dag:** shuffle zonder herhaling binnen één ronde; keuze voor minder recent gehoorde tracks en uitsluiten van onbeschikbare bronnen.
- [ ] **V12.4 · 2 dagen:** opslaan/afspelen van een ontdekmix, bronuitval en profielscheiding testen; effect met de gebruiker beoordelen.

**Acceptatie:**

- Een gemengde lokaal/Qobuz-playlist blijft na herstart identiek en vraagt tijdelijke stream-URLs pas bij playback op.
- Een aanbeveling zonder zekere match start geen toevallig gelijknamig nummer.
- Een shuffle-ronde herhaalt geen wachtrijpositie zolang repeat uit staat.
- De basis van aanbevelingen is zichtbaar en kan worden uitgezet.
- Bestaande M3U-import/export blijft werken voor ondersteunde lokale verwijzingen; externe items krijgen een expliciete exportbeperking.

## 7. Optionele backlog na de gekozen sprints

| ID  | Voorstel                                   | Voorwaarde en beperkte eerste stap                                                                                                                                                | Eerste indicatie                      |
| --- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| E01 | Sleeptimer / stoppen na album              | Na V04; server voert timer uit, ook bij gesloten client. UI kan timer annuleren; test per zone als V10 bestaat.                                                                   | 1–3 dagen                             |
| E02 | OpenSubsonic                               | Na betrouwbare auth/profielen; eerst authenticatie, browse, zoek en lokale stream naar één bestaande mobiele client. Beslis daarna over volledige compatibiliteit.                | Proef 3–5 dagen; productisering apart |
| E03 | Extra apparaatprotocol of Home Assistant   | Inventariseer concrete thuisapparatuur. Kies één integratie, één referentieapparaat en een terugvalroute.                                                                         | Proef 2–5 dagen; productisering apart |
| E04 | Sonos-groeperen en muziekoverdracht        | Na V10/V11; voeg seek en native groepshandelingen alleen toe waar ondersteund. Geen cross-protocol-syncbelofte.                                                                   | 1–2 vervolgsprints                    |
| E05 | Klassieke muziek en metadata-editor        | Composer/conductor bestaan al; werk/deel, meerdere uitvoerenden en herstelbare metadata-overrides toevoegen als de collectie dat vraagt. Eerst alleen wijzigingen in de database. | 1–2 vervolgsprints                    |
| E06 | Transcoding / mobiele bandbreedteprofielen | Na V11; één lokaal codecprofiel, limiet op gelijktijdige conversies en NAS-belasting meten. Externe diensten alleen via toegestane mogelijkheden.                                 | Proef 3–5 dagen; productisering apart |
| E07 | Muziek offline meenemen                    | Kies eerst tussen eigen PWA-downloads en bestaande mobiele clients via E02. Begin uitsluitend met lokale bestanden, quota en expliciete verwijdering.                             | Apart ontwerp                         |

## 8. Richting voor de technische uitwerking

Deze keuzes voorkomen dat nieuwe functies dezelfde problemen terugbrengen:

- **PlaybackSession:** queue, huidige queueItemId, revisie, eigenaar, output en transportstatus horen bij één sessie. Vanaf V10 hangt die aan een zone. Tijdens de eerste migratie kan één bestaande huishoudzone de huidige data behouden.
- **TrackReference:** bron + bron-ID + versiegegevens, met optionele koppeling aan een lokaal bibliotheekitem. Tijdelijke stream-URL's zijn geen blijvende trackidentiteit.
- **PlaybackResolver:** kiest op het moment van afspelen de ondersteunde route. Maak onderscheid tussen een directe audiostream en een externe speler zoals Spotify Connect.
- **ListeningSession:** starttijd, werkelijk beluisterde duur en een unieke verwerkingssleutel. Het resultaat voedt geschiedenis, statistieken en scrobblequeue.
- **LibrarySource / ScanRun:** bronpad en scanresultaat staan los van trackidentiteit en persoonlijke gegevens.
- **Grenzen tussen modules:** apparaat-I/O, bronresolutie, queuebeheer en events via duidelijke afhankelijkheden verbinden. De huidige circulaire importketen is een concreet argument voor deze scheiding.
- **Frontend:** behoud de bestaande progress-store en lazy geladen pagina's. Splits AudioContext en SettingsPage alleen langs deze verantwoordelijkheden; hun huidige omvang van respectievelijk circa 815 en 951 regels is een onderhoudssignaal, geen zelfstandig reden voor een herschrijving.
- **Opslag:** bestaande SQLite/Drizzle behouden. Nieuwe migraties versieerbaar en transactioneel waar mogelijk; bij grotere wijzigingen eerst een kopie van een oude database migreren en controleren.
- **Uitrol:** wijzigingen aan queue-/socketcontracten moeten oude clients herkennen of een expliciete verversing vragen. Laat geen oude browser nieuwe persistente data stilzwijgend overschrijven.

## 9. Acceptatie, meetpunten en beslismomenten

### Vast testmateriaal

Leg in V01 een kleine versieerbare testcollectie met eigen/rechtenvrije of gegenereerde audio vast: MP3, FLAC, gemengde sample rates, album met herhaalde track, multi-disc, compilatie, ReplayGain, Unicode-metadata, ontbrekende cover en beschadigde metadata. Voeg fixtures voor een oude database, provider-timeouts en mislukte apparaatopdrachten toe.

Voor hardwareacceptatie: leg NAS-model, geheugen, Node/imageversie, gebruikte speler/firmware, netwerkroute en bronkwaliteit vast. Plan de beschikbaarheid van hardware/accounts vóór V04 en V11; credentials horen niet in testlogs of fixtures.

### Meetpunten

Dit zijn **voorgestelde doelen**, geen al behaalde resultaten.

| Onderwerp              | Streefwaarde of controle                                                                                    | Vanaf                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------ |
| Wachtrij               | Geen overslaan/dubbel starten in scenario's met herhaling, twee clients en retries                          | V03                      |
| Clientreconnect        | Binnen 3 seconden na verbinding weer de juiste snapshot op hetzelfde LAN                                    | V03                      |
| Zelfstandig doorspelen | Minimaal 30 minuten gemengd lokaal/Qobuz zonder actieve clients; vóór stabiele release een sessie van 2 uur | V04                      |
| Luistergegevens        | Geen dubbele scrobbles; geen NULL-tijd voor nieuwe relevante records                                        | V05                      |
| Bibliotheekwijziging   | Geen verlies van favorieten/history/playlistposities in verplaatsingsscenario's                             | V06                      |
| Zoeken                 | p95 onder 300 ms lokaal op 50.000 tracks, of afwijking met gemeten bottleneck en vervolgactie               | V07                      |
| Mobiele webapp         | Eerste bruikbare weergave streefwaarde onder 2,5 seconden op vastgelegd toestel/netwerk                     | V08                      |
| Zones                  | Geen status- of opdrachtlekkage tussen twee gelijktijdige kamers                                            | V10                      |
| Audio-overgangen       | Meting per bron/output; label alleen wat werkelijk is aangetoond                                            | V11                      |
| Herstel                | Restore uitvoerbaar via runbook; tijd meten op representatieve database                                     | V01 en elke datamigratie |

### Definitie van afgerond

Een sprint is pas afgerond wanneer:

- De beschreven gebruikersuitkomst en alle acceptatiecriteria aantoonbaar zijn gehaald.
- Relevante regressietests en de bestaande kwaliteitscontroles slagen.
- Gewijzigde API-/socketcontracten, migraties en instellingen zijn gedocumenteerd.
- Bij opslagwijzigingen een migratie én herstel op testdata zijn uitgevoerd.
- Hardwarecriteria daadwerkelijk op hardware zijn getest; anders blijft de sprint **wacht op acceptatie**, niet “DONE”.
- Resterende afwijkingen een eigenaar, impact en volgende actie hebben.

### Beslismomenten

- **Na V02:** veilige en herhaalbare basis; door naar playback.
- **Na V04:** gebruikstest “tablet dicht, album blijft spelen”. Zonder dit resultaat geen grotere audio-uitbreiding.
- **Na V06:** gegevensbehoud en luistercijfers betrouwbaar; daarna verbeteren van zoeken/aanbevelingen.
- **Na V08:** bruikbare basisrelease. Kies expliciet welke van V09–V12 de meeste waarde hebben.
- **Na V11:** bepaal op basis van metingen of extra transcoding/flow-mode de NAS-belasting en complexiteit waard is.

## 10. Eerste uitvoeringsopdracht

**Start met V01.** Leg de huidige 234 geslaagde tests vast als uitgangspunt, herstel de ontbrekende geautomatiseerde releasecontrole, beoordeel de 19 actuele dependencybevindingen en bewijs een schone installatie plus restore. Gebruik daarna dit document per sprint als werkopdracht en werk status, meetresultaten en resterende afwijkingen in dit bestand bij.

De functionele broncode is tijdens deze analyse niet aangepast. Er zijn geen live afspeelapparaten aangestuurd en geen provideraccounts gewijzigd.

## 11. Uitvoeringslog

### V01 — 8 september 2026

Uitgevoerd op branch `claude/verbeterplan-sprints-uitvoering-tdav7i`, omgeving Linux-container met Node 22.22 (productieversie), zonder Docker-daemon en zonder toegang tot NAS, apparaten of provideraccounts.

| Controle                 | Uitgangspunt (7 sep)                      | Na V01 (8 sep)                                                                    |
| ------------------------ | ----------------------------------------- | --------------------------------------------------------------------------------- |
| Servertests              | 150 tests, 24 bestanden                   | 158 tests, 26 bestanden (smoke-test, back-up/restore, versieguard, readiness)     |
| Clienttests              | 84 tests, 17 bestanden                    | 84 tests, 17 bestanden                                                            |
| Lint / typecheck / build | groen                                     | groen (ook na music-metadata 11 en drizzle 0.45)                                  |
| `npm audit --omit=dev`   | 19 pakketten (11 high, 6 moderate, 2 low) | 2 pakketten (2 high, beide `node-ssdp → ip`, beoordeeld)                          |
| CI-workflow              | ontbrak                                   | `.github/workflows/ci.yml`, Node 22 + 24 + productie-image                        |
| Readiness                | `/api/health` altijd 200                  | `/api/health/ready` 200/503, `/api/health` 503 bij degraded, HEALTHCHECK op ready |
| Back-up/restore          | geen procedure                            | scripts + runbook + geautomatiseerde restore-test                                 |
| Browserslist             | circa zes maanden oud                     | bijgewerkt                                                                        |

**Eerste CI-run op deze branch (run 50, 8 sep 2026):** groen. Verify Node 22 in 1 min 12 s, Node 24 in 1 min 53 s; productie-image gebouwd en gestart in 5 min 15 s, `/api/health/ready` na 3 s, Docker HEALTHCHECK `healthy` na 4 s, `docker stop` eindigt met exitcode 0 en “Shutdown complete” in het log.

**Wacht op acceptatie (NAS):** restore van een back-up van de echte database op de NAS met tijdmeting; volledige bibliotheekscan met music-metadata 11 zonder verlies van tracks; Sonos/DLNA-discovery en Qobuz-playback na de dependency-upgrades. Pas daarna is V01 “DONE” volgens §9.

**Beslismoment na V02** blijft staan; V02 kan starten.

### V02 — 8 september 2026

Zelfde branch en omgeving als V01.

| Controle                   | Na V01                        | Na V02                                                                        |
| -------------------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| Servertests                | 158 tests, 26 bestanden       | 194 tests, 27 bestanden (setup, rechtenmatrix, sessies, socketintrekking)     |
| Clienttests                | 84 tests, 17 bestanden        | 89 tests, 18 bestanden (`AuthContext`)                                        |
| Lint / typecheck / build   | groen                         | groen                                                                         |
| Publiek bij nul gebruikers | alle API-routes               | setup-status, login/logout/register, `/auth/me`, probes, OpenAPI, CSP-rapport |
| Admin-only routes met test | 3 (gebruikersbeheer)          | 24, gedocumenteerd in `docs/permissions.md`                                   |
| Sessies                    | JWT 30 dagen, niet intrekbaar | serverside sessies, intrekbaar, socket en streamtoken volgen                  |
| CSP                        | uit                           | report-only, 0 overtredingen in browserflow                                   |
| Schemaversie               | 1                             | 2 (`sessions`)                                                                |

**Gedragswijzigingen voor de gebruiker:** eenmalig opnieuw inloggen na de update; `GET /api/health` vereist nu een token (`/live` en `/ready` blijven publiek); registratie is alleen nog de eerste setup met code.

**Wacht op acceptatie (NAS):** setup op een verse container met de code uit `docker logs`; CSP-rapporten bekijken tijdens Spotify Web Playback en OAuth-callbacks voordat de policy afdwingend wordt; Sonos/DLNA-weergave met het `system`-streamtoken.

**Beslismoment na V02:** basis is veilig en herhaalbaar; V03 (wachtrij als één afspeelsessie) kan starten.

### V03 — 8 september 2026

Zelfde branch en omgeving als V01/V02.

| Controle                     | Na V02                                              | Na V03                                                                            |
| ---------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------- |
| Servertests                  | 194 tests, 27 bestanden                             | 212 tests, 28 bestanden                                                           |
| Clienttests                  | 89 tests, 18 bestanden                              | 94 tests, 18 bestanden                                                            |
| Lint / typecheck / build     | groen                                               | groen                                                                             |
| A → B → A → C                | index springt terug naar 0                          | vier posities, herstart herstelt de tweede A                                      |
| Wachtrij-eigenaar            | client-lokaal (browser) of server (extern apparaat) | altijd de server; clients spiegelen met revisie                                   |
| Verouderde bewerking         | stil toegepast op oude weergave                     | 409 + verse snapshot, client past toe en meldt                                    |
| Retry                        | dubbel item                                         | `commandId`: één keer toegepast                                                   |
| Oude pagina zonder client-id | overschrijft wachtrij                               | 426, vraagt herladen                                                              |
| Reconnect                    | geen snapshot                                       | `playback:snapshot` bij connect en `playback:sync`                                |
| Andere tab                   | startte audio mee                                   | spiegelt alleen                                                                   |
| Schemaversie                 | 2                                                   | 3 (`queue_items.item_id`, `metadata`; `playback_state.queue_item_id`, `revision`) |

**Gedragswijzigingen voor de gebruiker:** shuffle/repeat gelden nu voor de hele huishoudsessie (server), niet per tab; een tweede tab of telefoon toont dezelfde wachtrij en volgt wijzigingen live, maar speelt niet vanzelf mee; na de update de app één keer herladen (oude pagina krijgt de melding).

**Uitrol op de NAS (8 september 2026, avond):** `master` fast-forward naar 42fa0c0; archief via `scp -O` (Synology heeft SFTP uit); back-up van de oude database via de SQLite-backup-API in de oude container (het script `db:backup` bestond daar nog niet); image gebouwd, `/api/health/ready` gaf `schemaVersion: 3`. Bevinding: de NAS-installatie had nog nooit een account (de oude versie liet zonder account alles toe), dus het setupscherm verscheen en de admin is met de setupcode aangemaakt. Eerste keer dat een echte database door de migraties 0001–0002 en de versiecontrole ging: zonder fouten.

**Wacht op acceptatie (NAS):** album op Sonos/DLNA starten vanaf tablet, tablet dicht, tweede apparaat opent de wachtrij en verwijdert een nummer; Qobuz-track in gemengde wachtrij op extern apparaat (controller-tab speelt); scenario met twee tabs op dezelfde browser-output.

**Beslismoment na V04** blijft; V04 (NAS speelt lokaal én Qobuz zelfstandig) kan starten.

### V04 — 9 september 2026

Zelfde branch en omgeving als V01–V03.

| Controle                     | Na V03                                         | Na V04                                                                                |
| ---------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| Servertests                  | 212 tests, 28 bestanden                        | 242 tests, 31 bestanden (resolver, serverspeler, herstart, monitor, Spotify-contract) |
| Clienttests                  | 94 tests, 18 bestanden                         | 94 tests, 18 bestanden                                                                |
| Lint / typecheck / build     | groen                                          | groen                                                                                 |
| Bronresolutie voor apparaten | alleen lokaal, verspreid over client en server | één resolver: lokaal, Qobuz (verse URL), radio; Spotify/Tidal expliciet uitgesloten   |
| Dispatchstatus               | alleen logregels                               | `snapshot.dispatch` + `playback:dispatch`, toasts bij skip/fout                       |
| Onafspeelbaar nummer         | wachtrij viel stil                             | `skip` (max 3) of `stop`, zichtbaar                                                   |
| Apparaat onbereikbaar        | sessie bleef “playing”                         | sessie gestopt met `device_unreachable`                                               |
| Herstart                     | wachtrij hersteld, status aangenomen           | speaker bevraagd; alleen met instelling opnieuw starten                               |
| Polling                      | kon overlappen, geen time-out                  | één poll per apparaat tegelijk, 5 s time-out                                          |
| Spotify-fouten               | 500 met tekst                                  | 429 + Retry-After, 403 met reden, 401                                                 |
| Schemaversie                 | 3                                              | 4 (`owner_user_id`, `server_managed`)                                                 |

**Nieuwe instellingen:** `PLAYBACK_UNPLAYABLE_POLICY` (skip/stop) en `PLAYBACK_RESUME_ON_RESTART` (true/false) in `.env`, `docker-compose.yml` en `.env.example`.

**Wacht op acceptatie (NAS):** de 30-minutentest met drie overgangen op Sonos/DLNA zonder clients, eerst lokaal, daarna gemengd lokaal/Qobuz (vereist ingelogd Qobuz-account op de NAS); controleren of de speaker directe Qobuz-HTTPS-URL’s accepteert; een herstart tijdens weergave (`docker-compose restart`) en kijken of de sessie “speelt nog” meldt; Spotify-playlist openen om te zien welk endpoint de app-modus gebruikt (logregel “falling back to /tracks”).

**Bevinding op de NAS (9 september 2026, ochtend):** het aanmaken van het admin-account op de NAS (V01–V03-build 42fa0c0) gaf “api error 502”. Rechtstreeks op poort 3001: `curl: (52) Empty reply from server` na 0,85 s, de container herstartte en de setupcode wisselde bij elke poging (0134-04E8 → 69AF-A3A4 → EFBB-3F7B), in de log staat `Node.js v22.22.2` als staart van een stacktrace. Lokaal in productiemodus met verse database slaagt dezelfde registratie in 0,35 s. Structurele oorzaak: 64 async-routehandlers stonden onverpakt op Express 4, waardoor elke fout na een `await` een unhandled rejection is en Node het proces beëindigt. Fix op de featurebranch: alle async-handlers in `asyncHandler`, `unhandledRejection` logt en gaat door, `uncaughtException` logt en stopt; regressietest `async-routes.test.ts` bewaakt dat er geen onverpakte async-handler meer bijkomt. De eigenlijke exception, daarna uit `docker logs` gelezen: `SqliteError: table users has no column named role`. De NAS-database dateert van vóór de rollen; de tabel `users` heeft daar alleen `id, username, password_hash, created_at`, en `CREATE TABLE IF NOT EXISTS` in migratie 0000 laat zo'n tabel staan. Fix: backfill `users.role` bij het opstarten (oudste account wordt admin als er al accounts zijn zonder rol), getest met een nagebouwde legacy-database. Tweede bevinding uit dezelfde log: `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` van express-rate-limit, de Synology reverse proxy zet `X-Forwarded-For` terwijl `trust proxy` uit stond, waardoor alle bezoekers één rate-limit-emmer deelden. Nieuwe instelling `TRUST_PROXY` (standaard `loopback`). Les voor §4 (compatibiliteit): een `CREATE TABLE IF NOT EXISTS`-migratie bewijst niets over de kolommen van een bestaande tabel; de startup-smoketest draait op een verse database en zag dit dus niet.

**Beslismoment na V04:** de gebruikstest “tablet dicht, album blijft spelen” is nu de eerste NAS-taak. Zolang die niet is gedaan, geen grotere audio-uitbreiding (V11) starten; V05 (luistergegevens) hangt er niet van af en kan door.

### V05 — 9 september 2026

**Uitgevoerd:** V05.1–V05.4 volledig in code, 22 nieuwe tests (server 259, client 95), lint/typecheck/build groen.

**Ontwerpkeuzes:** “geluisterd” is bevestigde speeltijd, niet “play ingedrukt”. De server meet zelf: apparaatsamples voor speakers die de NAS aanstuurt, een voortgangsbevestiging elke 10 s vanuit een browser die zelf speelt. Daardoor is er geen aparte seek- of pauzeboekhouding nodig: wat niet bevestigd wordt, telt niet, en een verdwenen client telt hooguit 45 s na. De Last.fm-regel bepaalt zowel geschiedenis als scrobbles, dus “recent” en topartiesten bevatten alleen echte luisterbeurten. De oude `play_history` blijft als legacy-tabel bestaan (back-ups, oude scanner-opruiming) en is eenmalig gekopieerd; onbekende tijden blijven `NULL`. Spotify wordt standaard niet gescrobbeld omdat Spotify dat zelf al doet; de instelling is expliciet.

**Gedragswijzigingen voor de gebruiker:** de geschiedenis toont alleen nog nummers die echt beluisterd zijn (minstens de helft of vier minuten); snel doorgeklikte nummers verdwijnen uit “recent”. Oude regels zonder tijd staan onderaan met “Time unknown”. De statistiekpagina heeft een blok “On this server” dat zonder ListenBrainz werkt. Een oude, nog geopende browserpagina meldt plays via het oude endpoint; die worden genegeerd in plaats van als luisterbeurt geboekt.

**Wacht op acceptatie (NAS):** een album op Sonos/DLNA laten spelen en daarna in Last.fm/ListenBrainz één inzending per nummer zien, met de starttijd als tijdstip; een nummer na 10 s overslaan en controleren dat het niet in de geschiedenis staat; een nummer pauzeren, tien minuten wachten, hervatten en controleren dat de geluisterde tijd niet is gegroeid (`GET /api/history/tracks` → `listened_ms`); een herstart tijdens weergave en kijken of de sessie doorloopt zonder dubbele scrobble.

**Beslismoment na V05:** V06 (bibliotheekbehoud) kan starten; de nieuwe tabel heeft geen foreign key naar `tracks`, dus verplaatsingsscenario’s uit V06 raken de geschiedenis niet meer.

### V06 — 9 september 2026

**Uitgevoerd:** V06.1–V06.4 volledig in code; scannertest herschreven (12 scenario's), migratietest voor een oude databasestructuur, 270 servertests, 95 clienttests, lint/typecheck/build groen.

**Ontwerpkeuzes:** de vingerafdruk is opzettelijk goedkoop (grootte, duur, tags) in plaats van een volledige bestandshash: geen extra I/O op de NAS, en in combinatie met “oud bestand is weg” en “precies één kandidaat” sterk genoeg om een verplaatsing te bewijzen. Alles wat onzeker is, blijft nieuw én zichtbaar als twijfelgeval. “Ontbrekend” is een toestand, geen verwijdering: de scanner verwijdert niets meer, alleen `purge` doet dat. `play_history` (legacy) wordt bij purge wel opgeruimd omdat die tabel nog een foreign key naar `tracks` heeft; de nieuwe luistersessies hebben die niet en blijven staan.

**Gedragswijzigingen voor de gebruiker:** na een verplaatsing van een map blijven favorieten, playlists en geschiedenis staan. Verwijderde bestanden verdwijnen niet stilzwijgend maar staan gedimd met “missing” in het album en in Settings met een opschoonknop. Een eerste scan na de update leest elk bestand eenmalig opnieuw (scanversie 2) om grootte, mtime en vingerafdruk te vullen; op de NAS kan dat even duren.

**Wacht op acceptatie (NAS):** één album map hernoemen op de NAS, scannen, en controleren dat favoriet, playlistpositie en geschiedenis blijven; een bestand tijdelijk verplaatsen buiten de bibliotheek en terugzetten (missing → hersteld); een SMB-share offline halen tijdens een scan (root onbereikbaar, niets gemarkeerd); duur van de eerste geforceerde scan noteren.

**Beslismoment na V06:** V07 (zoeken, edities, bronkeuze) kan starten; de vingerafdruk en editiesleutel zijn de basis voor editieherkenning.

### V07 — 9 september 2026

**Uitgevoerd:** V07.1–V07.4 in code; 284 servertests, 95 clienttests, lint/typecheck/build groen.

**Ontwerpkeuzes:** editieherkenning combineert drie signalen (versielabel van de bron, versielabel uit de titel, duur binnen 10 s); één signaal alleen was te grof (Spotify levert geen versieveld, titels zijn inconsistent). Bronkeuze werkt op `alternatives[]` met echte item-id's, nooit op naam-zoeken bij de andere bron. Speelbaarheid komt uit de playback-resolver van V04, zodat zoeken en afspelen nooit van mening verschillen. FTS5 is gemeten en afgewezen: de LIKE-variant met NOCASE-indexen zit een orde van grootte onder het doel. Genrefilter bewust overgeslagen (zie V07.2).

**Gedragswijzigingen voor de gebruiker:** live- en remasterversies staan apart in de resultaten met een label; ontbrekende lokale bestanden staan gedimd met “missing”; bronchips en kwaliteitsfilter boven de resultaten; bij een trage of kapotte streamingdienst verschijnen de lokale treffers direct met een melding welke bron niet antwoordde.

**NAS-meting (9 september 2026):** `bench:search` in de container op de Synology: p95 41–51 ms per zoekklasse bij 50.000 tracks, factor 6 onder het doel; FTS5 blijft achterwege.

**Wacht op acceptatie (NAS):** een nummer zoeken dat lokaal én op Qobuz staat en met “▶ qobuz” de Qobuz-versie starten; een live-versie zoeken (bijv. “(Live)”) en controleren dat studio en live apart staan; Qobuz uitloggen en zoeken: lokale treffers direct, melding “qobuz: not connected”.

**Beslismoment na V07:** V08 (mobiel, onboarding, offline shell) kan starten.

## Bronverwijzingen naar de onderzochte code

De links hieronder verwijzen naar deze lokale checkout. Regelnummers horen bij commit cd3f094; controleer bij uitvoering of de implementatie inmiddels is gewijzigd.

[project-readme]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/README.md:1
[oude-sprints]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/SPRINTS.md:1
[oude-audit]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/SPRINT_AUDIT.md:1
[oude-next]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/NEXT_STEPS.md:1
[oude-security]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/SECURITY_AUDIT.md:1
[schema]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/db/schema.ts:83
[database]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/db/index.ts:34
[auth]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/middleware/auth.ts:88
[auth-routes]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/routes/auth.ts:225
[app-auth]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/client/src/App.tsx:38
[queue-service]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/services/playback.ts:180
[queue-client]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/client/src/context/AudioContext.tsx:275
[server-player]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/services/server-player.ts:38
[device-monitor]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/services/device-monitor.ts:174
[socket-server]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/socketio.ts:21
[socket-client]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/client/src/hooks/useSocket.ts:64
[playback-router]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/routes/playback.ts:50
[track-playback]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/client/src/hooks/useTrackPlayback.ts:410
[history]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/routes/history.ts:12
[scrobbler]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/services/scrobbler.ts:348
[scanner]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/services/scanner.ts:318
[scanner-start]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/services/scanner.ts:78
[watcher]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/services/watcher.ts:20
[registry]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/providers/registry.ts:29
[local-search]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/providers/local.ts:88
[spotify]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/providers/spotify.ts:530
[provider-routes]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/routes/providers.ts:259
[qobuz]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/providers/qobuz.ts:1
[playlists]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/routes/playlists.ts:1
[audio]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/client/src/hooks/useAudio.ts:238
[device-interface]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/shared/src/device.ts:25
[device-manager]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/devices/manager.ts:109
[sonos]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/devices/sonos.ts:114
[sw]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/client/public/sw.js:19
[health]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/routes/health.ts:16
[entry]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/index.ts:41
[docker]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/Dockerfile:1
[compose]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/docker-compose.yml:1
[test-app]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/__tests__/helpers/testApp.ts:29
[settings]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/client/src/pages/SettingsPage.tsx:1
[discover]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/client/src/pages/DiscoverPage.tsx:81
[tokens]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/services/tokenstore.ts:22
[api-client]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/client/src/api/client.ts:87
[device-routes]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/routes/devices.ts:37
[listenbrainz]: C:/Users/DannydeLacombe/.claude/projects/AudioServer/server/src/services/listenbrainz.ts:1
