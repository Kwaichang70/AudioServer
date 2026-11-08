import { afterEach, describe, expect, it, vi } from 'vitest';
import { radioCacheSize, radioProvider } from '../providers/radio.js';

/**
 * B10: every Featured station resolves from its own public id, without a
 * directory lookup — Radio 538 and Veronica had an id ("radio:538") that was
 * not their uuid ("radio-538"), so the player asked radio-browser for "538".
 * §6: the search cache stays bounded.
 */
describe('radio stations', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resolves every Featured station from the part after "radio:" in its id', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (const station of radioProvider.getFeaturedStations()) {
      const resolved = await radioProvider.getStation(station.id.replace(/^radio:/, ''));
      expect(resolved?.id).toBe(station.id);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still resolves the uuid form', async () => {
    expect((await radioProvider.getStation('radio-538'))?.name).toBe('Radio 538');
  });

  it('keeps the search cache bounded', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('[]', { status: 200 }),
    );
    for (let i = 0; i < 260; i++) await radioProvider.searchStations(`q${i}`);
    expect(radioCacheSize()).toBeLessThanOrEqual(200);
  });
});
