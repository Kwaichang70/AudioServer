import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  devices: [
    { id: 'browser', name: 'Browser', type: 'browser', isOnline: true },
    { id: 'speaker-kitchen', name: 'Play:1', type: 'sonos', isOnline: true },
  ],
  zones: [
    {
      id: 'zone-browser',
      name: 'Browser',
      deviceId: 'browser',
      isDefault: true,
      state: 'stopped' as const,
      track: null,
      queueLength: 0,
      queueIndex: -1,
      volume: 50,
    },
    {
      id: 'zone-speaker-kitchen',
      name: 'Kitchen',
      deviceId: 'speaker-kitchen',
      isDefault: false,
      state: 'playing' as const,
      track: { id: 't1', title: 'Minneapolis' },
      queueLength: 11,
      queueIndex: 6,
      volume: 30,
    },
  ],
}));

vi.mock('../../api/client.js', () => ({
  api: {
    getDevices: () => Promise.resolve({ data: mocks.devices }),
    discoverDevices: () => Promise.resolve({ data: mocks.devices }),
    spotifyConnectDevices: () => Promise.resolve({ data: [] }),
  },
}));

vi.mock('../../context/AudioContext.js', () => ({
  useAudioContext: () => ({ zones: mocks.zones }),
}));

const { default: DeviceSelector } = await import('../DeviceSelector.js');

/**
 * V10.3: picking an output is picking a room. The button carries the room's
 * name and the list says what each room is doing, so "play in the kitchen"
 * is a visible choice rather than a guess about device names.
 */
describe('DeviceSelector as a zone picker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('names the room instead of the device and shows what it plays', async () => {
    render(<DeviceSelector selectedDeviceId="speaker-kitchen" onSelect={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Kitchen')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('Select output device'));

    await waitFor(() =>
      expect(screen.getByText(/Kitchen · playing 7\/11 · Minneapolis/)).toBeInTheDocument(),
    );
    expect(screen.getByText('Browser · empty queue')).toBeInTheDocument();
  });

  it('hands the chosen room back by its device', async () => {
    const onSelect = vi.fn();
    render(<DeviceSelector selectedDeviceId="browser" onSelect={onSelect} />);

    fireEvent.click(screen.getByTitle('Select output device'));
    // The list shows the room, not the device model.
    await waitFor(() => expect(screen.getByText('Kitchen')).toBeInTheDocument());
    expect(screen.queryByText('Play:1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Kitchen'));

    expect(onSelect).toHaveBeenCalledWith('speaker-kitchen');
  });
});
