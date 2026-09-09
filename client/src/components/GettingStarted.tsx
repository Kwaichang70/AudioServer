import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { OutputDevice } from '@audioserver/shared';
import { api } from '../api/client.js';
import type { ProviderStatuses, ScanRun } from '../api/types.js';
import { STORAGE_KEYS } from '../constants.js';
import { useAudioContext } from '../context/AudioContext.js';
import { useAuth } from '../context/AuthContext.js';

/**
 * Guided first experience (V08.2): three things a new installation needs,
 * each with its real status and one short next step. Shown until dismissed;
 * comes back by itself while the library is still empty, because then the
 * app cannot do anything yet.
 */

type StepState = 'ok' | 'todo' | 'warn' | 'loading';

interface Step {
  key: 'library' | 'sources' | 'output';
  title: string;
  state: StepState;
  detail: string;
  action?: { to: string; label: string };
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEYS.onboardingDismissed) === '1';
  } catch {
    return false;
  }
}

const STATE_STYLE: Record<StepState, string> = {
  ok: 'bg-green-500/20 text-green-300',
  todo: 'bg-amber-500/20 text-amber-200',
  warn: 'bg-red-500/20 text-red-200',
  loading: 'bg-white/10 text-gray-400',
};
const STATE_LABEL: Record<StepState, string> = {
  ok: 'Done',
  todo: 'To do',
  warn: 'Attention',
  loading: '…',
};

export default function GettingStarted() {
  const { isAdmin } = useAuth();
  const { selectedDeviceId } = useAudioContext();
  const [dismissed, setDismissed] = useState(readDismissed);
  const [tracks, setTracks] = useState<number | null>(null);
  const [lastRun, setLastRun] = useState<ScanRun | null | undefined>(undefined);
  const [scanning, setScanning] = useState(false);
  const [providers, setProviders] = useState<ProviderStatuses | null>(null);
  const [devices, setDevices] = useState<OutputDevice[] | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  const load = useCallback(() => {
    api
      .getStats()
      .then((r) => setTracks(r.data.tracks))
      .catch(() => setUnreachable(true));
    api
      .getScanStatus()
      .then((r) => {
        setLastRun(r.lastSuccessfulRun ?? null);
        setScanning(r.data.isScanning);
      })
      .catch(() => setLastRun(null));
    api
      .getProviderStatus()
      .then((r) => setProviders(r.data))
      .catch(() => setProviders(null));
    api
      .getDevices()
      .then((r) => setDevices(r.data))
      .catch(() => setDevices([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const libraryEmpty = tracks === 0;
  if (dismissed && !libraryEmpty) return null;

  const failedRoots = lastRun?.failedRoots ?? [];
  const library: Step = {
    key: 'library',
    title: 'Music library',
    state:
      tracks === null ? 'loading' : failedRoots.length > 0 ? 'warn' : tracks > 0 ? 'ok' : 'todo',
    detail:
      tracks === null
        ? unreachable
          ? 'The server did not answer. Check that AudioServer is running.'
          : 'Checking the library…'
        : scanning
          ? 'A scan is running; tracks appear as it goes.'
          : failedRoots.length > 0
            ? `${tracks} tracks, but ${failedRoots.length} music folder(s) could not be read: ${failedRoots
                .map((r) => r.path)
                .join(', ')}. Existing music was kept.`
            : tracks > 0
              ? `${tracks} tracks${lastRun?.finishedAt ? `, last scan ${new Date(lastRun.finishedAt * 1000).toLocaleDateString()}` : ''}.`
              : lastRun === null
                ? 'No scan has run yet. Point MUSIC_LIBRARY_PATHS at your music and scan.'
                : 'The last scan found no music. Check the folder path and file formats.',
    action: isAdmin ? { to: '/settings', label: 'Scan in Settings' } : undefined,
  };

  const connected = providers
    ? (['qobuz', 'spotify', 'tidal'] as const).filter((p) => providers[p]?.authenticated)
    : [];
  const configured = providers
    ? (['qobuz', 'spotify', 'tidal'] as const).filter(
        (p) => providers[p]?.configured && !providers[p]?.authenticated,
      )
    : [];
  const sources: Step = {
    key: 'sources',
    title: 'Streaming sources',
    state:
      providers === null
        ? 'loading'
        : connected.length > 0
          ? 'ok'
          : configured.length > 0
            ? 'todo'
            : 'ok',
    detail:
      providers === null
        ? 'Checking connections…'
        : connected.length > 0
          ? `Connected: ${connected.join(', ')}.${configured.length > 0 ? ` Not signed in yet: ${configured.join(', ')}.` : ''}`
          : configured.length > 0
            ? `${configured.join(', ')} ${configured.length === 1 ? 'is' : 'are'} configured but not signed in.`
            : 'Optional. Local music works without them; add Qobuz or Spotify in Settings when you want.',
    action: isAdmin
      ? {
          to: '/settings',
          label: connected.length > 0 ? 'Manage in Settings' : 'Connect in Settings',
        }
      : undefined,
  };

  const device = devices?.find((d) => d.id === selectedDeviceId);
  const speakers = devices?.filter((d) => d.id !== 'browser') ?? [];
  const output: Step = {
    key: 'output',
    title: 'Output',
    state:
      devices === null
        ? 'loading'
        : selectedDeviceId && selectedDeviceId !== 'browser'
          ? device?.isOnline === false
            ? 'warn'
            : 'ok'
          : 'ok',
    detail:
      devices === null
        ? 'Looking for speakers…'
        : selectedDeviceId && selectedDeviceId !== 'browser'
          ? device
            ? device.isOnline === false
              ? `${device.name} is not reachable right now. Playback falls back to this browser until it answers.`
              : `Playing on ${device.name}; the NAS keeps it going when this screen sleeps.`
            : 'The chosen speaker is no longer listed; pick one in the player bar.'
          : speakers.length > 0
            ? `Playing in this browser. ${speakers.length} speaker(s) found: pick one in the player bar to let the NAS play there.`
            : 'Playing in this browser. No Sonos/DLNA speakers found yet; they appear automatically when discovered.',
  };

  const steps = [library, sources, output];

  return (
    <section
      className="bg-surface-light rounded-lg border border-white/10 p-4"
      aria-labelledby="getting-started-title"
      data-testid="getting-started"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 id="getting-started-title" className="text-lg font-semibold">
            Getting started
          </h3>
          <p className="text-xs text-gray-500">
            Where this installation stands, and the next step.
          </p>
        </div>
        {!libraryEmpty && (
          <button
            type="button"
            onClick={() => {
              try {
                localStorage.setItem(STORAGE_KEYS.onboardingDismissed, '1');
              } catch {
                // private mode: hide for this visit only
              }
              setDismissed(true);
            }}
            className="min-h-[44px] min-w-[44px] px-3 text-sm text-gray-400 hover:text-white rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-label="Hide getting started"
          >
            Hide
          </button>
        )}
      </div>
      <ol className="space-y-3">
        {steps.map((step, i) => (
          <li key={step.key} className="flex gap-3" data-testid={`step-${step.key}`}>
            <span className="w-6 text-right text-sm text-gray-500 tabular-nums shrink-0">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{step.title}</span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded uppercase ${STATE_STYLE[step.state]}`}
                >
                  {STATE_LABEL[step.state]}
                </span>
              </div>
              <p className="text-xs text-gray-400 mt-0.5">{step.detail}</p>
              {step.action && (
                <Link
                  to={step.action.to}
                  className="inline-flex items-center min-h-[44px] text-xs text-accent hover:underline"
                >
                  {step.action.label} →
                </Link>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
