import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const track = {
    id: 'track-1',
    title: 'Night Drive',
    artistName: 'The Tests',
    albumTitle: 'Coverage',
    albumId: 'album-1',
    duration: 180,
    format: 'flac',
    sampleRate: 44100,
    bitDepth: 16,
  };

  const secondTrack = {
    id: 'track-2',
    title: 'Second Song',
    artistName: 'The Tests',
    albumTitle: 'Coverage',
  };

  const actions = {
    setSelectedDeviceId: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    setVolume: vi.fn(),
    seek: vi.fn(),
    playNext: vi.fn(),
    playPrevious: vi.fn(),
    toggleShuffle: vi.fn(),
    toggleRepeat: vi.fn(),
    removeFromQueue: vi.fn(),
    moveInQueue: vi.fn(),
    clearQueue: vi.fn(),
  };

  const makeContext = (overrides = {}) => ({
    currentTrack: track,
    isPlaying: false,
    isLoading: false,
    volume: 0.7,
    queue: [track, secondTrack],
    queueIndex: 0,
    selectedDeviceId: 'browser',
    shuffle: false,
    repeat: 'off',
    ...actions,
    ...overrides,
  });

  return {
    track,
    secondTrack,
    actions,
    context: makeContext(),
    progress: { currentTime: 45, duration: 180 },
    makeContext,
    navigate: vi.fn(),
  };
});

vi.mock('../../context/AudioContext.js', () => ({
  useAudioContext: () => mocks.context,
  useProgress: () => mocks.progress,
}));

vi.mock('../../api/client.js', () => ({
  api: {
    getAlbumCoverUrl: vi.fn((albumId: string) => `/api/library/albums/${albumId}/cover`),
    getTrackCoverUrl: vi.fn((trackId: string) => `/api/library/tracks/${trackId}/cover`),
  },
}));

vi.mock('../DeviceSelector.js', () => ({
  default: ({
    selectedDeviceId,
    onSelect,
  }: {
    selectedDeviceId: string;
    onSelect: (id: string) => void;
  }) => (
    <button onClick={() => onSelect('browser')} data-testid="device-selector">
      Device: {selectedDeviceId}
    </button>
  ),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
  };
});

const { default: NowPlayingBar } = await import('../NowPlayingBar.js');

function renderBar() {
  return render(
    <MemoryRouter>
      <NowPlayingBar />
    </MemoryRouter>,
  );
}

describe('NowPlayingBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context = mocks.makeContext();
    mocks.progress = { currentTime: 45, duration: 180 };
  });

  it('renders the idle state when no track is selected', () => {
    mocks.context = mocks.makeContext({ currentTrack: null, queue: [], queueIndex: -1 });

    renderBar();

    expect(screen.getByText('No track playing')).toBeInTheDocument();
    expect(screen.getByTestId('device-selector')).toHaveTextContent('Device: browser');
  });

  it('shows current track metadata and progress', () => {
    renderBar();

    expect(screen.getByText('Night Drive')).toBeInTheDocument();
    expect(screen.getByText(/The Tests.*Coverage/)).toBeInTheDocument();
    expect(screen.getByText('0:45')).toBeInTheDocument();
    expect(screen.getByText('3:00')).toBeInTheDocument();
    expect(screen.getByText('FLAC/44.1kHz/16bit')).toBeInTheDocument();
  });

  it('toggles playback controls', () => {
    renderBar();

    fireEvent.click(screen.getByLabelText('Play'));
    expect(mocks.actions.resume).toHaveBeenCalled();

    mocks.context = mocks.makeContext({ isPlaying: true });
    renderBar();

    fireEvent.click(screen.getByLabelText('Pause'));
    expect(mocks.actions.pause).toHaveBeenCalled();
  });

  it('wires previous, next, shuffle, repeat, and volume controls', () => {
    renderBar();

    fireEvent.click(screen.getByTitle('Shuffle off'));
    fireEvent.click(screen.getByTitle('Previous'));
    fireEvent.click(screen.getByTitle('Next'));
    fireEvent.click(screen.getByTitle('Repeat off'));
    // Two sliders exist now (Seek + Volume); target the volume control by name.
    fireEvent.change(screen.getByRole('slider', { name: 'Volume' }), {
      target: { value: '0.25' },
    });

    expect(mocks.actions.toggleShuffle).toHaveBeenCalled();
    expect(mocks.actions.playPrevious).toHaveBeenCalled();
    expect(mocks.actions.playNext).toHaveBeenCalled();
    expect(mocks.actions.toggleRepeat).toHaveBeenCalled();
    expect(mocks.actions.setVolume).toHaveBeenCalledWith(0.25);
  });

  it('opens queue controls and clears the queue', () => {
    renderBar();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle queue' }));

    expect(screen.getByText('Queue (2 tracks)')).toBeInTheDocument();
    expect(screen.getAllByText('Night Drive').length).toBeGreaterThan(0);
    expect(screen.getByText('Second Song')).toBeInTheDocument();

    const removeButton = screen.getByRole('button', { name: 'Remove Second Song from queue' });
    expect(removeButton).toHaveClass('group-focus-within:opacity-100');
    fireEvent.click(removeButton);
    expect(mocks.actions.removeFromQueue).toHaveBeenCalledWith(1);

    fireEvent.click(screen.getByTitle('Clear queue'));
    expect(mocks.actions.clearQueue).toHaveBeenCalled();
  });

  it('shows external device state', () => {
    mocks.context = mocks.makeContext({ selectedDeviceId: 'sonos-office' });

    renderBar();

    expect(screen.getByText('Playing on external device')).toBeInTheDocument();
    expect(screen.getByTestId('device-selector')).toHaveTextContent('Device: sonos-office');
  });
});
