import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDatabase, initDatabase } from '../db/index.js';
import {
  configureOutputCapabilities,
  forgetCapabilities,
  getOutputCapabilities,
  probeDevice,
  GAPLESS_THRESHOLD_MS,
  MEASUREMENTS_FOR_VERDICT,
} from '../services/output-capabilities.js';
import { parseSinkProtocolInfo } from '../devices/dlna.js';

/**
 * V11.1: what an output can do is asked of the device, and what it does not
 * answer stays unknown. "Gapless" is never a specification claim — it takes
 * measured boundaries (V11.4), and the worst one decides.
 */
describe('output capabilities', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'audioserver-caps-'));
    await initDatabase(join(tmp, 'test.db'));
    forgetCapabilities();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const speaker = { id: 'speaker', name: 'Play:1', type: 'sonos' as const };

  it('reads the action list and the formats the device publishes', async () => {
    configureOutputCapabilities({
      listDevices: async () => [speaker],
      controllerFor: () => ({
        getSupportedActions: async () => ['Play', 'Pause', 'Seek', 'SetNextAVTransportURI'],
        getSupportedFormats: async () => ['audio/flac', 'audio/mpeg'],
      }),
      measuredGapFor: () => undefined,
      measurementsFor: () => 0,
    });

    const caps = await probeDevice(speaker);

    expect(caps).toMatchObject({
      nextUri: 'supported',
      seek: 'supported',
      formats: ['audio/flac', 'audio/mpeg'],
      replayGain: 'none',
    });
    // Supporting the handover is not the same as being gapless.
    expect(caps.gapless).toBe('unknown');
  });

  it('says unknown — never unsupported — when the device stays silent', async () => {
    configureOutputCapabilities({
      listDevices: async () => [speaker],
      controllerFor: () => ({
        getSupportedActions: async () => {
          throw new Error('no answer');
        },
        getSupportedFormats: async () => {
          throw new Error('no answer');
        },
      }),
      measuredGapFor: () => undefined,
      measurementsFor: () => 0,
    });

    const caps = await probeDevice({ id: 'mystery', name: 'Old renderer', type: 'dlna' });

    expect(caps.nextUri).toBe('unknown');
    expect(caps.seek).toBe('unknown');
    expect(caps.formats).toEqual([]);
    expect(caps.limits).toContain('This output did not say which formats it accepts.');
  });

  it('calls a device that lacks the action not gapless, and says why', async () => {
    configureOutputCapabilities({
      listDevices: async () => [speaker],
      controllerFor: () => ({
        getSupportedActions: async () => ['Play', 'Pause', 'Stop'],
        getSupportedFormats: async () => ['audio/mpeg'],
      }),
      measuredGapFor: () => undefined,
      measurementsFor: () => 0,
    });

    const caps = await probeDevice(speaker);

    expect(caps.nextUri).toBe('unsupported');
    expect(caps.gapless).toBe('unsupported');
    expect(caps.limits.some((l) => l.includes('cannot take the next track in advance'))).toBe(true);
  });

  it('only says "verified" after enough measured boundaries, and the worst one decides', async () => {
    const base = {
      listDevices: async () => [speaker],
      controllerFor: () => ({
        getSupportedActions: async () => ['SetNextAVTransportURI', 'Seek'],
        getSupportedFormats: async () => ['audio/flac'],
      }),
    };

    configureOutputCapabilities({ ...base, measuredGapFor: () => 20, measurementsFor: () => 1 });
    const tooFew = await probeDevice(speaker);
    expect(tooFew.gapless).toBe('unknown');
    expect(tooFew.limits.some((l) => l.includes(`fewer than ${MEASUREMENTS_FOR_VERDICT}`))).toBe(
      true,
    );

    configureOutputCapabilities({ ...base, measuredGapFor: () => 20, measurementsFor: () => 5 });
    expect((await probeDevice(speaker)).gapless).toBe('verified');

    // One audible boundary in the set is enough to lose the claim.
    configureOutputCapabilities({
      ...base,
      measuredGapFor: () => GAPLESS_THRESHOLD_MS + 300,
      measurementsFor: () => 20,
    });
    const audible = await probeDevice(speaker);
    expect(audible.gapless).toBe('unknown');
    expect(audible.limits.some((l) => l.includes('audible, so not gapless'))).toBe(true);
  });

  it('knows the browser without asking anything', async () => {
    configureOutputCapabilities({
      listDevices: async () => [{ id: 'browser', name: 'Browser', type: 'browser' }],
      measuredGapFor: () => undefined,
      measurementsFor: () => 0,
    });

    const caps = await getOutputCapabilities('browser');

    expect(caps).toMatchObject({ replayGain: 'browser', seek: 'supported', gapless: 'unknown' });
    expect(caps?.probedAt).toBeUndefined();
  });
});

describe('GetProtocolInfo parsing', () => {
  it('keeps the audio mime types from the Sink list and drops the rest', () => {
    const xml = `<Sink>http-get:*:audio/flac:DLNA.ORG_PN=FLAC,http-get:*:audio/mpeg:*,http-get:*:image/jpeg:*,http-get:*:video/mp4:*</Sink>`;
    expect(parseSinkProtocolInfo(xml)).toEqual(['audio/flac', 'audio/mpeg']);
  });

  it('answers with nothing when the device sends no Sink list', () => {
    expect(parseSinkProtocolInfo('<Source>http-get:*:audio/flac:*</Source>')).toEqual([]);
  });
});
