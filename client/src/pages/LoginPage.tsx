import { useState } from 'react';
import { api } from '../api/client.js';

interface Props {
  onAuth: (token: string) => void;
}

export default function LoginPage({ onAuth }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = isRegister
        ? await api.register(username, password)
        : await api.login(username, password);
      onAuth(res.data.token);
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface-dark flex items-center justify-center">
      <div className="w-full max-w-sm bg-surface rounded-xl p-8 shadow-xl">
        <h1 className="text-2xl font-bold text-accent mb-1">AudioServer</h1>
        <p className="text-sm text-gray-400 mb-6">
          {isRegister ? 'Create your account' : 'Sign in to continue'}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            className="w-full px-4 py-2.5 bg-surface-dark border border-white/10 rounded text-white placeholder-gray-500 focus:outline-none focus:border-accent"
            autoFocus
            required
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full px-4 py-2.5 bg-surface-dark border border-white/10 rounded text-white placeholder-gray-500 focus:outline-none focus:border-accent"
            required
            minLength={6}
          />

          {error && (
            <p className="text-sm text-red-400">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-accent rounded font-medium hover:bg-accent-hover transition disabled:opacity-50"
          >
            {loading ? '...' : isRegister ? 'Create Account' : 'Sign In'}
          </button>
        </form>

        <button
          onClick={() => { setIsRegister(!isRegister); setError(''); }}
          className="mt-4 text-sm text-gray-400 hover:text-accent transition block w-full text-center"
        >
          {isRegister ? 'Already have an account? Sign in' : 'First time? Create an account'}
        </button>
      </div>
    </div>
  );
}
