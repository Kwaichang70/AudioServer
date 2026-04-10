import type { RadioStation } from '@audioserver/shared';
import { logger } from '../logger.js';

// ─── Curated Dutch stations ──────────────────────────────────────
// Stream URLs verified against the public Icecast feeds of NPO and the
// commercial station groups (Talpa, DPG). If an entry ever goes stale the
// fallback in getStation() will perform a live radio-browser lookup by name.

const CURATED_NL: RadioStation[] = [
  {
    id: 'radio:npo-radio-1', uuid: 'npo-radio-1', name: 'NPO Radio 1',
    streamUrl: 'https://icecast.omroep.nl/radio1-bb-mp3',
    genre: 'News, Talk, Sport', country: 'NL', language: 'Dutch',
    homepage: 'https://www.nporadio1.nl',
    faviconUrl: 'https://www.nporadio1.nl/favicon.ico',
    bitrate: 192, codec: 'mp3', curated: true,
  },
  {
    id: 'radio:npo-radio-2', uuid: 'npo-radio-2', name: 'NPO Radio 2',
    streamUrl: 'https://icecast.omroep.nl/radio2-bb-mp3',
    genre: 'Adult Contemporary', country: 'NL', language: 'Dutch',
    homepage: 'https://www.nporadio2.nl',
    faviconUrl: 'https://www.nporadio2.nl/favicon.ico',
    bitrate: 192, codec: 'mp3', curated: true,
  },
  {
    id: 'radio:npo-3fm', uuid: 'npo-3fm', name: 'NPO 3FM',
    streamUrl: 'https://icecast.omroep.nl/3fm-bb-mp3',
    genre: 'Pop, Alternative', country: 'NL', language: 'Dutch',
    homepage: 'https://www.npo3fm.nl',
    faviconUrl: 'https://www.npo3fm.nl/favicon.ico',
    bitrate: 192, codec: 'mp3', curated: true,
  },
  {
    id: 'radio:npo-radio-4', uuid: 'npo-radio-4', name: 'NPO Radio 4',
    streamUrl: 'https://icecast.omroep.nl/radio4-bb-mp3',
    genre: 'Classical', country: 'NL', language: 'Dutch',
    homepage: 'https://www.nporadio4.nl',
    faviconUrl: 'https://www.nporadio4.nl/favicon.ico',
    bitrate: 192, codec: 'mp3', curated: true,
  },
  {
    id: 'radio:npo-radio-5', uuid: 'npo-radio-5', name: 'NPO Radio 5',
    streamUrl: 'https://icecast.omroep.nl/radio5-bb-mp3',
    genre: 'Oldies, Nederlands', country: 'NL', language: 'Dutch',
    homepage: 'https://www.nporadio5.nl',
    faviconUrl: 'https://www.nporadio5.nl/favicon.ico',
    bitrate: 192, codec: 'mp3', curated: true,
  },
  {
    id: 'radio:npo-soul-jazz', uuid: 'npo-soul-jazz', name: 'NPO Soul & Jazz',
    streamUrl: 'https://icecast.omroep.nl/radio6-bb-mp3',
    genre: 'Soul, Jazz', country: 'NL', language: 'Dutch',
    homepage: 'https://www.nposoulenjazz.nl',
    bitrate: 192, codec: 'mp3', curated: true,
  },
  {
    id: 'radio:funx', uuid: 'funx', name: 'FunX',
    streamUrl: 'https://icecast.omroep.nl/funx-bb-mp3',
    genre: 'Urban, Hip-Hop', country: 'NL', language: 'Dutch',
    homepage: 'https://www.funx.nl',
    bitrate: 192, codec: 'mp3', curated: true,
  },
  {
    id: 'radio:538', uuid: 'radio-538', name: 'Radio 538',
    streamUrl: 'https://22533.live.streamtheworld.com/RADIO538.mp3',
    genre: 'Top 40, Dance', country: 'NL', language: 'Dutch',
    homepage: 'https://www.538.nl',
    bitrate: 128, codec: 'mp3', curated: true,
  },
  {
    id: 'radio:qmusic-nl', uuid: 'qmusic-nl', name: 'Qmusic',
    streamUrl: 'https://stream.qmusic.nl/qmusic/mp3',
    genre: 'Pop, Hits', country: 'NL', language: 'Dutch',
    homepage: 'https://qmusic.nl',
    bitrate: 192, codec: 'mp3', curated: true,
  },
  {
    id: 'radio:sky-radio', uuid: 'sky-radio', name: 'Sky Radio',
    streamUrl: 'https://22533.live.streamtheworld.com/SKYRADIO.mp3',
    genre: 'Hits, Non-Stop', country: 'NL', language: 'Dutch',
    homepage: 'https://www.skyradio.nl',
    bitrate: 128, codec: 'mp3', curated: true,
  },
  {
    id: 'radio:slam', uuid: 'slam', name: 'SLAM!',
    streamUrl: 'https://stream.slam.nl/slam_mp3',
    genre: 'Dance, EDM', country: 'NL', language: 'Dutch',
    homepage: 'https://www.slam.nl',
    bitrate: 192, codec: 'mp3', curated: true,
  },
  {
    id: 'radio:veronica', uuid: 'radio-veronica', name: 'Radio Veronica',
    streamUrl: 'https://22533.live.streamtheworld.com/VERONICA.mp3',
    genre: 'Classic Rock', country: 'NL', language: 'Dutch',
    homepage: 'https://www.radioveronica.nl',
    bitrate: 128, codec: 'mp3', curated: true,
  },
  {
    id: 'radio:radio-10', uuid: 'radio-10', name: 'Radio 10',
    streamUrl: 'https://22533.live.streamtheworld.com/RADIO10.mp3',
    genre: '70s, 80s, 90s', country: 'NL', language: 'Dutch',
    homepage: 'https://www.radio10.nl',
    bitrate: 128, codec: 'mp3', curated: true,
  },
  {
    id: 'radio:bnr', uuid: 'bnr', name: 'BNR Nieuwsradio',
    streamUrl: 'https://stream.bnr.nl/bnr_mp3_128_20',
    genre: 'Business, News', country: 'NL', language: 'Dutch',
    homepage: 'https://www.bnr.nl',
    bitrate: 128, codec: 'mp3', curated: true,
  },
  {
    id: 'radio:100-nl', uuid: '100-nl', name: '100% NL',
    streamUrl: 'https://stream.100p.nl/100pctnl.mp3',
    genre: 'Nederlandstalig', country: 'NL', language: 'Dutch',
    homepage: 'https://www.100pnl.nl',
    bitrate: 192, codec: 'mp3', curated: true,
  },
  {
    id: 'radio:kink', uuid: 'kink', name: 'KINK',
    streamUrl: 'https://stream.kink.nl/kink',
    genre: 'Alternative, Rock', country: 'NL', language: 'Dutch',
    homepage: 'https://kink.nl',
    bitrate: 192, codec: 'mp3', curated: true,
  },
  {
    id: 'radio:sublime', uuid: 'sublime', name: 'Sublime',
    streamUrl: 'https://22533.live.streamtheworld.com/SUBLIMEFM.mp3',
    genre: 'Soul, Jazz, Funk', country: 'NL', language: 'Dutch',
    homepage: 'https://sublime.nl',
    bitrate: 128, codec: 'mp3', curated: true,
  },
  {
    id: 'radio:arrow-classic-rock', uuid: 'arrow-classic-rock', name: 'Arrow Classic Rock',
    streamUrl: 'https://stream.arrow.nl:443/arrow-hi.mp3',
    genre: 'Classic Rock', country: 'NL', language: 'Dutch',
    homepage: 'https://www.arrow.nl',
    bitrate: 192, codec: 'mp3', curated: true,
  },
];

