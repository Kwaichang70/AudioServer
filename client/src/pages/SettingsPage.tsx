import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useToast } from '../components/Toast.js';

interface ProviderStatus {
  available: boolean;
  authenticated: boolean;
  configured?: boolean;
}

interface AllStatus {
  tidal: ProviderStatus;
  spotify: ProviderStatus;
  qobuz: ProviderStatus;
}

export default function SettingsPage() {
  const [status, setStatus] = useState<AllStatus | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanInfo, setScanInfo] = useState('');
  const { toast } = useToast();

  const loadStatus = () => {
    fetch('/api/providers/status')
      .then((r) => r.json())
      .then((r) => setStatus(r.data))
      .catch(() => {});
  };

  const [lanAddress, setLanAddress] = useState<string | null>(null);
  useEffect(() => {
    loadStatus();
    fetch('/api/health').then(r => r.json()).then(d => {
      if (d.lanAddress) setLanAddress(d.lanAddress);
    }).catch(() => {});
  }, []);

  const connectProvider = async (provider: 'spotify' | 'tidal' | 'qobuz') => {
    try {
      // Build redirect URI using LAN IP (Spotify doesn't accept hostnames like 'diskstation')
      let origin = window.location.origin;
      if (lanAddress && !origin.includes('127.0.0.1')) {
        origin = `${window.location.protocol}//${lanAddress}:${window.location.port || '3001'}`;
      } else if (origin.includes('localhost')) {
        origin = origin.replace('localhost', '127.0.0.1');
      }
      const redirectUri = `${origin}/settings/callback/${provider}`;
      const res = await fetch(`/api/providers/${provider}/auth/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirectUri }),
      });
      const data = await res.json();
      if (data.data?.authUrl) {
        window.location.href = data.data.authUrl;
      } else {
        toast(data.error || 'Failed to get auth URL', 'error');
      }
    } catch (err: any) {
      toast(err.message || 'Connection failed', 'error');
    }
  };

  const disconnectProvider = async (provider: 'spotify' | 'tidal' | 'qobuz') => {
    await fetch(`/api/providers/${provider}/auth/logout`, { method: 'POST' });
    toast(`${provider} disconnected`, 'info');
    loadStatus();
  };

  const startScan = async () => {
    setScanning(true);
    await api.scanLibrary();
    const interval = setInterval(async () => {
      const res = await api.getScanStatus();
      const s = res.data;
      setScanInfo(`${s.processedFiles} files | ${s.artists} artists | ${s.albums} albums | ${s.tracks} tracks`);
      if (!s.isScanning) {
        clearInterval(interval);
        setScanning(false);
        setScanInfo('');
        toast('Library scan complete', 'success');
      }
    }, 2000);
  };

  return (
    <div className="max-w-2xl">
      <h2 className="text-2xl font-bold mb-8">Settings</h2>

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
          {scanning && scanInfo && (
            <p className="text-xs text-gray-400 animate-pulse">{scanInfo}</p>
          )}

          {/* Cover Art Fetch */}
          <div className="flex items-center justify-between pt-2 border-t border-white/5">
            <div>
              <p className="text-sm font-medium">Fetch Missing Cover Art</p>
              <p className="text-xs text-gray-500">Download covers from MusicBrainz for albums without embedded art</p>
            </div>
            <button
              onClick={async () => {
                const res = await fetch('/api/library/covers/fetch', { method: 'POST' });
                const data = await res.json();
                toast(data.message || 'Cover fetch started', 'info');
                // Poll status
                const interval = setInterval(async () => {
                  const statusRes = await fetch('/api/library/covers/fetch/status').then(r => r.json());
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
              <p className="text-xs text-gray-500">Download artist photos from Spotify (requires Spotify connection)</p>
            </div>
            <button
              onClick={async () => {
                const res = await fetch('/api/library/artists/images/fetch', { method: 'POST' });
                const data = await res.json();
                toast(data.message || 'Artist image fetch started', 'info');
                const interval = setInterval(async () => {
                  const statusRes = await fetch('/api/library/artists/images/fetch/status').then(r => r.json());
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
          />

          {/* Qobuz (username/password) */}
          <QobuzCard status={status?.qobuz} onStatusChange={loadStatus} />
        </div>
      </section>

      {/* Librespot */}
      <section className="mb-10">
        <h3 className="text-lg font-semibold mb-4 text-gray-300">Librespot (Spotify to any device)</h3>
        <div className="bg-surface-light rounded-lg p-4 space-y-3">
          <p className="text-xs text-gray-500">
            Librespot acts as a Spotify Connect receiver on this server, decoding audio and
            streaming it to any DLNA/Volumio device. Requires librespot + ffmpeg installed.
          </p>
          <p className="text-xs text-gray-500">
            Install: <code className="text-gray-400">cargo install librespot</code> and <code className="text-gray-400">ffmpeg</code>
          </p>
          <button
            onClick={async () => {
              const res = await fetch('/api/librespot/status').then(r => r.json());
              const d = res.data;
              toast(
                d.librespotInstalled
                  ? `Librespot: ${d.isRunning ? 'running' : 'stopped'}, ffmpeg: ${d.ffmpegInstalled ? 'yes' : 'no'}`
                  : 'Librespot not installed',
                d.librespotInstalled ? 'info' : 'error'
              );
            }}
            className="px-3 py-1.5 text-sm bg-surface-dark border border-white/10 rounded hover:border-accent transition"
          >
            Check Status
          </button>
        </div>
      </section>

      {/* Scrobbling */}
      <ScrobblingSection />

      {/* About */}
      <section>
        <h3 className="text-lg font-semibold mb-4 text-gray-300">About</h3>
        <div className="bg-surface-light rounded-lg p-4">
          <p className="text-sm text-gray-400">
            AudioServer &mdash; Self-hosted music streamer
          </p>
          <p className="text-xs text-gray-500 mt-1">
            Local library + Tidal + Spotify + Multi-room DLNA/Sonos output
          </p>
        </div>
      </section>
    </div>
  );
}

function QobuzCard({ status, onStatusChange }: { status?: ProviderStatus; onStatusChange: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { toast } = useToast();
  const authenticated = status?.authenticated ?? false;

  const handleLogin = async () => {
    if (!username || !password) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/providers/qobuz/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (data.data?.authenticated) {
        toast('Qobuz connected', 'success');
        setUsername('');
        setPassword('');
        onStatusChange();
      } else {
        setError(data.error || 'Login failed');
      }
    } catch (err: any) {
      setError(err.message || 'Login failed');
    }
    setLoading(false);
  };

  const handleLogout = async () => {
    await fetch('/api/providers/qobuz/auth/logout', { method: 'POST' });
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
              {authenticated ? 'Connected' : 'Login with your Qobuz account'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {authenticated && <span className="w-2 h-2 rounded-full bg-green-500" />}
          {authenticated && (
            <button onClick={handleLogout} className="px-3 py-1.5 text-xs text-gray-500 hover:text-red-400 transition">
              Disconnect
            </button>
          )}
        </div>
      </div>
      {!authenticated && (
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

function ScrobblingSection() {
  const [config, setConfig] = useState<any>(null);
  const [lbToken, setLbToken] = useState('');
  const [lastfmToken, setLastfmToken] = useState('');
  const { toast } = useToast();

  const loadConfig = () => {
    api.getScrobbleConfig().then((res) => setConfig(res.data)).catch(() => {});
  };

  useEffect(() => { loadConfig(); }, []);

  const connectLastfm = async () => {
    if (lastfmToken) {
      try {
        const res = await api.authenticateLastfm(lastfmToken);
        toast(`Last.fm connected as ${res.data.username}`, 'success');
        setLastfmToken('');
        loadConfig();
      } catch (err: any) {
        toast(err.message || 'Last.fm auth failed', 'error');
      }
    } else {
      try {
        const res = await api.getLastfmAuthUrl();
        window.open(res.data.url, '_blank');
        toast('Authorize in the browser tab, then paste the token here', 'info');
      } catch (err: any) {
        toast(err.message || 'Failed to get Last.fm auth URL', 'error');
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
    } catch (err: any) {
      toast(err.message || 'Invalid token', 'error');
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
                  onClick={async () => { await api.disconnectLastfm(); toast('Last.fm disconnected', 'info'); loadConfig(); }}
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
                placeholder="Paste Last.fm token after authorizing..."
                className="flex-1 px-3 py-1.5 text-sm bg-surface-dark border border-white/10 rounded text-white placeholder-gray-500 focus:outline-none focus:border-accent"
              />
              <button onClick={connectLastfm} className="px-4 py-1.5 text-sm bg-accent rounded hover:bg-accent-hover transition">
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
                  {config?.listenbrainz?.enabled ? 'Connected' : 'Paste your user token from listenbrainz.org/settings'}
                </p>
              </div>
            </div>
            {config?.listenbrainz?.enabled && (
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500" />
                <button
                  onClick={async () => { await api.disconnectListenbrainz(); toast('ListenBrainz disconnected', 'info'); loadConfig(); }}
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

function ProviderCard({ name, icon, status, onConnect, onDisconnect, envVars }: {
  name: string;
  icon: string;
  status?: ProviderStatus;
  onConnect: () => void;
  onDisconnect: () => void;
  envVars: string[];
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
