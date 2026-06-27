import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useToast } from '../components/Toast.js';
import { useAudioContext, type ReplayGainMode } from '../context/AudioContext.js';
import { DEVICE_POLL_INTERVAL, STORAGE_KEYS } from '../constants.js';
import { useSocket, type LibraryScanProgress } from '../hooks/useSocket.js';

interface ProviderStatus {
  available: boolean;
  authenticated: boolean;
  configured?: boolean;
  streamingAvailable?: boolean;
  reason?: string;
  formatId?: string;
  accountName?: string;
}

interface AllStatus {
  tidal: ProviderStatus;
  spotify: ProviderStatus;
  qobuz: ProviderStatus;
}

interface UserAccount {
  id: string;
  username: string;
  role: 'admin' | 'user' | string;
}

interface ScrobbleConfig {
  lastfm?: {
    enabled?: boolean;
    configured?: boolean;
    username?: string;
  };
  listenbrainz?: {
    enabled?: boolean;
  };
}

function getErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function formatScanInfo(status: LibraryScanProgress): string {
  if (status.phase === 'idle') return '';
  const percent =
    status.totalFiles > 0
      ? ` (${Math.round((status.processedFiles / status.totalFiles) * 100)}%)`
      : '';
  const current =
    status.currentFile || status.currentDir ? ` | ${status.currentFile || status.currentDir}` : '';
  const changed =
    status.newTracks || status.updatedTracks || status.removedTracks
      ? ` | +${status.newTracks} / ~${status.updatedTracks} / -${status.removedTracks}`
      : '';

  return `${status.phase}: ${status.processedFiles}/${status.totalFiles} files${percent} | ${status.artists} artists | ${status.albums} albums | ${status.tracks} tracks${changed}${current}`;
}

