import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

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

    fetch(`/api/providers/${provider}/auth/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirectUri }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.data?.authenticated) {
          setStatus('success');
          setTimeout(() => navigate('/settings'), 1500);
        } else {
          setStatus('error');
          setError(data.error || 'Authentication failed');
        }
      })
      .catch((err) => {
        setStatus('error');
        setError(err.message);
      });
  }, [provider, navigate]);

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
