/**
 * Can this library row play now? A local file the scanner cannot find is
 * 'missing'; a Qobuz title Qobuz withdrew is 'unavailable' (R07.2). Both are
 * listed, dimmed, and never sent to a player.
 */
export function isUnplayable(item: { availability?: string | null }): boolean {
  return item.availability === 'missing' || item.availability === 'unavailable';
}

/** The word on the badge of an unplayable row. */
export function unplayableLabel(item: { availability?: string | null }): string {
  return item.availability === 'unavailable' ? 'not on Qobuz' : 'missing';
}
