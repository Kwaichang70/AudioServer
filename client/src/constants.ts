// API
export const API_BASE = '/api';

// LocalStorage keys
export const STORAGE_TOKEN = 'audioserver_token';

// Defaults
export const DEFAULT_PAGE_SIZE = 60;
export const DEFAULT_SEARCH_LIMIT = 20;
export const DEFAULT_VOLUME = 0.7;

// Polling fallback (when WebSocket disconnected)
export const DEVICE_POLL_INTERVAL = 2000;

// Source colors for badges
export const SOURCE_COLORS: Record<string, string> = {
  local: 'bg-blue-900/50 text-blue-300',
  spotify: 'bg-green-900/50 text-green-300',
  tidal: 'bg-cyan-900/50 text-cyan-300',
  qobuz: 'bg-purple-900/50 text-purple-300',
};
