import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import type { AudioPath, OutputCapabilities, TransitionRecord } from '../api/types.js';

/**
 * The audio path (V11.4).
 *
 * What this panel is for is what it refuses to say. A FLAC source is not proof
 * of a bit-perfect output, so every step carries how sure the server is of it,
 * and "gapless" appears only where a boundary has actually been measured. The
 * transition list shows how each boundary was made and, where one exists, the
 * measured gap next to the observed one.
 */

const certaintyStyle: Record<string, string> = {
  known: 'border-accent/50 text-accent',
  reported: 'border-white/20 text-gray-300',
  unknown: 'border-white/10 text-gray-500',
};

const certaintyLabel: Record<string, string> = {
  known: 'established',
  reported: 'device says so',
  unknown: 'not visible from here',
};

function gaplessLabel(caps: OutputCapabilities): { text: string; className: string } {
  if (caps.gapless === 'verified') {
    return {
      text: `gapless verified (worst measured ${caps.measuredGapMs} ms)`,
      className: 'text-accent',
    };
  }
  if (caps.gapless === 'unsupported') {
    return {
      text: 'not gapless: cannot take the next track in advance',
      className: 'text-gray-400',
    };
  }
  return { text: 'gapless not established — no boundary measured yet', className: 'text-gray-500' };
}

export default function AudioPathPanel() {
  const [path, setPath] = useState<AudioPath | null>(null);
  const [outputs, setOutputs] = useState<OutputCapabilities[]>([]);
  const [transitions, setTransitions] = useState<TransitionRecord[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback((refresh = false) => {
    setBusy(true);
    Promise.allSettled([
      api.getAudioPath(),
      api.getOutputCapabilities(refresh),
      api.getTransitions(undefined, 20),
    ])
      .then(([p, o, t]) => {
        if (p.status === 'fulfilled') setPath(p.value.data);
        if (o.status === 'fulfilled') setOutputs(o.value.data ?? []);
        if (t.status === 'fulfilled') setTransitions(t.value.data ?? []);
      })
      .finally(() => setBusy(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="mb-10" data-testid="audio-path-section">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-300">Audio path</h3>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={busy}
          className="min-h-[44px] px-4 text-sm bg-surface rounded border border-white/10 hover:bg-surface-dark transition disabled:opacity-50"
        >
          {busy ? 'Asking the devices…' : 'Ask the devices again'}
        </button>
      </div>

      <div className="bg-surface-light rounded-lg p-4 space-y-4 text-sm">
        {path ? (
          <>
            <p className="text-gray-400">{path.summary}</p>
            <ol className="space-y-2">
              {path.steps.map((step, i) => (
                <li
                  key={`${step.stage}-${i}`}
                  className={`border-l-2 pl-3 ${certaintyStyle[step.certainty] ?? certaintyStyle.unknown}`}
                >
                  <p className="font-medium">
                    {step.title}{' '}
                    <span className="ml-1 text-[10px] uppercase tracking-wide opacity-70">
                      {certaintyLabel[step.certainty]}
                    </span>
                  </p>
                  <p className="text-gray-400">{step.detail}</p>
                </li>
              ))}
            </ol>
            {path.caveats.length > 0 && (
              <ul className="text-xs text-gray-500 space-y-1">
                {path.caveats.map((caveat) => (
                  <li key={caveat}>· {caveat}</li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="text-gray-500">Nothing playing, or the path could not be read.</p>
        )}
      </div>

      <h4 className="text-sm font-semibold text-gray-400 mt-6 mb-2">What each output can do</h4>
      <div className="bg-surface-light rounded-lg p-4 space-y-3 text-sm">
        {outputs.length === 0 && <p className="text-gray-500">No outputs known yet.</p>}
        {outputs.map((caps) => {
          const gapless = gaplessLabel(caps);
          return (
            <div
              key={caps.deviceId}
              className="border-b border-white/5 pb-3 last:border-0 last:pb-0"
            >
              <p className="font-medium">
                {caps.deviceName}{' '}
                <span className="text-xs text-gray-500">({caps.type.toUpperCase()})</span>
              </p>
              <p className="text-xs text-gray-400">
                next track in advance: {caps.nextUri} · seek: {caps.seek} · ReplayGain:{' '}
                {caps.replayGain}
              </p>
              <p className={`text-xs ${gapless.className}`}>{gapless.text}</p>
              {caps.formats.length > 0 && (
                <p className="text-xs text-gray-500">accepts: {caps.formats.join(', ')}</p>
              )}
              {caps.limits.map((limit) => (
                <p key={limit} className="text-xs text-gray-500">
                  · {limit}
                </p>
              ))}
            </div>
          );
        })}
      </div>

      <h4 className="text-sm font-semibold text-gray-400 mt-6 mb-2">Recent track transitions</h4>
      <div className="bg-surface-light rounded-lg p-4 text-sm">
        {transitions.length === 0 ? (
          <p className="text-gray-500">No transitions recorded yet.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="pb-1">output</th>
                <th className="pb-1">handover</th>
                <th className="pb-1">observed</th>
                <th className="pb-1">measured</th>
              </tr>
            </thead>
            <tbody>
              {transitions.map((t) => (
                <tr key={t.id} className="text-gray-400">
                  <td className="py-0.5">{t.deviceId}</td>
                  <td className="py-0.5">{t.handover}</td>
                  <td className="py-0.5">
                    {t.observedGapMs === null ? '—' : `${t.observedGapMs} ms`}
                  </td>
                  <td className={`py-0.5 ${t.measuredGapMs !== null ? 'text-accent' : ''}`}>
                    {t.measuredGapMs === null ? 'not measured' : `${t.measuredGapMs} ms`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-xs text-gray-500 mt-3">
          Observed numbers come from the server watching a device (seconds of resolution) or from a
          browser tab timing its own handover. Only a measured boundary — a recording of the actual
          output — can support the words &ldquo;gapless verified&rdquo;.
        </p>
      </div>
    </section>
  );
}
