import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';

export default function OAuthCallbackPage() {
  const { provider } = useParams<{ provider: string }>();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const errorParam = params.get('error');

    if (errorParam) {
      setStatus('error');
      setError(errorParam);
      return;
    }

    if (!code || !provider) {
      setStatus('error');
      setError('Missing authorization code');
      return;
    }

    // Use origin as-is (we were redirected here from Spotify with the correct URL)
    const redirectUri = `${window.location.origin}/settings/callback/${provider}`;

    api
      .providerAuthCallback(provider, code, redirectUri)
      .then((data) => {
        if (!data.data.authenticated) throw new Error('Authentication failed');
        setStatus('success');
        setTimeout(() => navigate('/settings'), 1500);
      })
      .catch((err: unknown) => {
        setStatus('error');
        setError(err instanceof Error ? err.message : 'Authentication failed');
      });
  }, [provider, navigate]);

  const retryBasic = () => {
    const redirectUri = `${window.location.origin}/settings/callback/spotify`;
    api
      .providerAuthInit('spotify', redirectUri, true)
      .then((res) => {
        window.location.href = res.data.authUrl;
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div className="min-h-screen bg-surface-dark flex items-center justify-center">
      <div className="text-center">
        {status === 'loading' && (
          <>
            <p className="text-xl font-medium mb-2">Connecting to {provider}...</p>
            <p className="text-gray-400 text-sm animate-pulse">Exchanging authorization code</p>
          </>
        )}
        {status === 'success' && (
          <>
            <p className="text-xl font-medium text-green-400 mb-2">Connected!</p>
            <p className="text-gray-400 text-sm">Redirecting to settings...</p>
          </>
        )}
        {status === 'error' && (
          <>
            <p className="text-xl font-medium text-red-400 mb-2">Connection Failed</p>
            <p className="text-gray-400 text-sm mb-4">{error}</p>
            {provider === 'spotify' && (
              // Spotify can refuse the whole request because of the playlist
              // scopes (Development Mode); playback still works without them.
              <div className="mb-4">
                <button
                  onClick={retryBasic}
                  className="px-4 py-2 bg-surface-light border border-white/10 rounded hover:border-accent transition text-sm"
                >
                  Try again without playlists
                </button>
                <p className="text-gray-500 text-xs mt-2 max-w-sm mx-auto">
                  Playback works; your Spotify playlists will not show in AudioServer.
                </p>
              </div>
            )}
            <button
              onClick={() => navigate('/settings')}
              className="px-4 py-2 bg-accent rounded hover:bg-accent-hover transition text-sm"
            >
              Back to Settings
            </button>
          </>
        )}
      </div>
    </div>
  );
}