export default function SettingsPage() {
  const [status, setStatus] = useState<AllStatus | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanInfo, setScanInfo] = useState('');
  const { toast } = useToast();
  const socket = useSocket();
  const scanPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scanCompleteToastRef = useRef(false);

  const loadStatus = () => {
    api
      .getProviderStatus()
      .then((r) => setStatus(r.data))
      .catch(() => {});
  };

  const [lanAddress, setLanAddress] = useState<string | null>(null);
  useEffect(() => {
    loadStatus();
    api
      .getHealth()
      .then((d) => {
        if (d.lanAddress) setLanAddress(d.lanAddress);
      })
      .catch(() => {});
  }, []);

  const connectProvider = async (provider: 'spotify' | 'tidal' | 'qobuz') => {
    try {
      // Decide which origin to register as the OAuth redirect.
      let origin = window.location.origin;
      if (window.location.protocol === 'https:') {
        // Served over HTTPS (reverse proxy + real domain) → use it verbatim.
        // This is exactly what Spotify requires since April 2025, and the
        // domain matches the TLS cert. Do NOT rewrite to a LAN IP here.
        origin = window.location.origin;
      } else if (origin.includes('localhost')) {
        // Dev: Spotify accepts the http://127.0.0.1 loopback exception.
        origin = origin.replace('localhost', '127.0.0.1');
      } else if (lanAddress) {
        // Plain HTTP on a LAN hostname (e.g. http://diskstation:3001). Spotify
        // rejects bare hostnames; fall back to the LAN IP. (Spotify itself still
        // needs HTTPS — this path only helps Tidal/Qobuz.)
        origin = `${window.location.protocol}//${lanAddress}:${window.location.port || '3001'}`;
      }
      const redirectUri = `${origin}/settings/callback/${provider}`;
      const data = await api.providerAuthInit(provider, redirectUri);
      if (data.data?.authUrl) {
        window.location.href = data.data.authUrl;
      } else {
        toast(data.error || 'Failed to get auth URL', 'error');
      }
    } catch (err: unknown) {
      toast(getErrorMessage(err, 'Connection failed'), 'error');
    }
  };

  const disconnectProvider = async (provider: 'spotify' | 'tidal' | 'qobuz') => {
    await api.providerAuthLogout(provider);
    toast(`${provider} disconnected`, 'info');
    loadStatus();
  };

  const stopScanPolling = useCallback(() => {
    if (scanPollRef.current) {
      clearInterval(scanPollRef.current);
      scanPollRef.current = null;
    }
  }, []);

  const applyScanStatus = useCallback(
    (s: LibraryScanProgress) => {
      setScanning(s.isScanning);
      setScanInfo(formatScanInfo(s));

      if (s.isScanning) {
        scanCompleteToastRef.current = false;
        return;
      }

      stopScanPolling();
      if (s.phase === 'done' && !scanCompleteToastRef.current) {
        scanCompleteToastRef.current = true;
        toast('Library scan complete', 'success');
      }
    },
    [stopScanPolling, toast],
  );

  const startScanPolling = useCallback(() => {
    stopScanPolling();
    scanPollRef.current = setInterval(async () => {
      const res = await api.getScanStatus();
      applyScanStatus(res.data);
    }, DEVICE_POLL_INTERVAL);
  }, [applyScanStatus, stopScanPolling]);

  useEffect(() => {
    if (socket.scanProgress) applyScanStatus(socket.scanProgress);
  }, [applyScanStatus, socket.scanProgress]);

  useEffect(() => () => stopScanPolling(), [stopScanPolling]);

  const startScan = async () => {
    setScanning(true);
    scanCompleteToastRef.current = false;
    const res = await api.scanLibrary();
    applyScanStatus(res.data);
    if (!socket.connected) startScanPolling();
  };

  const { replayGainMode, setReplayGainMode, replayGainPreamp, setReplayGainPreamp } =
    useAudioContext();

  return (
    <div className="max-w-2xl">
      <h2 className="text-2xl font-bold mb-8">Settings</h2>

      {/* Playback — ReplayGain volume normalisation */}
      <section className="mb-10">
        <h3 className="text-lg font-semibold mb-4 text-gray-300">Playback</h3>
        <div className="bg-surface-light rounded-lg p-4 space-y-4">
          <div>
            <p className="text-sm font-medium mb-1">ReplayGain mode</p>
            <p className="text-xs text-gray-500 mb-2">
              Normalise volume across tracks using metadata tags. Track-mode levels every song
              individually; album-mode preserves intentional loudness differences within an album.
              Off disables normalisation entirely.
            </p>
            <div className="flex gap-2">
              {(['off', 'track', 'album'] as ReplayGainMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setReplayGainMode(m)}
                  className={`px-3 py-1.5 text-sm rounded border transition ${
                    replayGainMode === m
                      ? 'bg-accent border-accent text-white'
                      : 'bg-surface-dark border-white/10 hover:border-accent'
                  }`}
                >
                  {m === 'off' ? 'Off' : m === 'track' ? 'Track' : 'Album'}
                </button>
              ))}
            </div>
          </div>

          <div className="pt-3 border-t border-white/5">
            <div className="flex items-center justify-between mb-1">
              <p className="text-sm font-medium">Preamp</p>
              <span className="text-xs text-gray-400 tabular-nums">
                {replayGainPreamp > 0 ? '+' : ''}
                {replayGainPreamp.toFixed(1)} dB
              </span>
            </div>
            <p className="text-xs text-gray-500 mb-2">
              Global gain offset applied on top of ReplayGain. Use +6&nbsp;dB if normalised tracks
              sound too quiet, &minus;3&nbsp;dB if they clip on aggressive masters.
            </p>
            <input
              type="range"
              min={-15}
              max={15}
              step={0.5}
              value={replayGainPreamp}
              onChange={(e) => setReplayGainPreamp(Number(e.target.value))}
              className="w-full accent-accent"
            />
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>&minus;15 dB</span>
              <span>0</span>
              <span>+15 dB</span>
            </div>
          </div>
        </div>
      </section>

      {/* Library */}
      <section className="mb-10">
        <h3 className="text-lg font-semibold mb-4 text-gray-300">Local Library</h3>
        <div className="bg-surface-light rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Music Library Scanner</p>
              <p className="text-xs text-gray-500">Scan your local music folders for new tracks</p>
            </div>
            <button
              onClick={startScan}
              disabled={scanning}
              className="px-4 py-1.5 text-sm bg-accent rounded hover:bg-accent-hover transition disabled:opacity-50"
            >
              {scanning ? 'Scanning...' : 'Scan Now'}
            </button>
          </div>
          {(scanning || scanInfo) && (
            <p className="text-xs text-gray-400 animate-pulse">{scanInfo}</p>
          )}

          {/* Cover Art Fetch */}
          <div className="flex items-center justify-between pt-2 border-t border-white/5">
            <div>
              <p className="text-sm font-medium">Fetch Missing Cover Art</p>
              <p className="text-xs text-gray-500">
                Download covers from MusicBrainz for albums without embedded art
              </p>
            </div>
            <button
              onClick={async () => {
                // Use the api client so the Bearer token is attached — requireAuth
                // would otherwise 401 these /api/* calls.
                const data = await api.fetchCovers();
                toast(data.message || 'Cover fetch started', 'info');
                const interval = setInterval(async () => {
                  const statusRes = await api.getCoverFetchStatus();
                  const s = statusRes.data;
                  if (s.isRunning) {
                    toast(`Covers: ${s.processed}/${s.total} (${s.found} found)`, 'info');
                  } else {
                    clearInterval(interval);
                    toast(`Cover art done: ${s.found} found, ${s.notFound} not found`, 'success');
                  }
                }, 10000);
              }}
              className="px-4 py-1.5 text-sm bg-surface-dark border border-white/10 rounded hover:border-accent transition"
            >
              Fetch Covers
            </button>
          </div>

          {/* Artist Images */}
          <div className="flex items-center justify-between pt-2 border-t border-white/5">
            <div>
              <p className="text-sm font-medium">Fetch Artist Images</p>
              <p className="text-xs text-gray-500">
                Download artist photos from Spotify (requires Spotify connection)
              </p>
            </div>
            <button
              onClick={async () => {
                const data = await api.fetchArtistImages();
                toast(data.message || 'Artist image fetch started', 'info');
                const interval = setInterval(async () => {
                  const statusRes = await api.getArtistImageFetchStatus();
                  const s = statusRes.data;
                  if (s.isRunning) {
                    toast(`Artists: ${s.processed}/${s.total} (${s.found} found)`, 'info');
                  } else {
                    clearInterval(interval);
                    toast(`Artist images done: ${s.found} found`, 'success');
                  }
                }, 10000);
              }}
              className="px-4 py-1.5 text-sm bg-surface-dark border border-white/10 rounded hover:border-accent transition"
            >
              Fetch Images
            </button>
          </div>
        </div>
      </section>

      {/* Streaming Providers */}
      <section className="mb-10">
        <h3 className="text-lg font-semibold mb-4 text-gray-300">Streaming Providers</h3>
        <div className="space-y-3">
          {/* Spotify */}
          <ProviderCard
            name="Spotify"
            icon="&#127925;"
            status={status?.spotify}
            onConnect={() => connectProvider('spotify')}
            onDisconnect={() => disconnectProvider('spotify')}
            envVars={['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET']}
          />

          {/* Tidal */}
          <ProviderCard
            name="Tidal"
            icon="&#127926;"
            status={status?.tidal}
            onConnect={() => connectProvider('tidal')}
            onDisconnect={() => disconnectProvider('tidal')}
            envVars={['TIDAL_CLIENT_ID', 'TIDAL_CLIENT_SECRET']}
            note="Catalog and preview only. Use Qobuz or local NAS playback for full tracks."
          />

          {/* Qobuz (username/password) */}
          <QobuzCard status={status?.qobuz} onStatusChange={loadStatus} />
        </div>
      </section>

      {/* Librespot */}
      <section className="mb-10">
        <h3 className="text-lg font-semibold mb-4 text-gray-300">
          Librespot (Spotify to any device)
        </h3>
        <div className="bg-surface-light rounded-lg p-4 space-y-3">
          <p className="text-xs text-gray-500">
            Librespot acts as a Spotify Connect receiver on this server, decoding audio and
            streaming it to any DLNA/Volumio device. Requires librespot + ffmpeg installed.
          </p>
          <p className="text-xs text-gray-500">
            Install: <code className="text-gray-400">cargo install librespot</code> and{' '}
            <code className="text-gray-400">ffmpeg</code>
          </p>
          <button
            onClick={async () => {
              const res = await api.librespotStatus();
              const d = res.data;
              toast(
                d.librespotInstalled
                  ? `Librespot: ${d.isRunning ? 'running' : 'stopped'}, ffmpeg: ${d.ffmpegInstalled ? 'yes' : 'no'}`
                  : 'Librespot not installed',
                d.librespotInstalled ? 'info' : 'error',
              );
            }}
            className="px-3 py-1.5 text-sm bg-surface-dark border border-white/10 rounded hover:border-accent transition"
          >
            Check Status
          </button>
        </div>
      </section>

      {/* Theme */}
      <ThemeSection />

      {/* User Management */}
      <UserManagementSection />

      {/* Scrobbling */}
      <ScrobblingSection />

      {/* About */}
      <section>
        <h3 className="text-lg font-semibold mb-4 text-gray-300">About</h3>
        <div className="bg-surface-light rounded-lg p-4">
          <p className="text-sm text-gray-400">AudioServer &mdash; Self-hosted music streamer</p>
          <p className="text-xs text-gray-500 mt-1">
            Local library + Tidal + Spotify + Multi-room DLNA/Sonos output
          </p>
        </div>
      </section>
    </div>
  );
}

