# AudioServer bedienen vanuit Homey, Grok of Jarvis

Eenvoudige commando's op naam, voor automaties en assistenten. Ze werken met
een **API-sleutel** (Settings → Account → API keys). Een sleutel kan muziek
bedienen en je bibliotheek lezen, verder niets.

## Adres

- **Homey Pro en andere apparaten thuis:** `http://192.168.2.58:3001` — blijft
  binnen je netwerk, de snelste en veiligste weg.
- **Grok, Jarvis of iets buiten je huis:** `https://kwaichangmusic.synology.me`.

Stuur de sleutel mee als header: `X-API-Key: as_…` (of
`Authorization: Bearer as_…`). Bodies zijn JSON:
`Content-Type: application/json`.

## Commando's

| Wat                           | Verzoek                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------- |
| Kamers (met wat er speelt)    | `GET /api/control/rooms`                                                      |
| Playlists (ook slimme)        | `GET /api/control/playlists`                                                  |
| Playlist afspelen             | `POST /api/control/play` `{"room":"Woonkamer","playlist":"Zondag"}`           |
| Album afspelen                | `POST /api/control/play` `{"room":"Keuken","album":"Purple Rain"}`            |
| Artiest afspelen (geshuffled) | `POST /api/control/play` `{"room":"Keuken","artist":"Prince","shuffle":true}` |
| Pauzeren / verder / stoppen   | `POST /api/control/pause` · `/resume` · `/stop` `{"room":"Woonkamer"}`        |
| Volgende / vorige             | `POST /api/control/next` · `/previous` `{"room":"Woonkamer"}`                 |
| Volume (0–100)                | `POST /api/control/volume` `{"room":"Woonkamer","volume":30}`                 |
| Wat speelt er                 | `GET /api/control/now-playing?room=Woonkamer`                                 |

- **Namen** mogen zonder hoofdletters of accenten (`bjork` vindt Björk) en
  mogen het begin van de naam zijn (`purple` vindt Purple Rain).
- **Kamer weglaten** mag als je maar één speakerkamer hebt.
- **Een verkeerde naam** geeft een foutmelding mét de namen die wél bestaan
  (`options`), zodat je het in de flow kunt verbeteren.
- Alleen kamers met een speaker (Sonos, DLNA, Volumio); een browserkamer kan
  niet op afstand starten.

## Voorbeeld: Homey Pro, zondagochtend

Installeer in Homey de app **HTTP request flow cards** (of een vergelijkbare
app met een kaart "HTTP POST").

**Als:** de tijd is 09:00 — **En:** het is zondag, en iemand is thuis
(aanwezigheid in Homey) — **Dan:**

1. Zet de Cocktail Audio aan (via de Homey-integratie van het apparaat of een
   slimme stekker). AudioServer kan een uitgeschakeld apparaat niet aanzetten.
2. Wacht 30 seconden (Homey-kaart _Wacht_), zodat de Cocktail Audio opgestart
   en op het netwerk is.
3. HTTP POST naar `http://192.168.2.58:3001/api/control/play`
   - Headers: `{"X-API-Key":"as_…","Content-Type":"application/json"}`
   - Body: `{"room":"Woonkamer","playlist":"Zondagochtend"}`
4. (Optioneel) HTTP POST naar `/api/control/volume` met
   `{"room":"Woonkamer","volume":25}`.

`Woonkamer` is de naam van de kamer in AudioServer (Settings → Rooms) waarin
de Cocktail Audio zit.

## Testen vanaf je pc

```bash
curl -s http://192.168.2.58:3001/api/control/rooms -H "X-API-Key: as_…"
curl -s -X POST http://192.168.2.58:3001/api/control/play \
  -H "X-API-Key: as_…" -H "Content-Type: application/json" \
  -d '{"room":"Woonkamer","playlist":"Zondagochtend"}'
```

In PowerShell: gebruik `curl.exe` (niet `curl`) met dezelfde opties, en zet
de JSON tussen enkele aanhalingstekens met dubbele erin.
