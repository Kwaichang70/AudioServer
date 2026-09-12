import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  path: {
    zoneId: 'zone-browser',
    deviceId: 'speaker',
    trackId: 'track-1',
    summary:
      'The speaker plays the original file; what happens inside it is not visible from here.',
    steps: [
      {
        stage: 'source' as const,
        title: 'Local file',
        detail: 'FLAC · 44.1 kHz · 16 bit, read straight from the library.',
        certainty: 'known' as const,
      },
      {
        stage: 'output' as const,
        title: 'Speaker output',
        detail: 'Decoding, volume and any processing happen inside the device.',
        certainty: 'unknown' as const,
      },
    ],
    caveats: ['ReplayGain is not applied on this path; the file plays at its own level.'],
  },
  outputs: [
    {
      deviceId: 'speaker',
      deviceName: 'Play:1',
      type: 'sonos' as const,
      formats: ['audio/flac'],
      seek: 'supported' as const,
      nextUri: 'supported' as const,
      replayGain: 'none' as const,
      gapless: 'unknown' as const,
      limits: ['ReplayGain is not applied on this path; the file plays at its own level.'],
    },
  ],
  transitions: [
    {
      id: 2,
      zoneId: 'zone-browser',
      deviceId: 'speaker',
      fromTrackId: 'a',
      toTrackId: 'b',
      handover: 'next-uri' as const,
      armedAt: 1,
      observedGapMs: 2000,
      measuredGapMs: null,
      method: null,
      note: null,
      createdAt: 1,
    },
  ],
}));

vi.mock('../../api/client.js', () => ({
  api: {
    getAudioPath: () => Promise.resolve({ data: mocks.path }),
    getOutputCapabilities: () => Promise.resolve({ data: mocks.outputs }),
    getTransitions: () => Promise.resolve({ data: mocks.transitions }),
  },
}));

const { default: AudioPathPanel } = await import('../AudioPathPanel.js');

/**
 * V11.4: the panel exists to be honest. Every step says how sure the server
 * is of it, and a boundary that was only observed is never presented as a
 * measurement.
 */
describe('the audio path panel', () => {
  it('marks what is established and what is not visible from here', async () => {
    render(<AudioPathPanel />);

    await waitFor(() => expect(screen.getByText('Local file')).toBeInTheDocument());
    expect(screen.getByText('established')).toBeInTheDocument();
    expect(screen.getAllByText('not visible from here').length).toBeGreaterThan(0);
    expect(
      screen.getByText(/ReplayGain is not applied on this path/, { selector: 'li' }),
    ).toBeInTheDocument();
  });

  it('does not call an output gapless while nothing has been measured', async () => {
    render(<AudioPathPanel />);

    await waitFor(() => expect(screen.getByText('Play:1')).toBeInTheDocument());
    expect(screen.getByText(/gapless not established/)).toBeInTheDocument();
    // (the footer explains the term; no output may carry the claim itself)
    expect(screen.queryByText(/^gapless verified/)).not.toBeInTheDocument();
    // The observed number is shown, but labelled as not measured.
    expect(screen.getByText('2000 ms')).toBeInTheDocument();
    expect(screen.getByText('not measured')).toBeInTheDocument();
  });
});
