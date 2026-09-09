import { useEffect, useState, useRef } from 'react';
import { api } from '../api/client.js';
import { useAudioContext } from '../context/AudioContext.js';

interface Device {
  id: string;
  name: string;
  type: string;
  isOnline: boolean;
  host?: string;
  playbackState?: 'idle' | 'loading' | 'playing' | 'paused' | 'stopped' | 'error';
  lastError?: string;
  groupName?: string;
  isGroupCoordinator?: boolean;
}

// A device from Spotify's own /me/player/devices list (Sonos, CocktailAudio,
// phones, …). We surface these directly so the user can send Spotify straight
// to them via Spotify Connect, instead of relying on fuzzy name-matching.
interface SpotifyDevice {
  id: string;
  name: string;
  type: string;
  is_active?: boolean;
  is_restricted?: boolean;
}

const SPOTIFY_CONNECT_PREFIX = 'spotify-connect:';

const deviceTypeIcons: Record<string, string> = {
  browser: '\u{1F4BB}',
  dlna: '\u{1F50A}',
  sonos: '\u{1F3B5}',
  volumio: '\u{1F3B6}',
};

const stateLabels: Record<string, string> = {
  idle: 'Idle',
  loading: 'Loading',
  playing: 'Playing',
  paused: 'Paused',
  stopped: 'Stopped',
  error: 'Error',
};

interface Props {
  selectedDeviceId: string;
  onSelect: (deviceId: string) => void;
  /**
   * Icon only below `sm`. The player bar on a phone has no room for a device
   * name, and dropping the name is what makes the picker fit there at all.
   */
  compact?: boolean;
}

