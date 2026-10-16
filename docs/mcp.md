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
     wachtwoord. AudioServer zet de sleutel niet in zijn log.
3. De reverse proxy op de Synology moet `/mcp` doorsturen naar poort 3001.
   Stuurt hij de hele host door (zoals voor de app), dan werkt het al.

Transport: Streamable HTTP, alleen POST, zonder sessies (elk verzoek staat op
zichzelf).

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
