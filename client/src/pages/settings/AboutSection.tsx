import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { useToast } from '../../components/Toast.js';
import { useAuth } from '../../context/AuthContext.js';
import { useServiceWorkerState } from '../../sw/register.js';
import { getErrorMessage } from './shared.js';

/** Version, build ids and the redacted diagnostics document (V08.4). */
export default function AboutSection() {
  const { toast } = useToast();
  const { isAdmin } = useAuth();
  const [health, setHealth] = useState<{ version?: string; buildId?: string } | null>(null);
  const [diagnosticsText, setDiagnosticsText] = useState('');
  const { buildId: swBuildId } = useServiceWorkerState();

  useEffect(() => {
    api
      .getHealth()
      .then((d) => setHealth({ version: d.version, buildId: d.buildId }))
      .catch(() => {});
  }, []);

  return (
    <>
      <section className="mb-10" data-testid="about-section">
        <h3 className="text-lg font-semibold mb-4 text-gray-300">About</h3>
        <div className="bg-surface-light rounded-lg p-4 text-sm space-y-2">
          <p className="text-gray-400">
            AudioServer {health?.version ?? '…'}{' '}
            <span className="text-gray-600">
              server build {health?.buildId ?? '…'} · app build {__BUILD_ID__}
              {swBuildId && swBuildId !== __BUILD_ID__ ? ` · cached shell ${swBuildId}` : ''}
            </span>
          </p>
          {isAdmin && (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={async () => {
                  try {
                    const res = await api.getDiagnostics();
                    const text = JSON.stringify(res.data, null, 2);
                    try {
                      await navigator.clipboard.writeText(text);
                      toast('Diagnostics copied to the clipboard', 'success');
                    } catch {
                      setDiagnosticsText(text);
                    }
                  } catch (err) {
                    toast(getErrorMessage(err, 'Diagnostics failed'), 'error');
                  }
                }}
                className="min-h-[44px] px-4 text-sm bg-surface rounded border border-white/10 hover:bg-surface-dark transition"
              >
                Copy diagnostics
              </button>
              <span className="text-xs text-gray-500">
                Versions, scan and playback state, recent warnings. No tokens, passwords or full
                file paths.
              </span>
            </div>
          )}
          {diagnosticsText && (
            <textarea
              readOnly
              value={diagnosticsText}
              aria-label="Diagnostics"
              className="w-full h-48 text-xs font-mono bg-surface-dark border border-white/10 rounded p-2"
            />
          )}
        </div>
      </section>
      <section>
        <h3 className="text-lg font-semibold mb-4 text-gray-300">About</h3>
        <div className="bg-surface-light rounded-lg p-4">
          <p className="text-sm text-gray-400">AudioServer &mdash; Self-hosted music streamer</p>
          <p className="text-xs text-gray-500 mt-1">
            Local library + Tidal + Spotify + Multi-room DLNA/Sonos output
          </p>
        </div>
      </section>
    </>
  );
}