function QobuzCard({
  status,
  onStatusChange,
}: {
  status?: ProviderStatus;
  onStatusChange: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { toast } = useToast();
  const authenticated = status?.authenticated ?? false;
  const configured = status?.configured ?? false;
  const streamingAvailable = status?.streamingAvailable ?? false;
  const formatId = status?.formatId || '5';

  const handleLogin = async () => {
    if (!configured || !username || !password) return;
    setLoading(true);
    setError('');
    try {
      const data = await api.qobuzLogin(username, password);
      if (data.data?.authenticated) {
        toast('Qobuz connected', 'success');
        setUsername('');
        setPassword('');
        onStatusChange();
      } else {
        setError(data.error || 'Login failed');
      }
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Login failed'));
    }
    setLoading(false);
  };

  const handleLogout = async () => {
    await api.providerAuthLogout('qobuz');
    toast('Qobuz disconnected', 'info');
    onStatusChange();
  };

  return (
    <div className="bg-surface-light rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <span className="text-2xl">&#127927;</span>
          <div>
            <p className="text-sm font-medium">Qobuz</p>
            <p className="text-xs text-gray-500">
              {!configured
                ? 'Set QOBUZ_APP_ID and QOBUZ_APP_SECRET on the server'
                : authenticated
                  ? `External playback source connected${status?.accountName ? ` as ${status.accountName}` : ''}`
                  : 'Login with your Qobuz account'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {configured && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-900/40 text-purple-300">
              format {formatId}
            </span>
          )}
          {streamingAvailable && <span className="w-2 h-2 rounded-full bg-green-500" />}
          {authenticated && (
            <button
              onClick={handleLogout}
              className="px-3 py-1.5 text-xs text-gray-500 hover:text-red-400 transition"
            >
              Disconnect
            </button>
          )}
        </div>
      </div>
      {!configured && (
        <p className="text-xs text-amber-400">
          Qobuz streaming is disabled until app credentials are configured. User login alone is not
          enough for full-track playback.
        </p>
      )}
      {configured && !authenticated && (
        <div className="space-y-2">
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Qobuz email"
            className="w-full px-3 py-1.5 text-sm bg-surface-dark border border-white/10 rounded text-white placeholder-gray-500 focus:outline-none focus:border-accent"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
            placeholder="Password"
            className="w-full px-3 py-1.5 text-sm bg-surface-dark border border-white/10 rounded text-white placeholder-gray-500 focus:outline-none focus:border-accent"
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            onClick={handleLogin}
            disabled={loading || !username || !password}
            className="px-4 py-1.5 text-sm bg-accent rounded hover:bg-accent-hover transition disabled:opacity-50"
          >
            {loading ? 'Logging in...' : 'Login'}
          </button>
        </div>
      )}
    </div>
  );
}

function ThemeSection() {
  const [theme, setTheme] = useState(() => localStorage.getItem(STORAGE_KEYS.theme) || 'dark');

  const applyTheme = (t: string) => {
    setTheme(t);
    localStorage.setItem(STORAGE_KEYS.theme, t);
    document.documentElement.setAttribute('data-theme', t);
  };

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, []);

  const themes = [
    { id: 'dark', label: 'Dark', desc: 'Default dark theme' },
    { id: 'light', label: 'Light', desc: 'Light backgrounds' },
    { id: 'oled', label: 'OLED', desc: 'Pure black for OLED screens' },
  ];

  return (
    <section className="mb-10">
      <h3 className="text-lg font-semibold mb-4 text-gray-300">Theme</h3>
      <div className="flex gap-3">
        {themes.map((t) => (
          <button
            key={t.id}
            onClick={() => applyTheme(t.id)}
            className={`flex-1 p-3 rounded-lg border transition text-center ${
              theme === t.id
                ? 'border-accent bg-accent/10'
                : 'border-white/10 bg-surface-light hover:border-accent/50'
            }`}
          >
            <p className="text-sm font-medium">{t.label}</p>
            <p className="text-xs text-gray-500 mt-0.5">{t.desc}</p>
          </button>
        ))}
      </div>
    </section>
  );
}

