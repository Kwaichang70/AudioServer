import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import type { AudioPath } from '../../api/types.js';

/**
 * The audio path in the player (R01.3), the way Roon puts its signal-path
 * light next to the track instead of in the settings.
 *
 * The light follows the LEAST certain step, because that is how much the
 * listener can actually rely on: a FLAC source is known, but what a speaker
 * does inside is not visible from here, so a speaker path is never shown as
 * fully established. The full step list stays in Settings (V11.4); this badge
 * links there.
 */

const RANK = { known: 2, reported: 1, unknown: 0 } as const;

const LOOK = {
  known: { dot: 'bg-accent', text: 'Path established' },
  reported: { dot: 'bg-yellow-400', text: 'Partly reported by the device' },
  unknown: { dot: 'bg-gray-500', text: 'Part of the path is not visible' },
} as const;

export function weakestCertainty(path: AudioPath): keyof typeof LOOK {
  if (path.steps.length === 0) return 'unknown';
  return path.steps.reduce<keyof typeof LOOK>(
    (weakest, step) => (RANK[step.certainty] < RANK[weakest] ? step.certainty : weakest),
    'known',
  );
}

interface Props {
  /** Refetch when either changes: another track or another output. */
  trackId: string;
  deviceId: string;
  onDetails: () => void;
}

export default function AudioPathBadge({ trackId, deviceId, onDetails }: Props) {
  const [path, setPath] = useState<AudioPath | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getAudioPath()
      .then((res) => {
        if (!cancelled) setPath(res.data ?? null);
      })
      .catch(() => {
        if (!cancelled) setPath(null);
      });
    return () => {
      cancelled = true;
    };
  }, [trackId, deviceId]);

  if (!path) return null;
  const look = LOOK[weakestCertainty(path)];

  return (
    <button
      type="button"
      onClick={onDetails}
      className="inline-flex max-w-full items-center gap-2 rounded-full border border-white/10 px-3 py-1 text-xs text-gray-400 transition hover:border-accent hover:text-white"
      title={path.summary}
      aria-label={`Audio path: ${look.text}. ${path.summary}. Open details.`}
    >
      <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${look.dot}`} />
      <span className="truncate">{look.text}</span>
    </button>
  );
}
