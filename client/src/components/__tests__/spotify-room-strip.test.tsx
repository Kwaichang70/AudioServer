import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Spotify started in a room by Homey, Grok or "Play in" leaves AudioServer's
 * own queue there stopped; the strip says what Spotify plays and steers it.
 */

const mocks = vi.hoisted(() => ({
  api: { roomCommand: vi.fn() },
  audio: {
    zoneId: 'z-wk' as string | null,
    refreshZones: vi.fn(),
    zones: [] as unknown[],
  },
  toast: vi.fn(),
}));

vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../context/AudioContext.js', () => ({ useAudioContext: () => mocks.audio }));
vi.mock('../Toast.js', () => ({ useToast: () => ({ toast: mocks.toast }) }));

const { default: SpotifyRoomStrip } = await import('../player/SpotifyRoomStrip.js');

const room = (spotify: unknown) => ({
  id: 'z-wk',
  name: 'Woonkamer',
  deviceId: 'sonos:wk',
  state: 'stopped',
  spotify,
});

describe('SpotifyRoomStrip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.roomCommand.mockResolvedValue({ data: {} });
    mocks.audio.zoneId = 'z-wk';
  });

  it('shows nothing when the room does not play Spotify', () => {
    mocks.audio.zones = [room(null)];
    const { container } = render(<SpotifyRoomStrip />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the Spotify track in this room and pauses it there', async () => {
    mocks.audio.zones = [
      room({
        state: 'playing',
        track: { title: 'Blue in Green', artistName: 'Miles Davis', albumTitle: 'Kind of Blue' },
        speaker: 'Woonkamer',
        playing: 'Zondag Jazz',
      }),
    ];
    render(<SpotifyRoomStrip />);
    const strip = screen.getByRole('region', { name: 'Spotify in Woonkamer' });
    expect(strip).toHaveTextContent('Blue in Green');
    expect(strip).toHaveTextContent('Miles Davis');
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(mocks.api.roomCommand).toHaveBeenCalledWith('z-wk', 'pause'));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(mocks.api.roomCommand).toHaveBeenCalledWith('z-wk', 'next'));
  });

  it('offers play when paused, and names what was started before the track is known', () => {
    mocks.audio.zones = [
      room({ state: 'paused', track: null, speaker: 'Woonkamer', playing: 'Zondag Jazz' }),
    ];
    render(<SpotifyRoomStrip />);
    expect(screen.getByRole('region')).toHaveTextContent('Zondag Jazz');
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
  });
});
