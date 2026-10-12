import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tags (R06.2): a tag page to open and shuffle, editable only when it is
 * yours; and "Add tag" in the play-actions menu.
 */

const mocks = vi.hoisted(() => ({
  api: {
    getTags: vi.fn(),
    getTag: vi.fn(),
    getTagTracks: vi.fn(),
    getTagsOn: vi.fn(),
    createTag: vi.fn(),
    updateTag: vi.fn(),
    deleteTag: vi.fn(),
    addTagItem: vi.fn(),
    removeTagItem: vi.fn(),
    checkFavorite: vi.fn(),
    getAlbumCoverUrl: vi.fn((id: string) => `/covers/${id}`),
  },
  audio: {
    playAlbum: vi.fn(),
    playNow: vi.fn(),
    playNextTracks: vi.fn(),
    queueTracks: vi.fn(),
  },
  toast: vi.fn(),
}));

vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../context/AudioContext.js', () => ({ useAudioContext: () => mocks.audio }));
vi.mock('../../components/Toast.js', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('../../components/AlbumCover.js', () => ({
  default: ({ title }: { title: string }) => <div>{title}</div>,
}));

const { default: TagsPage } = await import('../TagsPage.js');
const { default: PlayActions } = await import('../../components/PlayActions.js');

const counts = (album = 0, track = 0) => ({ album, artist: 0, track, playlist: 0 });
const sunday = {
  id: 'tag-sun',
  name: 'Zondagochtend',
  shared: false,
  mine: true,
  ownerName: null as string | null,
  itemCount: 12,
  counts: counts(12),
};
const family = {
  id: 'tag-fam',
  name: 'Family',
  shared: true,
  mine: false,
  ownerName: 'Anna',
  itemCount: 1,
  counts: counts(1),
};

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/tags', element: <TagsPage /> },
      { path: '/tags/:id', element: <TagsPage /> },
    ],
    { initialEntries: [path] },
  );
  return render(<RouterProvider router={router} />);
}

const detail = (tag: typeof sunday | typeof family) => ({
  ...tag,
  items: {
    albums: [{ id: 'al-1', title: 'Pink Moon', artistName: 'Nick Drake' }],
    artists: [],
    tracks: [],
    playlists: [],
  },
});

describe('Tags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.getTags.mockResolvedValue({ data: [sunday, family] });
    mocks.api.getTag.mockImplementation((id: string) =>
      Promise.resolve({ data: detail(id === 'tag-fam' ? family : sunday) }),
    );
    mocks.api.getTagTracks.mockResolvedValue({
      data: [
        { id: 't-1', title: 'Pink Moon', artistName: 'Nick Drake' },
        { id: 't-2', title: 'Place to Be', artistName: 'Nick Drake' },
      ],
    });
    mocks.api.createTag.mockResolvedValue({ data: { ...sunday, id: 'tag-new', name: 'Car' } });
    mocks.api.addTagItem.mockResolvedValue({ data: sunday });
    mocks.api.getTagsOn.mockResolvedValue({ data: [family] });
    mocks.api.checkFavorite.mockResolvedValue({ data: { favorited: false } });
  });

  it('lists your tags and the shared ones, each to shuffle', async () => {
    renderAt('/tags');
    const mine = await screen.findByRole('list', { name: 'Your tags' });
    expect(within(mine).getByText(/Zondagochtend/)).toBeInTheDocument();
    expect(within(mine).getByText('12 albums')).toBeInTheDocument();
    const shared = screen.getByRole('list', { name: 'Shared with you' });
    expect(within(shared).getByText('from Anna')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Shuffle Zondagochtend' }));
    await waitFor(() => expect(mocks.audio.playAlbum).toHaveBeenCalled());
    expect(mocks.api.getTagTracks).toHaveBeenCalledWith('tag-sun');
  });

  it('creates a tag, shared if you say so', async () => {
    renderAt('/tags');
    await screen.findByRole('list', { name: 'Your tags' });
    const form = screen.getByRole('form', { name: 'New tag' });
    fireEvent.change(within(form).getByRole('textbox'), { target: { value: 'Car' } });
    fireEvent.click(within(form).getByRole('checkbox'));
    fireEvent.click(within(form).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(mocks.api.createTag).toHaveBeenCalledWith('Car', true));
  });

  it('plays a tag in order and offers to edit only your own', async () => {
    renderAt('/tags/tag-sun');
    expect(await screen.findByRole('heading', { name: '# Zondagochtend' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /▶ Play/ }));
    await waitFor(() => expect(mocks.audio.playAlbum).toHaveBeenCalled());
    const [list] = mocks.audio.playAlbum.mock.calls[0];
    expect(list.map((t: { id: string }) => t.id)).toEqual(['t-1', 't-2']);
    expect(screen.getByRole('button', { name: 'Rename' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Remove Pink Moon from Zondagochtend' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Refine in Focus' })).toHaveAttribute(
      'href',
      '/albums?tag=tag-sun',
    );
  });

  it("shows someone else's shared tag read-only", async () => {
    renderAt('/tags/tag-fam');
    await screen.findByRole('heading', { name: '# Family' });
    expect(screen.getByText(/from Anna/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove Pink Moon/ })).not.toBeInTheDocument();
  });

  it('tags an album from its menu, offering only your own tags', async () => {
    const changed = vi.fn();
    window.addEventListener('audioserver:tags-changed', changed);
    render(<PlayActions target={{ kind: 'album', albumId: 'al-1', title: 'Pink Moon' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Pink Moon' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Add tag/ }));
    const item = await screen.findByRole('menuitem', { name: 'Zondagochtend' });
    expect(screen.queryByRole('menuitem', { name: 'Family' })).not.toBeInTheDocument();
    fireEvent.click(item);
    await waitFor(() =>
      expect(mocks.api.addTagItem).toHaveBeenCalledWith('tag-sun', 'album', 'al-1'),
    );
    await waitFor(() => expect(changed).toHaveBeenCalled());

    fireEvent.change(screen.getByRole('textbox', { name: 'New tag name' }), {
      target: { value: 'Car' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(mocks.api.createTag).toHaveBeenCalledWith('Car'));
    await waitFor(() =>
      expect(mocks.api.addTagItem).toHaveBeenCalledWith('tag-new', 'album', 'al-1'),
    );
    window.removeEventListener('audioserver:tags-changed', changed);
  });
});
