import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  devices: [
    { id: 'browser', name: 'Browser', type: 'browser', isOnline: true },
    { id: 'speaker-kitchen', name: 'Play:1', type: 'sonos', isOnline: true },
    { id: 'speaker-living', name: 'Cocktail X35', type: 'dlna', isOnline: true },
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
      id: 'zone-kitchen',
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
  api: {
    getDevices: vi.fn(),
    createZone: vi.fn(),
    renameZone: vi.fn(),
    deleteZone: vi.fn(),
  },
  refreshZones: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../context/AudioContext.js', () => ({
  useAudioContext: () => ({ zones: mocks.zones, refreshZones: mocks.refreshZones }),
}));
vi.mock('../Toast.js', () => ({ useToast: () => ({ toast: mocks.toast }) }));

const { default: ZonesSection } = await import('../ZonesSection.js');

/**
 * R00.4: V10 gave the server zone endpoints and the player a room picker, but
 * nothing could create a room — that needed `curl`. These cover the rules the
 * server enforces: one room per output, and the default room stays.
 */
describe('ZonesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.getDevices.mockResolvedValue({ data: mocks.devices });
    mocks.api.createZone.mockResolvedValue({ data: {} });
    mocks.api.renameZone.mockResolvedValue({ data: {} });
    mocks.api.deleteZone.mockResolvedValue({ data: { ok: true } });
  });

  it('lists each room with its output and what it plays', async () => {
    render(<ZonesSection />);

    expect(await screen.findByText('Kitchen')).toBeInTheDocument();
    expect(screen.getByText(/Play:1 · playing · Minneapolis/)).toBeInTheDocument();
    expect(screen.getByText(/Browser · stopped/)).toBeInTheDocument();
    expect(screen.getByText('default')).toBeInTheDocument();
  });

  it('offers only outputs that no room has claimed', async () => {
    render(<ZonesSection />);
    fireEvent.click(await screen.findByText('+ Add Room'));

    const select = screen.getByLabelText('Output device') as HTMLSelectElement;
    const options = [...select.options].map((o) => o.textContent);
    expect(options).toContain('Cocktail X35');
    expect(options).not.toContain('Play:1');
    expect(options).not.toContain('Browser');
  });

  it('creates a room from a name and an output', async () => {
    render(<ZonesSection />);
    fireEvent.click(await screen.findByText('+ Add Room'));

    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Living room' } });
    fireEvent.change(screen.getByLabelText('Output device'), {
      target: { value: 'speaker-living' },
    });
    fireEvent.click(screen.getByText('Create'));

    await waitFor(() =>
      expect(mocks.api.createZone).toHaveBeenCalledWith('Living room', 'speaker-living'),
    );
    expect(mocks.refreshZones).toHaveBeenCalled();
  });

  it('asks for both a name and an output before calling the server', async () => {
    render(<ZonesSection />);
    fireEvent.click(await screen.findByText('+ Add Room'));
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Study' } });
    fireEvent.click(screen.getByText('Create'));

    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(expect.stringMatching(/output device/), 'error'),
    );
    expect(mocks.api.createZone).not.toHaveBeenCalled();
  });

  it('shows the server message when the output is already taken (409)', async () => {
    mocks.api.createZone.mockRejectedValue(
      new Error('speaker-living already plays in "Living room"'),
    );
    render(<ZonesSection />);
    fireEvent.click(await screen.findByText('+ Add Room'));
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Study' } });
    fireEvent.change(screen.getByLabelText('Output device'), {
      target: { value: 'speaker-living' },
    });
    fireEvent.click(screen.getByText('Create'));

    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        'speaker-living already plays in "Living room"',
        'error',
      ),
    );
    // The room list is refreshed, so a room made elsewhere becomes visible.
    expect(mocks.refreshZones).toHaveBeenCalled();
  });

  it('renames a room', async () => {
    render(<ZonesSection />);
    fireEvent.click((await screen.findAllByText('Rename'))[1]);

    fireEvent.change(screen.getByLabelText('New name for Kitchen'), {
      target: { value: 'Keuken' },
    });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() =>
      expect(mocks.api.renameZone).toHaveBeenCalledWith('zone-kitchen', 'Keuken'),
    );
  });

  it('removes a room after a confirmation, and never the default one', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ZonesSection />);

    // Only the non-default room offers Remove.
    const removes = await screen.findAllByText('Remove');
    expect(removes).toHaveLength(1);

    fireEvent.click(removes[0]);
    await waitFor(() => expect(mocks.api.deleteZone).toHaveBeenCalledWith('zone-kitchen'));
    confirm.mockRestore();
  });

  it('keeps the room when the confirmation is declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<ZonesSection />);

    fireEvent.click((await screen.findAllByText('Remove'))[0]);
    expect(mocks.api.deleteZone).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});
