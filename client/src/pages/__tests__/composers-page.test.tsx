import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Composers (R04.4): a list from the composer credits, and a page per work. */

const mocks = vi.hoisted(() => ({
  api: { getComposers: vi.fn(), getComposer: vi.fn() },
  audio: { playAlbum: vi.fn() },
}));

vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../context/AudioContext.js', () => ({ useAudioContext: () => mocks.audio }));

const { default: ComposersPage } = await import('../ComposersPage.js');

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/composers', element: <ComposersPage /> },
      { path: '/composers/:id', element: <ComposersPage /> },
    ],
    { initialEntries: [path] },
  );
  return render(<RouterProvider router={router} />);
}

describe('ComposersPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.getComposers.mockResolvedValue({
      data: [
        { id: 'ar-mahler', name: 'Gustav Mahler', trackCount: 4, albumCount: 2, workCount: 1 },
      ],
    });
    mocks.api.getComposer.mockResolvedValue({
      data: {
        id: 'ar-mahler',
        name: 'Gustav Mahler',
        works: [
          {
            work: 'Symphony No. 5',
            recordings: [
              {
                albumId: 'al-vpo',
                albumTitle: 'Mahler 5',
                albumArtist: 'Wiener Philharmoniker',
                year: 1987,
                tracks: [
                  {
                    id: 'v1',
                    title: 'I.',
                    movement: 'I. Trauermarsch',
                    duration: 600,
                    missing: false,
                  },
                  {
                    id: 'v4',
                    title: 'IV.',
                    movement: 'IV. Adagietto',
                    duration: 600,
                    missing: false,
                  },
                ],
              },
            ],
          },
          {
            work: null,
            recordings: [
              {
                albumId: 'al-bpo',
                albumTitle: 'Lieder',
                albumArtist: 'Berliner Philharmoniker',
                year: 1993,
                tracks: [
                  {
                    id: 'l1',
                    title: 'Ich bin der Welt',
                    movement: null,
                    duration: 400,
                    missing: false,
                  },
                ],
              },
            ],
          },
        ],
      },
    });
  });

  it('lists composers with their works and albums', async () => {
    renderAt('/composers');
    expect(await screen.findByText('Gustav Mahler')).toBeTruthy();
    expect(screen.getByText(/1 work · 2 albums · 4 tracks/)).toBeTruthy();
  });

  it('shows a composer by work, untagged pieces included', async () => {
    renderAt('/composers/ar-mahler');
    expect(await screen.findByText('Symphony No. 5')).toBeTruthy();
    expect(screen.getByText('IV. Adagietto')).toBeTruthy();
    expect(screen.getByText('Other pieces')).toBeTruthy();
    expect(screen.getByText('Ich bin der Welt')).toBeTruthy();
  });

  it('plays a recording from the movement that was clicked', async () => {
    renderAt('/composers/ar-mahler');
    fireEvent.click(await screen.findByText('IV. Adagietto'));
    await waitFor(() => expect(mocks.audio.playAlbum).toHaveBeenCalled());
    const [queue, index] = mocks.audio.playAlbum.mock.calls[0];
    expect(queue.map((t: { id: string }) => t.id)).toEqual(['v1', 'v4']);
    expect(index).toBe(1);
  });
});
