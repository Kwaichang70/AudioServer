import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { useToast } from '../../components/Toast.js';
import type { ApiKeyInfo } from '../../api/types.js';
import { formatWhen, getErrorMessage } from './shared.js';

/**
 * API keys for assistants and automations — Grok, Jarvis, Homey. A key can
 * control playback and read the library, nothing else; it is shown once,
 * the server keeps only a hash, and revoking it stops it at once.
 */
export default function ApiKeysSection() {
  const { toast } = useToast();
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<{ name: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .getApiKeys()
      .then((r) => setKeys(r.data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    const label = name.trim();
    if (!label) return;
    setBusy(true);
    try {
      const res = await api.createApiKey(label);
      setFresh({ name: res.data.name, key: res.data.key });
      setName('');
      load();
    } catch (err) {
      toast(getErrorMessage(err, 'Could not make the key'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (key: ApiKeyInfo) => {
    if (!window.confirm(`Revoke "${key.name}"? Whatever uses it stops working at once.`)) return;
    try {
      await api.revokeApiKey(key.id);
      toast(`"${key.name}" revoked`, 'info');
      load();
    } catch (err) {
      toast(getErrorMessage(err, 'Could not revoke the key'), 'error');
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied', 'success');
    } catch {
      toast('Copy failed; select the key and copy it yourself', 'error');
    }
  };

  return (
    <section className="mb-10">
      <h3 className="text-lg font-semibold mb-4 text-gray-300">API keys</h3>
      <div className="bg-surface-light rounded-lg p-4 space-y-3">
        <p className="text-sm text-gray-400">
          For assistants and automations such as Grok, Jarvis or Homey. A key can control playback
          and read your library — nothing else — and acts as you.
        </p>

        <div className="flex gap-2 flex-wrap">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
            placeholder="Name, e.g. Grok"
            aria-label="Key name"
            maxLength={60}
            className="flex-1 min-w-[140px] px-3 py-1.5 text-sm bg-surface-dark border border-white/10 rounded text-white placeholder-gray-500 focus:outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={() => void create()}
            disabled={busy || !name.trim()}
            className="px-4 py-1.5 text-sm bg-accent rounded hover:bg-accent-hover transition disabled:opacity-40"
          >
            Make key
          </button>
        </div>

        {fresh && (
          <div className="rounded border border-accent/40 bg-accent/10 p-3 space-y-2" role="status">
            <p className="text-sm">
              Key for <strong>{fresh.name}</strong> — copy it now, it is not shown again:
            </p>
            <div className="flex gap-2 items-center">
              <code className="flex-1 min-w-0 break-all text-xs bg-surface-dark rounded px-2 py-1 select-all">
                {fresh.key}
              </code>
              <button
                type="button"
                onClick={() => void copy(fresh.key)}
                className="shrink-0 px-3 py-1 text-xs bg-surface-dark border border-white/10 rounded hover:border-accent transition"
              >
                Copy
              </button>
            </div>
            <p className="text-xs text-gray-400">
              Send it as <code>Authorization: Bearer …</code> or <code>X-API-Key: …</code>.
            </p>
            <button
              type="button"
              onClick={() => setFresh(null)}
              className="text-xs text-gray-400 hover:text-white transition"
            >
              I have copied it
            </button>
          </div>
        )}

        {keys.length === 0 ? (
          <p className="text-xs text-gray-500">No keys yet.</p>
        ) : (
          <ul className="divide-y divide-white/5">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="text-sm truncate">{k.name}</p>
                  <p className="text-xs text-gray-500 truncate">
                    {k.prefix}… · made {formatWhen(k.createdAt)} ·{' '}
                    {k.lastUsedAt ? `last used ${formatWhen(k.lastUsedAt)}` : 'never used'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void revoke(k)}
                  className="shrink-0 text-xs text-gray-500 hover:text-red-400 transition"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
