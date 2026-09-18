/**
 * Which queue position plays after `index`, by the same rule the server uses
 * (`PlaybackService.peekNext` in `server/src/services/playback.ts`).
 *
 * Shuffle deliberately has no answer: a random next track cannot be prepared
 * in advance without deciding it early, and the server refuses to hand a next
 * url to a speaker while shuffling for exactly that reason. Returning null
 * here keeps the browser on the same rule, so what a tab prepares and what the
 * server would play can never disagree.
 */
export function peekNextIndex(
  queueLength: number,
  index: number,
  shuffle: boolean,
  repeat: 'off' | 'all' | 'one',
): number | null {
  if (queueLength === 0 || shuffle) return null;
  if (index < 0 || index >= queueLength) return null;
  if (repeat === 'one') return index;
  const next = index + 1;
  if (next >= queueLength) return repeat === 'all' ? 0 : null;
  return next;
}
