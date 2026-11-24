# AudioServer in Grok en Jarvis (MCP)

AudioServer is een **MCP-server**: een AI-assistent die MCP spreekt, ziet je
kamers, playlists en bibliotheek als gereedschap en kan muziek bedienen. Je
zegt dan gewoon _"zet Purple Rain op in de woonkamer"_.

## Wat je nodig hebt

1. Een **API-sleutel** per assistent: Settings → Account → API keys → naam
   (bijv. `Grok`) → kopieer de sleutel (`as_…`, wordt één keer getoond).
2. Het adres: `https://kwaichangmusic.synology.me/mcp`
   - Sleutel als header: `Authorization: Bearer as_…` of `X-API-Key: as_…`.
   - Kan de assistent geen header meegeven, zet de sleutel dan in het adres:
     `https://kwaichangmusic.synology.me/mcp/as_…`. Behandel dat adres als een
     wachtwoord. AudioServer zet de sleutel niet in zijn log, maar de
     reverse proxy van de Synology en de assistent zelf bewaren het hele
     adres wel: kies deze vorm alleen als een header echt niet kan, en maak
     een nieuwe sleutel (en trek de oude in) als het adres ergens is gedeeld
     of gelogd. Met een sleutel kun je afspelen bedienen en de bibliotheek
     lezen, ook de muziekbestanden zelf.
3. De reverse proxy op de Synology moet `/mcp` doorsturen naar poort 3001.
   Stuurt hij de hele host door (zoals voor de app), dan werkt het al.

Transport: Streamable HTTP, alleen POST, zonder sessies (elk verzoek staat op
zichzelf). Er is geen OAuth-login: een client die daarom vraagt, krijgt een
nette 404 en moet de sleutel gebruiken.

## Via Tailscale (Grokbot, Jarvis)

Draaien de assistent en de NAS in hetzelfde Tailscale-netwerk (tailnet), dan
hoeft de MCP-server niet op het open internet te staan. De container draait op
het netwerk van de NAS zelf, dus hij luistert al op het Tailscale-adres van de
NAS: er hoeft niets extra te draaien.

**Adres** (kies er één; `<tailnet>` staat in de Tailscale-app, bijv.
`tail1234.ts.net`):

| Vorm              | Adres                                   | Wanneer                                     |
| ----------------- | --------------------------------------- | ------------------------------------------- |
| MagicDNS          | `http://diskstation.<tailnet>:3001/mcp` | Standaard. Het verkeer is al versleuteld.   |
| Tailscale-adres   | `http://100.x.y.z:3001/mcp`             | Als de naam niet wordt gevonden.            |
| HTTPS (zie onder) | `https://diskstation.<tailnet>/mcp`     | Als de client alleen `https://` accepteert. |

De sleutel gaat altijd als header mee: `Authorization: Bearer as_…`. De vorm
met de sleutel in het adres is hier niet nodig.

**Alleen nog via Tailscale** (aanbevolen als je grok.com niet gebruikt): zet in
`/volume1/docker/AudioServer/.env`

```env
MCP_ACCESS=tailscale
```

en herstart zonder te bouwen:

```bash
sudo /usr/local/bin/docker-compose -f /volume1/docker/AudioServer/docker-compose.yml up -d
```

| `MCP_ACCESS` | Wie `/mcp` bereikt (altijd mét een geldige sleutel)       |
| ------------ | --------------------------------------------------------- |
| `any`        | Iedereen, ook van buiten (standaard; nodig voor grok.com) |
| `tailscale`  | Alleen apparaten in je tailnet                            |
| `private`    | Je tailnet en het thuisnetwerk                            |

Met `tailscale` krijgt een verzoek via het publieke adres
(`kwaichangmusic.synology.me/mcp`) een `403`, ook met een geldige sleutel. Een
uitgelekte sleutel is dan buiten je tailnet niets waard. De app zelf en
`/api/control` (Homey) veranderen niet. De connector op **grok.com** draait bij
xAI en zit niet in je tailnet; die werkt alleen met `any`.

**HTTPS binnen het tailnet** (alleen als een client erom vraagt). Op de NAS,
eenmalig, met HTTPS-certificaten aan in de Tailscale-beheerconsole:

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:3001
```

Daarna is het adres `https://diskstation.<tailnet>/mcp`. Tailscale stuurt het
adres van de aanvrager mee, dus `MCP_ACCESS=tailscale` blijft kloppen. Niet
uitgeprobeerd op de Synology zelf.