// ─── radio-browser.info client ───────────────────────────────────

const RADIO_BROWSER_BASE = 'https://de1.api.radio-browser.info/json';
const USER_AGENT = 'AudioServer/1.0';

interface RadioBrowserStation {
  stationuuid: string;
  name: string;
  url: string;
  url_resolved: string;
  homepage?: string;
  favicon?: string;
  tags?: string;
  countrycode?: string;
  language?: string;
  bitrate?: number;
  codec?: string;
  lastcheckok?: number;
}

function mapStation(s: RadioBrowserStation): RadioStation {
  return {
    id: `radio:${s.stationuuid}`,
    uuid: s.stationuuid,
    name: s.name?.trim() || 'Unknown',
    streamUrl: s.url_resolved || s.url,
    genre: s.tags || undefined,
    country: s.countrycode || undefined,
    language: s.language || undefined,
    homepage: s.homepage || undefined,
    faviconUrl: s.favicon || undefined,
    bitrate: s.bitrate || undefined,
    codec: s.codec?.toLowerCase() || undefined,
    curated: false,
  };
}

// Small in-memory cache (30 min) so the NL featured/search lists don't hit
// radio-browser on every page load.
interface CacheEntry { expires: number; value: RadioStation[]; }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30 * 60 * 1000;

function cacheGet(key: string): RadioStation[] | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key: string, value: RadioStation[]): void {
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`radio-browser ${res.status}: ${res.statusText}`);
  return res.json() as Promise<T>;
}

