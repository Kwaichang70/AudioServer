import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { useToast } from '../../components/Toast.js';
import { getErrorMessage, type ScrobbleConfig } from './shared.js';

export default function ScrobblingSection() {
  const [config, setConfig] = useState<ScrobbleConfig | null>(null);
  const [lbToken, setLbToken] = useState('');
  const [lastfmToken, setLastfmToken] = useState('');
  const { toast } = useToast();

  const loadConfig = () => {
    api
      .getScrobbleConfig()
      .then((res) => setConfig(res.data))
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
