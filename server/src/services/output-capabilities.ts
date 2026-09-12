import { deviceManager } from '../devices/manager.js';
import { measuredCount, worstMeasuredGap } from './transitions.js';
import { logger } from '../logger.js';
import type { DeviceType } from '@audioserver/shared';

/**
 * What an output can actually do (V11.1).
 *
 * The rule of this module is honesty. A renderer is asked what it supports —
 * DLNA and Sonos both publish their action list and the formats they accept —
 * and whatever it does not say stays `unknown`. Nothing is inferred from a
 * device name or a brand, and "gapless" is never claimed on the strength of a
 * specification: it says `verified` only once a transition has actually been
 * measured on that output (V11.4), because the only proof of gapless audio is
 * a recorded boundary without an added pause or missing music.
 */

export type Support = 'supported' | 'unsupported' | 'unknown';
export type GaplessClaim = 'verified' | 'unsupported' | 'unknown';

export interface OutputCapabilities {
  deviceId: string;
  deviceName: string;
  type: DeviceType;
  /** Mime types the output accepts. Empty means: it did not say. */
  formats: string[];
  seek: Support;
  /** Can the next track be handed over before this one ends? */
  nextUri: Support;
  /** Who applies ReplayGain on this path. */
  replayGain: 'browser' | 'none' | 'unknown';
  /**
   * Gapless. `verified` only after a measured transition on this output;
   * `unsupported` when the output cannot even take the next track in advance.
   */
  gapless: GaplessClaim;
  /** The measured gap between two tracks, when a measurement exists (V11.4). */
  measuredGapMs?: number;
  /** Plain sentences about what this output cannot do, for the UI. */
  limits: string[];
  /** When the device was last asked; absent when the answer is a default. */
  probedAt?: number;
}

interface Probe {
  getSupportedActions?(deviceId: string): Promise<string[]>;
  getSupportedFormats?(deviceId: string): Promise<string[]>;
}

export interface CapabilityDeps {
  listDevices: () => Promise<Array<{ id: string; name: string; type: DeviceType }>>;
  controllerFor: (type: DeviceType) => Probe | null;
  /** Measured transitions per device (V11.4); the only source of "verified". */
  measuredGapFor: (deviceId: string) => number | undefined;
  /** How many measured boundaries that output has; one is not a track record. */
  measurementsFor: (deviceId: string) => number;
  probeTimeoutMs: number;
  cacheTtlMs: number;
}

let deps: CapabilityDeps = {
  listDevices: async () =>
    (await deviceManager.getDevices()).map((d) => ({ id: d.id, name: d.name, type: d.type })),
  controllerFor: (type) => (deviceManager.controllerFor(type) ?? null) as Probe | null,
  measuredGapFor: (deviceId) => worstMeasuredGap(deviceId),
  measurementsFor: (deviceId) => measuredCount(deviceId),
  probeTimeoutMs: 6000,
  cacheTtlMs: 10 * 60_000,
};

export function configureOutputCapabilities(overrides: Partial<CapabilityDeps>): void {
  deps = { ...deps, ...overrides };
}

const cache = new Map<string, { value: OutputCapabilities; at: number }>();

export function forgetCapabilities(deviceId?: string): void {
  if (deviceId) cache.delete(deviceId);
  else cache.clear();
}

