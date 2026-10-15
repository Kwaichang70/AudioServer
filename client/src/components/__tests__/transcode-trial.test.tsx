import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The conversion trial in Settings → Rooms (R10.1, for the R10.3 decision). */

const mocks = vi.hoisted(() => ({
  audio: { currentTrack: { id: 'trk-1', title: 'Long FLAC' } as { id: string } | null },
  api: {
    getTranscodes: vi.fn(),
    getStreamUrl: vi.fn((id: string) => `/api/library/tracks/${id}/stream?t=tok`),
  },
  ensureStreamToken: vi.fn(() => Promise.resolve('tok')),
}));
vi.mock('../../context/AudioContext.js', () => ({ useAudioContext: () => mocks.audio }));
vi.mock('../../api/client.js', () => ({
  api: mocks.api,
  ensureStreamToken: mocks.ensureStreamToken,
}));

const { default: TranscodeTrial } = await import('../TranscodeTrial.js');

const run = {
  id: 1,
  zoneId: 'meting-a-1',
  trackId: 'trk-1',
  target: 'mp3',
  startedAt: 1,
  endedAt: 2,
  cpuMs: 2600,
  peakRssKb: 56_320,
  audioSeconds: 240,
  cpuMsPerAudioMinute: 650,
  outcome: 'finished',
};

describe('Conversion trial', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.audio.currentTrack = { id: 'trk-1' };
    mocks.api.getTranscodes.mockResolvedValue({ data: { active: [], recent: [run] } });
    fetchMock.mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('shows what each conversion cost, per minute of music and of one core', async () => {
    render(<TranscodeTrial />);
    expect(await screen.findByText('650 ms')).toBeInTheDocument();
    expect(screen.getByText('1.1%')).toBeInTheDocument();
    expect(screen.getByText('55 MB')).toBeInTheDocument();
  });

  it('converts the playing track twice at once, each in its own room', async () => {
    render(<TranscodeTrial />);
    fireEvent.click(screen.getByRole('button', { name: 'Measure two at once' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toMatch(/\/trk-1\/stream\?t=tok&format=mp3&zone=meting-.+-1$/);
    expect(urls[1]).toMatch(/zone=meting-.+-2$/);
  });

  it('asks for a library track: a stream from elsewhere is not converted', () => {
    mocks.audio.currentTrack = { id: 'qobuz:42' };
    render(<TranscodeTrial />);
    expect(screen.getByRole('button', { name: 'Measure one' })).toBeDisabled();
    expect(screen.getByText('Play a track from the library first.')).toBeInTheDocument();
  });
});