// ─── Public API ──────────────────────────────────────────────────

export const radioProvider = {
  getFeaturedStations(): RadioStation[] {
    return CURATED_NL;
  },

  async searchStations(query: string, country = 'NL', limit = 40): Promise<RadioStation[]> {
    const cacheKey = `search:${country}:${query.toLowerCase()}:${limit}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const params = new URLSearchParams({
      name: query,
      limit: String(limit),
      order: 'clickcount',
      reverse: 'true',
      hidebroken: 'true',
    });
    if (country) params.set('countrycode', country);

    try {
      const stations = await fetchJson<RadioBrowserStation[]>(
        `${RADIO_BROWSER_BASE}/stations/search?${params}`
      );
      const mapped = stations.map(mapStation);
      cacheSet(cacheKey, mapped);
      return mapped;
    } catch (err) {
      logger.warn(`Radio search failed: ${err}`);
      return [];
    }
  },

  async browseByCountry(countryCode = 'NL', limit = 50): Promise<RadioStation[]> {
    const cacheKey = `country:${countryCode}:${limit}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    try {
      const params = new URLSearchParams({
        limit: String(limit),
        order: 'clickcount',
        reverse: 'true',
        hidebroken: 'true',
      });
      const stations = await fetchJson<RadioBrowserStation[]>(
        `${RADIO_BROWSER_BASE}/stations/bycountrycode/${countryCode}?${params}`
      );
      const mapped = stations.map(mapStation);
      cacheSet(cacheKey, mapped);
      return mapped;
    } catch (err) {
      logger.warn(`Radio country browse failed: ${err}`);
      return [];
    }
  },

  async browseByTag(tag: string, country = 'NL', limit = 40): Promise<RadioStation[]> {
    const cacheKey = `tag:${country}:${tag.toLowerCase()}:${limit}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    try {
      const params = new URLSearchParams({
        limit: String(limit),
        order: 'clickcount',
        reverse: 'true',
        hidebroken: 'true',
      });
      if (country) params.set('countrycode', country);
      const stations = await fetchJson<RadioBrowserStation[]>(
        `${RADIO_BROWSER_BASE}/stations/bytag/${encodeURIComponent(tag)}?${params}`
      );
      const mapped = stations.map(mapStation);
      cacheSet(cacheKey, mapped);
      return mapped;
    } catch (err) {
      logger.warn(`Radio tag browse failed: ${err}`);
      return [];
    }
  },

  async getStation(uuid: string): Promise<RadioStation | null> {
    // Curated first
    const curated = CURATED_NL.find((s) => s.uuid === uuid);
    if (curated) return curated;

    // radio-browser lookup by uuid
    try {
      const stations = await fetchJson<RadioBrowserStation[]>(
        `${RADIO_BROWSER_BASE}/stations/byuuid/${uuid}`
      );
      if (stations.length === 0) return null;
      // Fire-and-forget click counter hit
      fetch(`${RADIO_BROWSER_BASE}/url/${uuid}`, {
        headers: { 'User-Agent': USER_AGENT },
      }).catch(() => {});
      return mapStation(stations[0]);
    } catch (err) {
      logger.warn(`Radio getStation(${uuid}) failed: ${err}`);
      return null;
    }
  },
};