/** The browser plays through our own audio element, so we know this one exactly. */
function browserCapabilities(deviceId: string, name: string): OutputCapabilities {
  return {
    deviceId,
    deviceName: name,
    type: 'browser',
    formats: ['audio/flac', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav'],
    seek: 'supported',
    nextUri: 'supported',
    replayGain: 'browser',
    // The next track is preloaded and swapped in, but two <audio> elements
    // cannot guarantee a sample-exact boundary; only a measurement decides.
    gapless: 'unknown',
    limits: [
      'The browser decides which formats it really plays; a codec it lacks fails at playback, not here.',
      'A phone that sleeps can suspend the audio element; playback on the NAS keeps going, this does not.',
    ],
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Ask one output what it can do. A device that does not answer is reported as
 * `unknown`, never as unsupported: silence is not a "no".
 */
export async function probeDevice(device: {
  id: string;
  name: string;
  type: DeviceType;
}): Promise<OutputCapabilities> {
  if (device.type === 'browser') return browserCapabilities(device.id, device.name);

  const caps: OutputCapabilities = {
    deviceId: device.id,
    deviceName: device.name,
    type: device.type,
    formats: [],
    // Every renderer we drive answers Seek; it is in the base AVTransport set.
    seek: device.type === 'volumio' ? 'supported' : 'unknown',
    nextUri: 'unknown',
    replayGain: 'none',
    gapless: 'unknown',
    limits: [],
    probedAt: Date.now(),
  };

  const controller = deps.controllerFor(device.type);

  if (controller?.getSupportedActions) {
    try {
      const actions = await withTimeout(
        controller.getSupportedActions(device.id),
        deps.probeTimeoutMs,
        `action list of ${device.name}`,
      );
      if (actions.length > 0) {
        caps.nextUri = actions.includes('SetNextAVTransportURI') ? 'supported' : 'unsupported';
        caps.seek = actions.includes('Seek') ? 'supported' : 'unsupported';
      }
    } catch (err) {
      logger.debug(`Capabilities: ${device.name} did not list its actions: ${err}`);
    }
  } else if (controller && device.type === 'sonos') {
    // Sonos does not publish an SCPD we fetch, but it does implement the
    // action; the handover itself reports failure if that ever changes.
    caps.nextUri = 'supported';
    caps.seek = 'supported';
  }

  if (controller?.getSupportedFormats) {
    try {
      caps.formats = await withTimeout(
        controller.getSupportedFormats(device.id),
        deps.probeTimeoutMs,
        `formats of ${device.name}`,
      );
    } catch (err) {
      logger.debug(`Capabilities: ${device.name} did not list its formats: ${err}`);
    }
  }

  if (caps.nextUri === 'unsupported') {
    caps.gapless = 'unsupported';
    caps.limits.push(
      'This output cannot take the next track in advance, so there is a short pause between tracks.',
    );
  }
  if (caps.formats.length === 0) {
    caps.limits.push('This output did not say which formats it accepts.');
  }
  caps.limits.push('ReplayGain is not applied on this path; the file plays at its own level.');

  applyMeasurements(caps);
  return caps;
}

/**
 * Turn measurements into a claim. Deliberately strict: the WORST measured
 * boundary decides (one audible pause in twenty means the output is not
 * gapless), and a single measurement is not a track record — it takes at
 * least `MEASUREMENTS_FOR_VERDICT` before the word "verified" is used.
 */
function applyMeasurements(caps: OutputCapabilities): void {
  const measured = deps.measuredGapFor(caps.deviceId);
  if (measured === undefined) return;
  caps.measuredGapMs = measured;
  const enough = deps.measurementsFor(caps.deviceId) >= MEASUREMENTS_FOR_VERDICT;

  if (measured <= GAPLESS_THRESHOLD_MS && caps.nextUri === 'supported' && enough) {
    caps.gapless = 'verified';
    return;
  }
  if (measured <= GAPLESS_THRESHOLD_MS && !enough) {
    caps.limits.push(
      `Measured gap so far: ${Math.round(measured)} ms, but fewer than ${MEASUREMENTS_FOR_VERDICT} boundaries measured — not called gapless yet.`,
    );
    return;
  }
  if (caps.gapless !== 'unsupported') {
    caps.limits.push(
      `Worst measured gap between tracks: ${Math.round(measured)} ms — audible, so not gapless.`,
    );
  }
}

/** A measured boundary at or below this counts as gapless (V11.4). */
export const GAPLESS_THRESHOLD_MS = 120;
/** How many measured boundaries an output needs before "verified" is used. */
export const MEASUREMENTS_FOR_VERDICT = 3;

/** Capabilities of one output, cached; `refresh` asks the device again. */
export async function getOutputCapabilities(
  deviceId: string,
  options: { refresh?: boolean } = {},
): Promise<OutputCapabilities | null> {
  const cached = cache.get(deviceId);
  if (!options.refresh && cached && Date.now() - cached.at < deps.cacheTtlMs) return cached.value;

  const devices = await deps.listDevices();
  const device = devices.find((d) => d.id === deviceId);
  if (!device) return null;

  const value = await probeDevice(device);
  cache.set(deviceId, { value, at: Date.now() });
  return value;
}

/** Capabilities of every known output; devices are probed in parallel. */
export async function getAllOutputCapabilities(
  options: { refresh?: boolean } = {},
): Promise<OutputCapabilities[]> {
  const devices = await deps.listDevices();
  return Promise.all(
    devices.map(
      async (device) =>
        (await getOutputCapabilities(device.id, options)) ?? (await probeDevice(device)),
    ),
  );
}

/**
 * May the server hand the next track to this output before the current one
 * ends? Unknown counts as "try it": the handover reports its own failure, and
 * that answer is what teaches us the device cannot do it.
 */
export async function supportsNextUri(deviceId: string): Promise<boolean> {
  const caps = await getOutputCapabilities(deviceId);
  return !!caps && caps.nextUri !== 'unsupported';
}

/** A failed handover is the device telling us it cannot; remember that. */
export function noteNextUriFailed(deviceId: string): void {
  const cached = cache.get(deviceId);
  if (!cached) return;
  cached.value.nextUri = 'unsupported';
  cached.value.gapless = 'unsupported';
  if (!cached.value.limits.some((l) => l.startsWith('This output cannot take'))) {
    cached.value.limits.push(
      'This output cannot take the next track in advance, so there is a short pause between tracks.',
    );
  }
}
