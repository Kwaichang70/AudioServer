import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Move the music to another room (R09.2), from the player. */

const zone = (id: string, name: string, deviceId: string, state = 'stopped') => ({
  id,
  name,
  deviceId,
  isDefault: false,
  state,
  track: null,
  queueLength: 0,
  queueIndex: -1,
  volume: 50,
});

const mocks = vi.hoisted(() => ({
  audio: {
    currentTrack: { id: 't3', title: 'Track 3' } as unknown,
    zoneId: 'z-kitchen',
    zones: [] as unknown[],
    moveToZone: vi.fn(),
  },
  toast: vi.fn(),
}));
vi.mock('../../context/AudioContext.js', () => ({ useAudioContext: () => mocks.audio }));
vi.mock('../Toast.js', () => ({ useToast: () => ({ toast: mocks.toast }) }));

const { default: MoveToMenu } = await import('../player/MoveToMenu.js');

describe('Move to another room', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.audio.currentTrack = { id: 't3', title: 'Track 3' };
    mocks.audio.zones = [
      zone('z-kitchen', 'Kitchen', 'sonos:kitchen', 'playing'),
      zone('z-living', 'Living room', 'dlna:living'),
      zone('z-office', 'Office', 'sonos:office', 'playing'),
      zone('zone-browser', 'This browser', 'browser'),
      zone('z-spotify', 'Phone', 'spotify-connect:abc'),
    ];
  });

  it('offers the other speaker rooms, not this room, a browser or Spotify Connect', () => {
    render(<MoveToMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Move to…' }));
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['Living room', 'Officeplaying now']);
  });

  it('moves the music and says where it plays now', async () => {
    mocks.audio.moveToZone.mockResolvedValue({ resumedAtPosition: true });
    render(<MoveToMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Move to…' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Living room' }));
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith('Now playing in Living room', 'success'),
    );
    expect(mocks.audio.moveToZone).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'z-living' }),
    );
  });

  it('passes on what did not go along, such as the position', async () => {
    mocks.audio.moveToZone.mockResolvedValue({
      resumedAtPosition: false,
      note: '“Living room” cannot jump inside a track; it plays from the beginning of the track.',
    });
    render(<MoveToMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Move to…' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Living room' }));
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(expect.stringMatching(/cannot jump/), 'info'),
    );
  });

  it('stays out of the way with nothing playing or nowhere to go', () => {
    mocks.audio.currentTrack = null;
    const { container, rerender } = render(<MoveToMenu />);
    expect(container).toBeEmptyDOMElement();
    mocks.audio.currentTrack = { id: 't3' };
    mocks.audio.zones = [zone('z-kitchen', 'Kitchen', 'sonos:kitchen')];
    rerender(<MoveToMenu />);
    expect(container).toBeEmptyDOMElement();
  });
});
