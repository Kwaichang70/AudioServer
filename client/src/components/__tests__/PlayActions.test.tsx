import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: {
    checkFavorite: vi.fn(),
    toggleFavorite: vi.fn(),
    getAlbumTracks: vi.fn(),
    getArtistTracks: vi.fn(),
    getPlaylists: vi.fn(),
    addToPlaylist: vi.fn(),
  },
  audio: {
    playNow: vi.fn(() => Promise.resolve()),
    playNextTracks: vi.fn(() => Promise.resolve()),
    queueTracks: vi.fn(() => Promise.resolve()),
    playAlbum: vi.fn(),
  },
  toast: vi.fn(),
}));

vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../context/AudioContext.js', () => ({ useAudioContext: () => mocks.audio }));
vi.mock('../Toast.js', () => ({ useToast: () => ({ toast: mocks.toast }) }));

const { default: PlayActions, openRowMenuFromKey } = await import('../PlayActions.js');

const track = {
  id: 't1',
  title: 'So What',
  artistName: 'Miles Davis',
  albumTitle: 'Kind of Blue',
  albumId: 'al-1',
  duration: 560,
};

function openMenu(name = 'More actions for So What') {
  fireEvent.click(screen.getByRole('button', { name }));
  return screen.getByRole('menu');
}

/**
 * R01.2: the same play actions on every row. What these guard is mostly what
 * the menu must NOT do: replace the queue, let a click fall through to the row
 * underneath (which would start playing it), or offer a heart and a playlist
 * for a streaming item that has no library id to store.
 */
