import { useState } from 'react';
import { api } from '../../api/client.js';
import { useToast } from '../../components/Toast.js';
import { getErrorMessage, type ProviderStatus } from './shared.js';

export default function QobuzCard({
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
        setError('Login failed');
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