function UserManagementSection() {
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('user');
  const { toast } = useToast();

  useEffect(() => {
    api
      .getMe()
      .then((res: { data?: { role?: string } }) => {
        if (res.data?.role === 'admin') {
          setIsAdmin(true);
          api
            .getUsers()
            .then((r: { data: UserAccount[] }) => setUsers(r.data))
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, []);

  if (!isAdmin) return null;

  const handleCreate = async () => {
    if (!newUsername.trim() || !newPassword) return;
    try {
      await api.createUser(newUsername.trim(), newPassword, newRole);
      toast(`User "${newUsername}" created`, 'success');
      setNewUsername('');
      setNewPassword('');
      setShowCreate(false);
      api
        .getUsers()
        .then((r) => setUsers(r.data))
        .catch(() => {});
    } catch (err: unknown) {
      toast(getErrorMessage(err, 'Failed to create user'), 'error');
    }
  };

  const handleDelete = async (id: string, username: string) => {
    try {
      await api.deleteUser(id);
      toast(`User "${username}" deleted`, 'info');
      setUsers((prev) => prev.filter((u) => u.id !== id));
    } catch (err: unknown) {
      toast(getErrorMessage(err, 'Failed to delete user'), 'error');
    }
  };

  return (
    <section className="mb-10">
      <h3 className="text-lg font-semibold mb-4 text-gray-300">User Management</h3>
      <div className="bg-surface-light rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-400">{users.length} user(s)</p>
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="px-3 py-1 text-sm bg-accent rounded hover:bg-accent-hover transition"
          >
            + Add User
          </button>
        </div>

        {showCreate && (
          <div className="flex gap-2 flex-wrap">
            <input
              type="text"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              placeholder="Username"
              className="flex-1 min-w-[140px] px-3 py-1.5 text-sm bg-surface-dark border border-white/10 rounded text-white placeholder-gray-500 focus:outline-none focus:border-accent"
            />
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Password (8+ chars)"
              className="flex-1 min-w-[140px] px-3 py-1.5 text-sm bg-surface-dark border border-white/10 rounded text-white placeholder-gray-500 focus:outline-none focus:border-accent"
            />
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value)}
              className="px-3 py-1.5 text-sm bg-surface-dark border border-white/10 rounded text-white"
            >
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
            <button
              onClick={handleCreate}
              className="px-4 py-1.5 text-sm bg-accent rounded hover:bg-accent-hover transition"
            >
              Create
            </button>
          </div>
        )}

        {users.map((user) => (
          <div key={user.id} className="flex items-center justify-between py-1">
            <div>
              <span className="text-sm">{user.username}</span>
              <span
                className={`ml-2 text-[10px] px-1.5 py-0.5 rounded ${
                  user.role === 'admin' ? 'bg-accent/20 text-accent' : 'bg-white/5 text-gray-500'
                }`}
              >
                {user.role}
              </span>
            </div>
            {user.role !== 'admin' && (
              <button
                onClick={() => handleDelete(user.id, user.username)}
                className="text-xs text-gray-600 hover:text-red-400 transition"
              >
                Delete
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function ScrobblingSection() {
  const [config, setConfig] = useState<ScrobbleConfig | null>(null);
  const [lbToken, setLbToken] = useState('');
  const [lastfmToken, setLastfmToken] = useState('');
  const { toast } = useToast();

  const loadConfig = () => {
    api
      .getScrobbleConfig()
      .then((res: { data: ScrobbleConfig }) => setConfig(res.data))
      .catch(() => {});
  };

  useEffect(() => {
    loadConfig();
  }, []);

  const connectLastfm = async () => {
    if (lastfmToken) {
      try {
        const res = await api.authenticateLastfm(lastfmToken);
        toast(`Last.fm connected as ${res.data.username}`, 'success');
        setLastfmToken('');
        loadConfig();
      } catch (err: unknown) {
        toast(getErrorMessage(err, 'Last.fm auth failed'), 'error');
      }
    } else {
      try {
        const res = await api.getLastfmAuthUrl();
        // Remember the request token so "Submit" can exchange it — no manual
        // paste needed. The opened URL carries api_key + this token.
        setLastfmToken(res.data.token);
        window.open(res.data.url, '_blank');
        toast('Allow access in the new tab, then click Submit here', 'info');
      } catch (err: unknown) {
        toast(getErrorMessage(err, 'Failed to get Last.fm auth URL'), 'error');
      }
    }
  };

  const connectListenbrainz = async () => {
    if (!lbToken.trim()) return;
    try {
      await api.authenticateListenbrainz(lbToken.trim());
      toast('ListenBrainz connected', 'success');
      setLbToken('');
      loadConfig();
    } catch (err: unknown) {
      toast(getErrorMessage(err, 'Invalid token'), 'error');
    }
  };

  return (
    <section className="mb-10">
      <h3 className="text-lg font-semibold mb-4 text-gray-300">Scrobbling</h3>
      <div className="space-y-3">
        {/* Last.fm */}
        <div className="bg-surface-light rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <span className="text-2xl">&#127928;</span>
              <div>
                <p className="text-sm font-medium">Last.fm</p>
                <p className="text-xs text-gray-500">
                  {config?.lastfm?.enabled
                    ? `Scrobbling as ${config.lastfm.username || 'connected'}`
                    : config?.lastfm?.configured
                      ? 'Not connected'
                      : 'Set LASTFM_API_KEY and LASTFM_API_SECRET in .env'}
                </p>
              </div>
            </div>
            {config?.lastfm?.enabled && (
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500" />
                <button
                  onClick={async () => {
                    await api.disconnectLastfm();
                    toast('Last.fm disconnected', 'info');
                    loadConfig();
                  }}
                  className="text-xs text-gray-500 hover:text-red-400 transition"
                >
                  Disconnect
                </button>
              </div>
            )}
          </div>
          {config?.lastfm?.configured && !config?.lastfm?.enabled && (
            <div className="flex gap-2 mt-2">
              <input
                type="text"
                value={lastfmToken}
                onChange={(e) => setLastfmToken(e.target.value)}
                placeholder="Click Authorize, allow access, then Submit"
                className="flex-1 px-3 py-1.5 text-sm bg-surface-dark border border-white/10 rounded text-white placeholder-gray-500 focus:outline-none focus:border-accent"
              />
              <button
                onClick={connectLastfm}
                className="px-4 py-1.5 text-sm bg-accent rounded hover:bg-accent-hover transition"
              >
                {lastfmToken ? 'Submit Token' : 'Authorize'}
              </button>
            </div>
          )}
        </div>

        {/* ListenBrainz */}
        <div className="bg-surface-light rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <span className="text-2xl">&#127911;</span>
              <div>
                <p className="text-sm font-medium">ListenBrainz</p>
                <p className="text-xs text-gray-500">
                  {config?.listenbrainz?.enabled
                    ? 'Connected'
                    : 'Paste your user token from listenbrainz.org/settings'}
                </p>
              </div>
            </div>
            {config?.listenbrainz?.enabled && (
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500" />
                <button
                  onClick={async () => {
                    await api.disconnectListenbrainz();
                    toast('ListenBrainz disconnected', 'info');
                    loadConfig();
                  }}
                  className="text-xs text-gray-500 hover:text-red-400 transition"
                >
                  Disconnect
                </button>
              </div>
            )}
          </div>
          {!config?.listenbrainz?.enabled && (
            <div className="flex gap-2 mt-2">
              <input
                type="text"
                value={lbToken}
                onChange={(e) => setLbToken(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && connectListenbrainz()}
                placeholder="ListenBrainz user token..."
                className="flex-1 px-3 py-1.5 text-sm bg-surface-dark border border-white/10 rounded text-white placeholder-gray-500 focus:outline-none focus:border-accent"
              />
              <button
                onClick={connectListenbrainz}
                disabled={!lbToken.trim()}
                className="px-4 py-1.5 text-sm bg-accent rounded hover:bg-accent-hover transition disabled:opacity-50"
              >
                Connect
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ProviderCard({
  name,
  icon,
  status,
  onConnect,
  onDisconnect,
  envVars,
  note,
}: {
  name: string;
  icon: string;
  status?: ProviderStatus;
  onConnect: () => void;
  onDisconnect: () => void;
  envVars: string[];
  note?: string;
}) {
  const configured = status?.configured ?? status?.available ?? false;
  const authenticated = status?.authenticated ?? false;

  return (
    <div className="bg-surface-light rounded-lg p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl">{icon}</span>
          <div>
            <p className="text-sm font-medium">{name}</p>
            <p className="text-xs text-gray-500">
              {!configured
                ? `Not configured \u2014 set ${envVars.join(' and ')} in .env`
                : authenticated
                  ? 'Connected'
                  : 'Not connected'}
            </p>
            {note && <p className="text-xs text-amber-400 mt-1">{note}</p>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {authenticated && (
            <span className="w-2 h-2 rounded-full bg-green-500" title="Connected" />
          )}
          {configured && !authenticated && (
            <button
              onClick={onConnect}
              className="px-4 py-1.5 text-sm bg-accent rounded hover:bg-accent-hover transition"
            >
              Connect
            </button>
          )}
          {authenticated && (
            <button
              onClick={onDisconnect}
              className="px-3 py-1.5 text-xs text-gray-500 hover:text-red-400 transition"
            >
              Disconnect
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
