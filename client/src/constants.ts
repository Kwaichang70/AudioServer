export const API_BASE = '/api';

export const STORAGE_TOKEN = 'audioserver_token';
export const STORAGE_KEYS = {
  authToken: STORAGE_TOKEN,
  selectedDevice: 'audioserver_device',
  crossfade: 'audioserver_crossfade',
  replayGainMode: 'audioserver_replaygain_mode',
  replayGainPreamp: 'audioserver_replaygain_preamp',
  theme: 'audioserver_theme',
} as const;

export const DEFAULT_LIBRARY_PAGE_SIZE = 60;
export const DEFAULT_HISTORY_PAGE_SIZE = 50;
export const DEFAULT_SEARCH_LIMIT = 20;
export const DEFAULT_VOLUME = 0.7;

export const DEVICE_POLL_INTERVAL = 2000;
export const SOCKET_RECONNECT_DELAY = 1000;
export const SOCKET_RECONNECT_ATTEMPTS = 10;

export const SPOTIFY_CONNECT_RECEIVER_NAME = 'AudioServer';

export const SOURCE_COLORS: Record<string, string> = {
  local: 'bg-blue-900/50 text-blue-300',
  spotify: 'bg-green-900/50 text-green-300',
  tidal: 'bg-cyan-900/50 text-cyan-300',
  qobuz: 'bg-purple-900/50 text-purple-300',
};