export default function DeviceSelector({ selectedDeviceId, onSelect, compact }: Props) {
  // Zones (V10): a device that is a room shows the room's name and what it is
  // playing, so picking an output is picking a room.
  const { zones } = useAudioContext();
  const zoneOf = (deviceId: string) => zones.find((z) => z.deviceId === deviceId);
  const zoneLine = (deviceId: string): string | null => {
    const zone = zoneOf(deviceId);
    if (!zone) return null;
    if (zone.queueLength === 0) return `${zone.name} \u00B7 empty queue`;
    const what = zone.track?.title ? `\u00B7 ${zone.track.title}` : '';
    const state = zone.state === 'playing' ? 'playing' : zone.state;
    return `${zone.name} \u00B7 ${state} ${zone.queueIndex + 1}/${zone.queueLength} ${what}`.trim();
  };
  const [devices, setDevices] = useState<Device[]>([]);
  const [spotifyDevices, setSpotifyDevices] = useState<SpotifyDevice[]>([]);
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const loadDevices = (discover = false) => {
    const fn = discover ? api.discoverDevices : api.getDevices;
    if (discover) setScanning(true);
    fn()
      .then((res) => {
        setDevices(res.data);
        setScanning(false);
      })
      .catch(() => setScanning(false));
  };

  // Spotify's own device list — empty/absent when Spotify isn't connected.
  const loadSpotifyDevices = () => {
    api
      .spotifyConnectDevices()
      .then((res) => setSpotifyDevices(Array.isArray(res.data) ? res.data : []))
      .catch(() => setSpotifyDevices([]));
  };

  useEffect(() => {
    loadDevices();
    loadSpotifyDevices();
  }, []);

  // Refresh the Spotify device list each time the dropdown opens — devices come
  // and go (a speaker only appears once it's awake / recently used).
  useEffect(() => {
    if (open) loadSpotifyDevices();
  }, [open]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selected = devices.find((d) => d.id === selectedDeviceId);
  const onlineDevices = devices.filter((d) => d.isOnline);
  const offlineDevices = devices.filter((d) => !d.isOnline);
  const selectedSpotify = spotifyDevices.find(
    (d) => `${SPOTIFY_CONNECT_PREFIX}${d.id}` === selectedDeviceId,
  );
  const selectedLabel =
    zoneOf(selectedDeviceId)?.name ?? selected?.name ?? selectedSpotify?.name ?? 'Browser';
  const selectedIcon = selectedSpotify
    ? '\u{1F7E2}'
    : deviceTypeIcons[selected?.type || 'browser'] || '\u{1F50A}';

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2 py-1.5 text-xs rounded bg-surface-dark border border-white/10 hover:border-accent transition"
        title="Select output device"
        aria-label={`Output device: ${selectedLabel}`}
      >
        <span>{selectedIcon}</span>
        <span className={`${compact ? 'hidden sm:inline ' : ''}max-w-[100px] truncate`}>
          {selectedLabel}
        </span>
        {selected?.playbackState === 'error' && <span className="text-red-400">!</span>}
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-72 bg-surface border border-white/10 rounded-lg shadow-xl z-50">
          <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Output Devices</p>
            <button
              onClick={() => {
                loadDevices(true);
                loadSpotifyDevices();
              }}
              disabled={scanning}
              className="text-xs text-accent hover:text-accent-hover transition disabled:opacity-50"
            >
              {scanning ? 'Scanning...' : 'Refresh'}
            </button>
          </div>

          <div className="py-1 max-h-64 overflow-y-auto">
            {onlineDevices.map((device) => (
              <button
                key={device.id}
                onClick={() => {
                  onSelect(device.id);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-2 flex items-center gap-3 transition cursor-pointer
                  ${device.id === selectedDeviceId ? 'bg-accent/20 text-accent' : 'hover:bg-surface-light'}
                `}
              >
                <span className="text-lg">{deviceTypeIcons[device.type] || '\u{1F50A}'}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">
                    {zoneOf(device.id)?.name ?? device.name}
                  </p>
                  {zoneLine(device.id) ? (
                    <p className="text-xs text-accent truncate">{zoneLine(device.id)}</p>
                  ) : null}
                  <p className="text-xs text-gray-500">
                    {device.type.toUpperCase()}
                    {device.host && ` \u00B7 ${device.host}`}
                    {device.playbackState && ` \u00B7 ${stateLabels[device.playbackState]}`}
                  </p>
                  {device.groupName && (
                    <p className="text-xs text-gray-600 truncate">
                      {device.isGroupCoordinator ? 'Group leader' : 'Grouped'}: {device.groupName}
                    </p>
                  )}
                  {device.lastError && (
                    <p className="text-xs text-red-400 truncate">{device.lastError}</p>
                  )}
                </div>
                {device.id === selectedDeviceId && (
                  <span className="text-accent text-sm">&#10003;</span>
                )}
              </button>
            ))}

            {spotifyDevices.length > 0 && (
              <>
                <div className="px-3 py-1 mt-1 border-t border-white/10">
                  <p className="text-xs text-green-500 uppercase tracking-wider">Spotify Connect</p>
                </div>
                {spotifyDevices.map((d) => {
                  const id = `${SPOTIFY_CONNECT_PREFIX}${d.id}`;
                  return (
                    <button
                      key={id}
                      onClick={() => {
                        onSelect(id);
                        setOpen(false);
                      }}
                      className={`w-full text-left px-3 py-2 flex items-center gap-3 transition cursor-pointer
                        ${id === selectedDeviceId ? 'bg-accent/20 text-accent' : 'hover:bg-surface-light'}
                      `}
                    >
                      <span className="text-lg">{'\u{1F7E2}'}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{d.name}</p>
                        <p className="text-xs text-gray-500">
                          Spotify
                          {d.type && ` · ${d.type}`}
                          {d.is_active && ` · Active`}
                        </p>
                      </div>
                      {id === selectedDeviceId && (
                        <span className="text-accent text-sm">&#10003;</span>
                      )}
                    </button>
                  );
                })}
              </>
            )}

            {offlineDevices.length > 0 && (
              <>
                <div className="px-3 py-1 mt-1">
                  <p className="text-xs text-gray-600">Offline</p>
                </div>
                {offlineDevices.map((device) => (
                  <div key={device.id} className="px-3 py-2 flex items-center gap-3 opacity-40">
                    <span className="text-lg">{deviceTypeIcons[device.type] || '\u{1F50A}'}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm truncate">{device.name}</p>
                      <p className="text-xs text-gray-600">
                        {device.type.toUpperCase()} &middot; Offline
                      </p>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
