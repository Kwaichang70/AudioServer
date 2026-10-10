import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The identification screen (R03.4). What it has to get right is the doubtful
 * list: every candidate visible with the facts that tell releases apart, and
 * a way to say "none of these" instead of being pushed into a choice.
 */

const mocks = vi.hoisted(() => ({
  api: {
    identifyAlbums: vi.fn(),
    getIdentifyStatus: vi.fn(),
    getDoubtfulAlbums: vi.fn(),
    chooseAlbumIdentity: vi.fn(),
    dismissAlbumCandidates: vi.fn(),
  },
  toast: vi.fn(),
}));

vi.mock('../../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../../components/Toast.js', () => ({ useToast: () => ({ toast: mocks.toast }) }));

const { default: IdentifySection } = await import('../IdentifySection.js');

const idle = {
  isRunning: false,
  total: 0,
  processed: 0,
  linked: 0,
  doubtful: 0,
  notFound: 0,
  startedAt: null,
  finishedAt: null,
};

const doubtful = [
  {
    albumId: 'al-1',
    title: 'Kind of Blue',
    artistName: 'Miles Davis',
    trackCount: 5,
    candidates: [
      {
        mbid: 'rel-1',
        title: 'Kind of Blue',
        artist: 'Miles Davis',
        releaseGroupMbid: 'rg-1',
        label: 'Columbia',
        catalogNumber: 'CL 1355',
        date: '1959-08-17',
        trackCount: 5,
        score: 100,
      },
      {
        mbid: 'rel-2',
        title: 'Kind of Blue',
        artist: 'Miles Davis',
        releaseGroupMbid: 'rg-2',
        label: 'Legacy',
        catalogNumber: 'CK 64935',
        date: '1997',
        trackCount: 5,
        score: 97,
      },
    ],
  },
];

describe('IdentifySection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.getIdentifyStatus.mockResolvedValue({ data: idle });
    mocks.api.getDoubtfulAlbums.mockResolvedValue({ data: doubtful });
    mocks.api.chooseAlbumIdentity.mockResolvedValue({ data: { ok: true } });
    mocks.api.dismissAlbumCandidates.mockResolvedValue({ data: { ok: true } });
    mocks.api.identifyAlbums.mockResolvedValue({ data: { ...idle, isRunning: true } });
  });

  it('shows each candidate with what tells the releases apart', async () => {
    render(<IdentifySection />);
    // The album plus each candidate: the title appears for all of them.
    expect((await screen.findAllByText(/Kind of Blue/)).length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText(/Columbia · CL 1355/)).toBeTruthy();
    expect(screen.getByText(/Legacy · CK 64935/)).toBeTruthy();
  });

  it('links the release the admin picks', async () => {
    render(<IdentifySection />);
    const buttons = await screen.findAllByText('This one');
    fireEvent.click(buttons[1]);
    await waitFor(() =>
      expect(mocks.api.chooseAlbumIdentity).toHaveBeenCalledWith('al-1', 'rel-2'),
    );
  });

  it('can leave an album unidentified', async () => {
    render(<IdentifySection />);
    fireEvent.click(await screen.findByText(/None of these/));
    await waitFor(() => expect(mocks.api.dismissAlbumCandidates).toHaveBeenCalledWith('al-1'));
  });

  it('starts the job and shows it is running', async () => {
    render(<IdentifySection />);
    fireEvent.click(await screen.findByText('Identify albums'));
    await waitFor(() => expect(mocks.api.identifyAlbums).toHaveBeenCalled());
    expect(await screen.findByText('Running…')).toBeTruthy();
  });

  it('says so plainly when there is nothing to decide', async () => {
    mocks.api.getDoubtfulAlbums.mockResolvedValue({ data: [] });
    render(<IdentifySection />);
    expect(await screen.findByText(/Nothing to decide/)).toBeTruthy();
  });
});
