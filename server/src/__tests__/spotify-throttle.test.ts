import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureSpotifyThrottle, throttleSpotify } from '../services/coverart-fetch.js';

/**
 * "Fetch covers" and "Fetch images" ask Spotify for every album and artist
 * without a picture (Danny, 16 Oct 2026: a burst of rate-limit errors). Their
 * calls go one by one with room between them, even when both jobs run, and a
 * rate-limit pause is waited out instead of being hammered.
 */

describe('Spotify calls from the cover jobs', () => {
  let clock: number;
  let slept: number[];

  beforeEach(() => {
    clock = 100_000;
    slept = [];
    configureSpotifyThrottle({
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      cooldownMs: () => 0,
    });
  });

  afterEach(() => configureSpotifyThrottle(null));

  it('spaces the calls of two jobs running at once', async () => {
    const calledAt: number[] = [];
    const job = async () => {
      for (let i = 0; i < 3; i++) {
        await throttleSpotify();
        calledAt.push(clock);
      }
    };
    await Promise.all([job(), job()]);
    expect(calledAt).toHaveLength(6);
    const gaps = calledAt.slice(1).map((t, i) => t - calledAt[i]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(1500);
  });

  it('waits out a rate-limit pause, then slows down for the rest of the run', async () => {
    let cooldown = 8000;
    const cooldownMs = () => cooldown;
    await throttleSpotify(cooldownMs); // first call: Spotify says wait 8 s
    expect(slept).toContain(8000);
    cooldown = 0;
    const before = clock;
    await throttleSpotify(cooldownMs);
    // The spacing doubled from 1.5 s to 3 s.
    expect(clock - before).toBe(3000);
  });

  it('never stretches the spacing beyond 10 s', async () => {
    let calls = 0;
    const alwaysPaused = () => (calls++ < 6 ? 1000 : 0);
    for (let i = 0; i < 6; i++) await throttleSpotify(alwaysPaused);
    const before = clock;
    await throttleSpotify(alwaysPaused);
    expect(clock - before).toBe(10_000);
  });
});
