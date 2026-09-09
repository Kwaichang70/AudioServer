import { useState } from 'react';
import { api } from '../api/client.js';

interface Props {
  /** 'setup': no accounts exist yet, create the admin with the setup code. */
  mode: 'login' | 'setup';
  onAuth: (token: string) => void | Promise<void>;
}

export default function LoginPage({ mode, onAuth }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const isSetup = mode === 'setup';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = isSetup
        ? await api.register(username.trim(), password, setupCode.trim())
        : await api.login(username.trim(), password);
      await onAuth(res.data.token);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const inputClass =
    'w-full px-4 py-2.5 bg-surface-dark border border-white/10 rounded text-white placeholder-gray-500 focus:outline-none focus:border-accent';

  return (
    <div className="min-h-screen bg-surface-dark flex items-center justify-center">
      <div className="w-full max-w-sm bg-surface rounded-xl p-8 shadow-xl">
        <h1 className="text-2xl font-bold text-accent mb-1">AudioServer</h1>
        <p className="text-sm text-gray-400 mb-6">
          {isSetup ? 'First start: create the admin account' : 'Sign in to continue'}
        </p>

        {isSetup && (
          <div className="mb-5 text-xs text-gray-400 bg-surface-dark border border-white/10 rounded p-3 space-y-1">
            <p>
              This installation has no accounts yet. To prove you are the operator, enter the
              one-time <span className="text-white">setup code</span>.
            </p>
            <p>
              Find it in the server log (<code className="text-gray-300">docker logs</code>), in{' '}
              <code className="text-gray-300">setup-code.txt</code> next to the database, or in the{' '}
              <code className="text-gray-300">SETUP_CODE</code> environment variable if you set one.
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <label htmlFor="login-username" className="sr-only">
            Username
          </label>
          <input
            id="login-username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            autoComplete="username"
            className={inputClass}
            aria-invalid={error ? true : undefined}
            required
          />
          <label htmlFor="login-password" className="sr-only">
            {isSetup ? 'Password (8+ characters)' : 'Password'}
          </label>
          <input
            id="login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={isSetup ? 'Password (8+ characters)' : 'Password'}
            autoComplete={isSetup ? 'new-password' : 'current-password'}
            className={inputClass}
            aria-invalid={error ? true : undefined}
            required
            minLength={isSetup ? 8 : 1}
          />
          {isSetup && (
            <>
              <label htmlFor="login-setup-code" className="sr-only">
                Setup code
              </label>
              <input
                id="login-setup-code"
                type="text"
                value={setupCode}
                onChange={(e) => setSetupCode(e.target.value.toUpperCase())}
                placeholder="Setup code (e.g. 3F9A-C21B)"
                autoComplete="one-time-code"
                className={`${inputClass} font-mono tracking-wider`}
                required
              />
            </>
          )}

          {error && (
            <p className="text-sm text-red-400" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full min-h-[44px] py-2.5 bg-accent rounded font-medium hover:bg-accent-hover transition disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            {loading ? '...' : isSetup ? 'Create admin account' : 'Sign In'}
          </button>
        </form>

        {!isSetup && (
          <p className="mt-4 text-xs text-gray-500 text-center">
            No account? Ask the administrator to create one in Settings.
          </p>
        )}
      </div>
    </div>
  );
}
