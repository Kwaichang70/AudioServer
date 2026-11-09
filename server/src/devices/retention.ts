/**
 * How many discovery rounds in a row a device may miss before the server
 * forgets it (P01).
 *
 * SSDP and mDNS answers are UDP and get lost; a busy speaker may simply not
 * answer within the search window. Forgetting a speaker the first time it
 * misses a round made every command for it fail and made the status poll
 * report a speaker that plays on as "stopped" — midway through a track that
 * closed the listening session, near its end it advanced the queue and
 * skipped a track. A missed round now only marks it offline; it keeps its
 * address, so commands still reach it if it is really there.
 */
export const MISSED_ROUNDS_BEFORE_DROP = 3;

/**
 * Merge one discovery round into what a controller already knows. Found
 * devices are online and reset their count; known devices that did not
 * answer stay, offline, until they missed `maxMissed` rounds in a row.
 */
export class DiscoveryRoster<T extends { id: string; isOnline: boolean }> {
  private missed = new Map<string, number>();

  constructor(private readonly maxMissed = MISSED_ROUNDS_BEFORE_DROP) {}

  merge(previous: ReadonlyMap<string, T>, found: ReadonlyMap<string, T>): Map<string, T> {
    const next = new Map<string, T>();
    for (const [id, device] of found) {
      this.missed.delete(id);
      next.set(id, { ...device, isOnline: true });
    }
    for (const [id, device] of previous) {
      if (next.has(id)) continue;
      const missed = (this.missed.get(id) ?? 0) + 1;
      if (missed >= this.maxMissed) {
        this.missed.delete(id);
        continue;
      }
      this.missed.set(id, missed);
      next.set(id, { ...device, isOnline: false });
    }
    return next;
  }
}
