import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { useToast } from '../../components/Toast.js';
import QobuzCard from './QobuzCard.js';
import ProviderCard from './ProviderCard.js';
import { getErrorMessage, type AllStatus } from './shared.js';

/** Connecting Spotify, Tidal and Qobuz (R02.4: moved out of SettingsPage). */
export default function ProvidersSection() {
  const { toast } = useToast();
  const [status, setStatus] = useState<AllStatus | null>(null);
  // The OAuth redirect URL a provider has to allow names this server by its
  // address on the LAN, so the cards can show what to paste.
  const [lanAddress, setLanAddress] = useState<string | null>(null);

  const loadStatus = () => {
    api
      .getProviderStatus()
      .then((r) => setStatus(r.data))
      .catch(() => {});
  };
  useEffect(() => {
    loadStatus();
    api
      .getHealth()
      .then((d) => setLanAddress(d.lanAddress ?? null))
      .catch(() => {});
    // Only on mount: the cards reload on their own after connecting.
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
      window.location.href = data.data.authUrl;
    } catch (err: unknown) {
      toast(getErrorMessage(err, 'Connection failed'), 'error');
    }
  };

  const disconnectProvider = async (provider: 'spotify' | 'tidal' | 'qobuz') => {
    await api.providerAuthLogout(provider);
    toast(`${provider} disconnected`, 'info');
    loadStatus();
  };

  return (
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
  );
}
