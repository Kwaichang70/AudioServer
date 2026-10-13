import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Sonos groups in the player (R09.1). */

const zone = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  deviceId: `RINCON_${id}`,
  isDefault: false,
  state: 'stopped',
  track: null,
  queueLength: 0,
  queueIndex: -1,
  volume: 50,
  groupable: true,
  groupedWith: null,
  groupMembers: [],
  ...extra,
});

const mocks = vi.hoisted(() => ({
  audio: {
    zoneId: 'kitchen',
    zones: [] as unknown[],
    refreshZones: vi.fn(),
    setSelectedDeviceId: vi.fn(),
  },
  api: {
    groupZone: vi.fn(() => Promise.resolve({ data: {} })),
    ungroupZone: vi.fn(() => Promise.resolve({ data: {} })),
  },
  toast: vi.fn(),
}));
vi.mock('../../context/AudioContext.js', () => ({ useAudioContext: () => mocks.audio }));
vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../Toast.js', () => ({ useToast: () => ({ toast: mocks.toast }) }));

const { default: GroupMenu } = await import('../player/GroupMenu.js');

describe('Sonos groups in the player', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.audio.zoneId = 'kitchen';
    mocks.audio.zones = [
      zone('kitchen', 'Kitchen', { groupMembers: ['bedroom'] }),
      zone('bedroom', 'Bedroom', { groupedWith: 'kitchen' }),
      zone('office', 'Office'),
      zone('living', 'Living room', { groupable: false, deviceId: 'dlna:living' }),
    ];
  });

  it('shows the group, offers the other Sonos rooms, and never a DLNA speaker', () => {
    render(<GroupMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Group · 2' }));
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['✓ Bedroomin group', 'Office']);
  });

  it('lets a room join, and takes one out', async () => {
    render(<GroupMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Group · 2' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Office' }));
    await waitFor(() => expect(mocks.api.groupZone).toHaveBeenCalledWith('office'));
    expect(mocks.toast).toHaveBeenCalledWith('Office plays along with Kitchen', 'success');
    fireEvent.click(screen.getByRole('button', { name: 'Group · 2' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Bedroom/ }));
    await waitFor(() => expect(mocks.api.ungroupZone).toHaveBeenCalledWith('bedroom'));
    expect(mocks.audio.refreshZones).toHaveBeenCalled();
  });

  it('in a member room: says with whom it plays, steers the leader or leaves', async () => {
    mocks.audio.zoneId = 'bedroom';
    render(<GroupMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'With Kitchen' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Steer Kitchen' }));
    expect(mocks.audio.setSelectedDeviceId).toHaveBeenCalledWith('RINCON_kitchen');
    fireEvent.click(screen.getByRole('button', { name: 'With Kitchen' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Leave the group' }));
    await waitFor(() => expect(mocks.api.ungroupZone).toHaveBeenCalledWith('bedroom'));
  });

  it('stays away from rooms that are not Sonos', () => {
    mocks.audio.zoneId = 'living';
    const { container } = render(<GroupMenu />);
    expect(container).toBeEmptyDOMElement();
  });
});
