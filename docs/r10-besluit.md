# R10.3 — Besluit: audio bewerken op de NAS voor speakers

_Status: **opzet** (15 oktober 2026). De velden met ✏️ vult Danny in na de
NAS-meting en de luistertest; daarna wordt de keuze onderaan genoteerd en in
`VERBETERPLAN_ROON.md` (R10.3) afgevinkt._

## 1. De vraag

Mag de NAS audio voor speakers bewerken, en zo ja wanneer? Er zijn drie
uitkomsten (plan, R10.3):

| Uitkomst                                | Betekent                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **A. Productiseren**                    | Conversie en egalisatie blijven zoals gebouwd, ook "altijd egaliseren" per kamer. Uit de proefstatus, in de gebruikersdocs.    |
| **B. Alleen bij onverenigbaar formaat** | Conversie blijft voor speakers die het bronformaat niet nemen; "altijd egaliseren" verdwijnt (alleen `auto` en `off` blijven). |
| **C. Verwijderen**                      | Geen bewerking op de NAS; elke speaker krijgt het originele bestand. `transcode.ts`, `zone-audio.ts` en de route gaan eruit.   |

## 2. Wat er gebouwd is (R10.1, R10.2)

- **Conversie** alleen als een speaker zijn formatenlijst geeft en het
  bronformaat daar niet in staat: FLAC → MP3 320 (standaard) of WAV
  (`TRANSCODE_TARGET=wav`). Geen lijst of geen ffmpeg: het origineel.
- **Egalisatie** per kamer (Settings → Rooms): `auto` (alleen wat toch
  geconverteerd wordt, album-gain), `off`, of altijd (`album`/`track`). Gain
  uit de bibliotheek, begrensd door de piek, dither bij 16 bit. Geen EQ.
- **Eerlijkheid:** het audiopad noemt de conversie, de gain en "not
  bit-perfect".
- **Meting:** elke conversie telt CPU-tijd en piekgeheugen van ffmpeg, te
  zien in Settings → Rooms → _Conversion trial_ (en via
  `GET /api/playback/transcodes`, admin), met CPU per minuut muziek.
- **Grenzen:** geen springen binnen een geconverteerd nummer (geen
  byte-ranges); Qobuz wordt niet geconverteerd of geëgaliseerd; maximaal twee
  conversies per kamer.

## 3. Referentiemeting (sandbox, géén NAS)

Intel Xeon 2,1 GHz, 4 kernen; 4 minuten sinustoon per bestand (stereo).
Ter vergelijking, niet om op te beslissen.

| Conversie                  | CPU per minuut muziek | CPU tijdens het luisteren | Geheugen per ffmpeg |
| -------------------------- | --------------------- | ------------------------- | ------------------- |
| FLAC 44,1/16 → MP3 320     | ~650 ms               | ~1,1% van één kern        | ~55 MB              |
| FLAC 96/24 → MP3 320       | ~850 ms               | ~1,4%                     | ~55 MB              |
| FLAC → WAV                 | ~100–165 ms           | ~0,2–0,3%                 | ~55 MB              |
| Twee kamers tegelijk (MP3) | ~740 ms per kamer     | ~1,2% per kamer           | ~55 MB per stuk     |

ffmpeg werkt in een stoot vooruit tot de buffer van de speaker vol is en
wacht dan; de piek bij de start is dus hoger dan het gemiddelde.

## 4. Meten op de NAS ✏️

**Vooraf:** back-up, deploy met schemaversie 20, en noteer de processor:
`cat /proc/cpuinfo | grep "model name" | head -1` → ✏️ ********\_\_\_\_********

**Een conversie uitlokken** (ook zonder speaker die alleen MP3 neemt), in
**Settings → Rooms → Conversion trial**:

1. Log in als admin en speel een lang FLAC-nummer uit de bibliotheek af (bij
   voorkeur 24 bit; het mag in de browser).
2. Klik **Measure one**. De NAS zet het nummer om naar MP3 320, zoals een
   speaker het zou ophalen; het paneel leest het tot het eind en toont de
   regel met _CPU per min. music_, _≈ of one core_ en _Peak memory_.
3. Klik **Measure two at once** voor twee kamers tegelijk.
4. Egalisatie: zet een Sonos- of DLNA-kamer op _Always level (album)_, speel
   er een FLAC-album op af; de regels van die kamer verschijnen in dezelfde
   tabel (FLAC → FLAC met gain).
5. Houd ondertussen de CPU-grafiek in DSM (Resource Monitor) open.

| Meting                            | cpuMsPerAudioMinute | peakRssKb | Opmerkingen (hapering, CPU-grafiek in DSM) |
| --------------------------------- | ------------------- | --------- | ------------------------------------------ |
| 1 × FLAC 16 bit → MP3             | ✏️                  | ✏️        | ✏️                                         |
| 1 × FLAC 24 bit → MP3             | ✏️                  | ✏️        | ✏️                                         |
| 2 tegelijk → MP3                  | ✏️ / ✏️             | ✏️ / ✏️   | ✏️                                         |
| Kamer op _album_: FLAC → FLAC     | ✏️                  | ✏️        | ✏️                                         |
| Scan van de bibliotheek tegelijk? | ✏️                  | ✏️        | ✏️                                         |

**Omrekenen:** _≈ of one core_ is `cpuMsPerAudioMinute / 600` procent van één
kern (60 000 ms in een minuut). Het piekgeheugen wordt elke 2 s gelezen; bij
een kort nummer kan het te laag uitvallen, gebruik daarom lange nummers.

## 5. Luistertest ✏️

Per kamer hetzelfde album, eerst _Never level_, dan _Always level (album)_.

| Speaker / kamer | Format genomen (audiopad) | Egalisatie hoorbaar? | Artefacten (klik, vervorming, gat tussen nummers) | Springen werkt? |
| --------------- | ------------------------- | -------------------- | ------------------------------------------------- | --------------- |
| ✏️              | ✏️                        | ✏️                   | ✏️                                                | ✏️              |
| ✏️              | ✏️                        | ✏️                   | ✏️                                                | ✏️              |

## 6. Welke speakers hadden het nodig? ✏️

Lees per speaker in het audiopad van de speler (de stap met de naam van de
speaker: "The device says it accepts: …") welke formaten hij opgeeft.

| Speaker | Opgegeven formaten | Neemt FLAC? | Kreeg een conversie? |
| ------- | ------------------ | ----------- | -------------------- |
| ✏️      | ✏️                 | ✏️          | ✏️                   |

## 7. Beslisregels

Vooraf vastgelegd, zodat de cijfers beslissen en niet de voorkeur van het
moment:

- **C (verwijderen)** als een conversie op de NAS hapert of een scan merkbaar
  vertraagt, óf als geen enkele speaker een conversie nodig had én egalisatie
  op speakers niet gewenst is.
- **B (alleen onverenigbaar formaat)** als minstens één speaker een conversie
  nodig had, de CPU per kamer onder **10% van één kern** blijft
  (`cpuMsPerAudioMinute` < 6000) en er geen artefacten zijn, maar egalisatie
  op speakers niet gemist wordt.
- **A (productiseren)** als B geldt én egalisatie op speakers hoorbaar beter
  is en gewenst, met twee kamers tegelijk zonder haperen.

## 8. Besluit ✏️

- Uitkomst: ✏️ A / B / C
- Datum: ✏️
- Reden in één zin: ✏️
- Gevolgen voor de code: ✏️ (bij B: modi `track`/`album` verwijderen; bij C:
  `transcode.ts`, `zone-audio.ts`, de `format`-tak van de streamroute en
  tabel `zone_audio` verwijderen)