**Controleren vanaf een apparaat in het tailnet:**

```bash
curl -s -X POST http://diskstation.<tailnet>:3001/mcp \
  -H "Authorization: Bearer as_…" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_rooms","arguments":{}}}'
```

Geen antwoord: staat de NAS aan, is Tailscale op de NAS verbonden, en laat de
firewall van DSM (als die aan staat) poort 3001 toe vanaf de
Tailscale-interface? `401`: verkeerde sleutel. `403`: het verzoek kwam niet
uit het tailnet.

**Grokbot of een andere MCP-client** (algemene vorm):

```json
{
  "mcpServers": {
    "audioserver": {
      "type": "http",
      "url": "http://diskstation.<tailnet>:3001/mcp",
      "headers": { "Authorization": "Bearer as_…" }
    }
  }
}
```

Voor Jarvis is het hetzelfde adres in het voorbeeld onder "Jarvis" hieronder.
Maak per assistent een eigen sleutel (Settings → Account → API keys), dan kun
je er één intrekken zonder de ander te raken.

## Gereedschap

| Tool                            | Doet                                                 |
| ------------------------------- | ---------------------------------------------------- |
| `list_rooms`                    | Kamers, wat er speelt, volume                        |
| `list_playlists`                | Playlists en slimme playlists                        |
| `search_library`                | Artiesten, albums, nummers zoeken                    |
| `now_playing`                   | Wat speelt er in een kamer                           |
| `play`                          | Playlist, album of artiest afspelen in een kamer     |
| `pause` · `resume` · `stop`     | Pauzeren, verder, stoppen                            |
| `next_track` · `previous_track` | Volgende, vorige                                     |
| `set_volume`                    | Volume 0–100                                         |
| `move_music`                    | Muziek naar een andere kamer verhuizen (met positie) |

Spotify: `list_playlists` toont ook je Spotify-playlists (`kind: spotify`), en
`play` met `source: spotify` speelt een Spotify-playlist, -album of -artiest
op de speaker via Spotify Connect (zie [control-api.md](control-api.md#spotify)).
Vraag Grok bijvoorbeeld: _"Speel mijn Spotify-playlist Zondag Jazz in de
woonkamer."_

Namen mogen zonder hoofdletters of accenten. Een verkeerde naam geeft een
foutmelding mét de namen die wél bestaan, zodat de assistent zelf kan
verbeteren. Het zijn dezelfde commando's als in [control-api.md](control-api.md).

## Grok (grok.com)

1. Ga naar **grok.com → Connectors** → **New Connector** → **Custom**
   (betaald abonnement nodig).
2. Server-URL: `https://kwaichangmusic.synology.me/mcp/as_…` (je Grok-sleutel).
   Biedt het scherm een veld voor een header of _bearer token_, gebruik dan
   `https://kwaichangmusic.synology.me/mcp` en zet de sleutel daar.
3. Zet de connector aan in een gesprek en vraag bijv. _"Welke kamers heeft
   mijn AudioServer?"_

Niet uitgeprobeerd: welke inlogvelden de Grok-app precies toont. De sleutel in
het adres werkt met elke client.

Via de **xAI-API** (eigen scripts):

```json
{
  "type": "mcp",
  "server_url": "https://kwaichangmusic.synology.me/mcp",
  "server_label": "audioserver",
  "authorization": "as_…"
}
```

## Jarvis (eigen assistent)

Gebruik een MCP-client-bibliotheek met Streamable HTTP. Bijvoorbeeld in
TypeScript met `@modelcontextprotocol/sdk`:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'jarvis', version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL('https://kwaichangmusic.synology.me/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.AUDIOSERVER_KEY}` } },
  }),
);
const { tools } = await client.listTools(); // geef deze aan je model
await client.callTool({ name: 'play', arguments: { room: 'Woonkamer', playlist: 'Zondag' } });
```

In Python werkt het net zo met het pakket `mcp`
(`streamablehttp_client(url, headers={...})`). Spreekt Jarvis geen MCP, dan
kan hij dezelfde commando's als gewone HTTP-verzoeken sturen:
[control-api.md](control-api.md).

## Testen vanaf je pc

```bash
curl -s -X POST https://kwaichangmusic.synology.me/mcp \
  -H "Authorization: Bearer as_…" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_rooms","arguments":{}}}'
```

Een antwoord `401` betekent een verkeerde of ingetrokken sleutel.
