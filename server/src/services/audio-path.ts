import { getRawDb } from '../db/index.js';
import { getOutputCapabilities } from './output-capabilities.js';
import { sourceOf } from './playback-resolver.js';
import type { PlaybackService } from './playback.js';

/**
 * The audio path (V11.4): where the music comes from, what happens to it on
 * the way, and where it comes out.
 *
 * The point of this is what it refuses to claim. A FLAC file is not proof of
 * a bit-perfect output: between the file and the speaker sit a renderer, a
 * DAC and whatever the device does with volume, and none of that is visible
 * from here. Every step therefore carries its own certainty, and a step the
 * server cannot see says so instead of being left out.
 */

export type StepCertainty = 'known' | 'reported' | 'unknown';

export interface AudioPathStep {
  /** What this step is: source, transfer, renderer, output. */
  stage: 'source' | 'transfer' | 'renderer' | 'output';
  title: string;
  detail: string;
  certainty: StepCertainty;
}

export interface AudioPath {
  zoneId: string;
  deviceId: string;
  trackId: string | null;
  steps: AudioPathStep[];
  /** The honest summary a user can repeat without being wrong. */
  summary: string;
  /** What cannot be established from here. */
  caveats: string[];
}

interface TrackRow {
  format: string | null;
  sample_rate: number | null;
  bit_depth: number | null;
  file_path: string | null;
}

function localTrack(trackId: string): TrackRow | undefined {
  try {
    return getRawDb()
      .prepare('SELECT format, sample_rate, bit_depth, file_path FROM tracks WHERE id = ?')
      .get(trackId) as TrackRow | undefined;
  } catch {
    return undefined;
  }
}

function describeSource(trackId: string | null): AudioPathStep {
  if (!trackId) {
    return {
      stage: 'source',
      title: 'Nothing playing',
      detail: 'Start a track to see its path.',
      certainty: 'known',
    };
  }
  const source = sourceOf(trackId);
  if (source !== 'local') {
    return {
      stage: 'source',
      title: `${source[0].toUpperCase()}${source.slice(1)} stream`,
      detail:
        'The provider decides the format and quality of this stream; the server passes on what it is given.',
      certainty: 'reported',
    };
  }
  const row = localTrack(trackId);
  if (!row) {
    return {
      stage: 'source',
      title: 'Local file',
      detail: 'This track is no longer in the library, so its format is unknown.',
      certainty: 'unknown',
    };
  }
  const quality = [
    row.format?.toUpperCase(),
    row.sample_rate ? `${(row.sample_rate / 1000).toFixed(1)} kHz` : null,
    row.bit_depth ? `${row.bit_depth} bit` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    stage: 'source',
    title: 'Local file',
    detail: quality
      ? `${quality}, read straight from the library.`
      : 'Read straight from the library; the file did not state its format.',
    certainty: 'known',
  };
}

/** One honest description of everything between the file and the speaker. */
export async function describeAudioPath(session: PlaybackService): Promise<AudioPath> {
  const snapshot = session.getSnapshot();
  const trackId = snapshot.state.track?.id ?? null;
  const deviceId = snapshot.controller.deviceId;
  const caps = await getOutputCapabilities(deviceId).catch(() => null);

  const steps: AudioPathStep[] = [describeSource(trackId)];
  const caveats: string[] = [];

  if (deviceId === 'browser') {
    steps.push({
      stage: 'transfer',
      title: 'To this browser',
      detail: 'The file is streamed to this tab over the local network; nothing is transcoded.',
      certainty: 'known',
    });
    steps.push({
      stage: 'renderer',
      title: 'Browser audio',
      detail:
        'The browser decodes the file and applies ReplayGain and volume; both change the samples.',
      certainty: 'known',
    });
    steps.push({
      stage: 'output',
      title: 'Your computer or phone',
      detail: 'What the operating system and its DAC do after that is not visible from here.',
      certainty: 'unknown',
    });
    caveats.push(
      'Volume and ReplayGain are applied in the browser, so this path is not bit-perfect.',
    );
  } else {
    steps.push({
      stage: 'transfer',
      title: 'To the speaker',
      detail:
        'The server hands the speaker a URL on the local network and the speaker fetches the file itself; nothing is transcoded on the NAS.',
      certainty: 'known',
    });
    steps.push({
      stage: 'renderer',
      title: caps?.deviceName ?? deviceId,
      detail: caps?.formats.length
        ? `The device says it accepts: ${caps.formats.join(', ')}.`
        : 'The device did not say which formats it accepts.',
      certainty: caps?.formats.length ? 'reported' : 'unknown',
    });
    steps.push({
      stage: 'output',
      title: 'Speaker output',
      detail:
        'Decoding, volume and any processing happen inside the device; none of that is visible from here.',
      certainty: 'unknown',
    });
    caveats.push('ReplayGain is not applied on this path; the file plays at its own level.');
  }

  if (caps?.gapless === 'verified') {
    caveats.push(
      `Gapless verified on this output: worst measured boundary ${caps.measuredGapMs} ms.`,
    );
  } else if (caps?.gapless === 'unsupported') {
    caveats.push(
      'This output cannot take the next track in advance, so tracks have a short pause.',
    );
  } else {
    caveats.push('Gapless is not established for this output: no boundary has been measured yet.');
  }

  return {
    zoneId: session.getZoneId(),
    deviceId,
    trackId,
    steps,
    summary:
      steps[0].certainty === 'known' && deviceId !== 'browser'
        ? 'The speaker plays the original file; what happens inside it is not visible from here.'
        : 'The path below is what the server can establish; the rest is marked unknown.',
    caveats,
  };
}
