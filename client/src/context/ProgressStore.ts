import { useSyncExternalStore } from 'react';

/**
 * External store for the audio player's current playback position.
 *
 * Why this isn't in AudioContext state: `timeupdate` fires ~4× per second.
 * If currentTime/duration lived in React state, every consumer of useAudioContext()
 * would re-render at that rate — including album lists, cover-art components,
 * and queue displays that don't care about progress. With useSyncExternalStore,
 * only components that explicitly subscribe via useProgress() re-render.
 */
export interface ProgressSnapshot {
  currentTime: number;
  duration: number;
}

let snapshot: ProgressSnapshot = { currentTime: 0, duration: 0 };
const listeners = new Set<() => void>();

export function getProgressSnapshot(): ProgressSnapshot {
  return snapshot;
}

export function setProgress(currentTime: number, duration: number): void {
  // Only allocate a new snapshot when the values change. useSyncExternalStore
  // requires reference equality between identical snapshots; bailing here also
  // avoids waking subscribers up for sub-pixel float updates.
  if (snapshot.currentTime === currentTime && snapshot.duration === duration) return;
  snapshot = { currentTime, duration };
  for (const l of listeners) l();
}

export function resetProgress(): void {
  setProgress(0, 0);
}

function subscribeProgress(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useProgress(): ProgressSnapshot {
  return useSyncExternalStore(subscribeProgress, getProgressSnapshot, getProgressSnapshot);
}