describe('PlayActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.checkFavorite.mockResolvedValue({ data: { favorited: false } });
    mocks.api.toggleFavorite.mockResolvedValue({ data: { favorited: true } });
    mocks.api.getPlaylists.mockResolvedValue({ data: [{ id: 'pl-1', name: 'Sunday' }] });
    mocks.api.addToPlaylist.mockResolvedValue({ data: { ok: true, trackCount: 1 } });
  });

  it('offers play now, play next and add to queue for a track', () => {
    render(<PlayActions target={{ kind: 'track', track }} />);
    openMenu();

    expect(screen.getByRole('menuitem', { name: 'Play now' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Play next' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Add to queue' })).toBeInTheDocument();
  });

  it('puts the track after the current one on "Play next" and closes', async () => {
    render(<PlayActions target={{ kind: 'track', track }} />);
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Play next' }));

    await waitFor(() => expect(mocks.audio.playNextTracks).toHaveBeenCalledWith([track]));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('never lets a click reach the row underneath', () => {
    const rowClick = vi.fn();
    render(
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
      <div onClick={rowClick}>
        <PlayActions target={{ kind: 'track', track }} />
      </div>,
    );

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to queue' }));

    expect(rowClick).not.toHaveBeenCalled();
  });

  it('keeps Enter on the trigger from reaching a row that plays on Enter', () => {
    const rowKey = vi.fn();
    render(
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions
      <div onKeyDown={rowKey}>
        <PlayActions target={{ kind: 'track', track }} />
      </div>,
    );

    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions for So What' }), {
      key: 'Enter',
    });

    expect(rowKey).not.toHaveBeenCalled();
  });

  it('closes on Escape and gives focus back to the trigger', () => {
    render(<PlayActions target={{ kind: 'track', track }} />);
    const menu = openMenu();

    fireEvent.keyDown(menu, { key: 'Escape' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More actions for So What' })).toHaveFocus();
  });

  it('moves between items with the arrow keys, starting on the first', () => {
    render(<PlayActions target={{ kind: 'track', track }} />);
    const menu = openMenu();

    expect(screen.getByRole('menuitem', { name: 'Play now' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Play next' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    // Wraps from the first item to the last.
    expect(screen.getByRole('menuitem', { name: 'Add to favorites' })).toHaveFocus();
  });

  it('offers "play from here" only for a track that belongs to a list', () => {
    const list = [track, { ...track, id: 't2', title: 'Freddie Freeloader' }];
    const { unmount } = render(<PlayActions target={{ kind: 'track', track }} />);
    openMenu();
    expect(screen.queryByRole('menuitem', { name: 'Play from here' })).not.toBeInTheDocument();
    unmount();

    render(<PlayActions target={{ kind: 'track', track: list[1], list, index: 1 }} />);
    openMenu('More actions for Freddie Freeloader');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Play from here' }));

    expect(mocks.audio.playAlbum).toHaveBeenCalledWith(list, 1);
  });

  it('adds a whole album to the queue, without missing files or file paths', async () => {
    mocks.api.getAlbumTracks.mockResolvedValue({
      data: [
        { ...track, filePath: '//diskstation/Music/a.flac', availability: 'available' },
        { ...track, id: 't9', title: 'Gone', availability: 'missing' },
      ],
    });
    render(<PlayActions target={{ kind: 'album', albumId: 'al-1', title: 'Kind of Blue' }} />);
    openMenu('More actions for Kind of Blue');

    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to queue' }));

    await waitFor(() => expect(mocks.audio.queueTracks).toHaveBeenCalledTimes(1));
    const [queued] = mocks.audio.queueTracks.mock.calls[0] as unknown as [
      Array<Record<string, unknown>>,
    ];
    expect(queued.map((t) => t.id)).toEqual(['t1']);
    expect(queued[0]).not.toHaveProperty('filePath');
    expect(mocks.api.getAlbumTracks).toHaveBeenCalledWith('al-1');
  });

  it('plays an artist from all of its tracks, and can shuffle them', async () => {
    mocks.api.getArtistTracks.mockResolvedValue({ data: [track] });
    render(<PlayActions target={{ kind: 'artist', artistId: 'ar-1', name: 'Miles Davis' }} />);
    openMenu('More actions for Miles Davis');

    fireEvent.click(screen.getByRole('menuitem', { name: 'Play now' }));
    await waitFor(() =>
      expect(mocks.audio.playNow).toHaveBeenCalledWith([expect.objectContaining({ id: 't1' })]),
    );
    expect(mocks.api.getArtistTracks).toHaveBeenCalledWith('ar-1');

    openMenu('More actions for Miles Davis');
    expect(screen.getByRole('menuitem', { name: 'Shuffle' })).toBeInTheDocument();
  });

  it('says so when an album has nothing playable', async () => {
    mocks.api.getAlbumTracks.mockResolvedValue({ data: [] });
    render(<PlayActions target={{ kind: 'album', albumId: 'al-2', title: 'Empty' }} />);
    openMenu('More actions for Empty');

    fireEvent.click(screen.getByRole('menuitem', { name: 'Play next' }));

    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith('Nothing playable in Empty', 'info'),
    );
    expect(mocks.audio.playNextTracks).not.toHaveBeenCalled();
  });

  it('offers no heart and no playlist for a streaming track', () => {
    render(<PlayActions target={{ kind: 'track', track: { ...track, id: 'qobuz:123' } }} />);
    openMenu();

    expect(screen.queryByRole('menuitem', { name: /favorites/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /playlist/ })).not.toBeInTheDocument();
    expect(mocks.api.checkFavorite).not.toHaveBeenCalled();
  });

  it('shows whether the track is already a favorite, and toggles it', async () => {
    mocks.api.checkFavorite.mockResolvedValue({ data: { favorited: true } });
    mocks.api.toggleFavorite.mockResolvedValue({ data: { favorited: false } });
    render(<PlayActions target={{ kind: 'track', track }} />);
    openMenu();

    const item = await screen.findByRole('menuitem', { name: 'Remove from favorites' });
    fireEvent.click(item);

    await waitFor(() => expect(mocks.api.toggleFavorite).toHaveBeenCalledWith('track', 't1'));
  });

  it('adds the track to a chosen playlist from inside the menu', async () => {
    render(<PlayActions target={{ kind: 'track', track }} />);
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: /Add to playlist/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sunday' }));

    await waitFor(() => expect(mocks.api.addToPlaylist).toHaveBeenCalledWith('pl-1', 't1'));
  });

  it('opens from its row with Shift+F10 where the trigger is not a tab stop', () => {
    render(
      <div data-play-actions-row>
        <button type="button" onKeyDown={openRowMenuFromKey}>
          Row
        </button>
        <PlayActions target={{ kind: 'track', track }} triggerTabIndex={-1} />
      </div>,
    );

    fireEvent.keyDown(screen.getByRole('button', { name: 'Row' }), {
      key: 'F10',
      shiftKey: true,
    });

    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  describe('on a phone', () => {
    const desktopWidth = window.innerWidth;
    beforeEach(() => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    });
    afterEach(() => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: desktopWidth });
    });

    it('opens as a sheet from the bottom, named after the item', () => {
      render(<PlayActions target={{ kind: 'track', track }} />);
      openMenu();

      // The sheet has a backdrop to tap away and repeats what it is about,
      // because on a phone the row it came from may be scrolled away.
      expect(screen.getByRole('button', { name: 'Close menu' })).toBeInTheDocument();
      expect(screen.getByRole('menu')).toHaveTextContent('So What');
    });

    it('closes when the backdrop is tapped, without acting', () => {
      render(<PlayActions target={{ kind: 'track', track }} />);
      openMenu();

      fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));

      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(mocks.audio.playNow).not.toHaveBeenCalled();
    });
  });
});
