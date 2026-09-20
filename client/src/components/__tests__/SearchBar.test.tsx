import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('../../api/client.js', () => ({ api: { search: mocks.search } }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mocks.navigate };
});

const { default: SearchBar } = await import('../SearchBar.js');

const results = {
  artists: [{ id: 'ar-1', name: 'Miles Davis' }],
  albums: [{ id: 'al-1', title: 'Kind of Blue', artistName: 'Miles Davis' }],
  tracks: [
    {
      id: 't1',
      title: 'So What',
      artistName: 'Miles Davis',
      albumTitle: 'Kind of Blue',
      albumId: 'al-1',
    },
    { id: 't2', title: 'Homeless', artistName: 'Nobody', albumTitle: 'Gone' },
  ],
};

function renderBar() {
  return render(
    <MemoryRouter>
      <SearchBar />
    </MemoryRouter>,
  );
}

function type(text: string) {
  fireEvent.change(screen.getByRole('combobox', { name: 'Search your library' }), {
    target: { value: text },
  });
}

/**
 * R02.2: search from anywhere. The drop-down is a jump list from the library,
 * so it can answer while you type; the full search page is where the streaming
 * sources and filters are, and Enter goes there.
 */
describe('SearchBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.search.mockResolvedValue({ data: results });
  });

  it('suggests artists, albums and tracks from the library', async () => {
    renderBar();
    type('miles');

    // The artist's name also appears as an album's detail line, so these ask
    // for the row, not for the words.
    expect(
      await screen.findByRole('option', { name: /^Artist\s*Miles Davis/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^Album\s*Kind of Blue/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^Track\s*So What/ })).toBeInTheDocument();
    expect(mocks.search).toHaveBeenCalledWith('miles', expect.any(Number));
  });

  it('asks nothing for a single letter', async () => {
    renderBar();
    type('m');

    await new Promise((r) => setTimeout(r, 300));
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it('leaves a track without an album out, since it has nowhere to jump to', async () => {
    renderBar();
    type('miles');

    await screen.findByRole('option', { name: /^Track\s*So What/ });
    expect(screen.queryByRole('option', { name: /Homeless/ })).not.toBeInTheDocument();
  });

  it('opens the full search on Enter', async () => {
    renderBar();
    type('miles davis');
    const input = screen.getByRole('combobox', { name: 'Search your library' });

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mocks.navigate).toHaveBeenCalledWith('/search?q=miles%20davis');
  });

  it('jumps to the suggestion chosen with the arrow keys', async () => {
    renderBar();
    type('miles');
    await screen.findByRole('option', { name: /^Artist\s*Miles Davis/ });
    const input = screen.getByRole('combobox', { name: 'Search your library' });

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mocks.navigate).toHaveBeenCalledWith('/artists/ar-1');
  });

  it('sends a track suggestion to its album, so a list never starts playing', async () => {
    renderBar();
    type('so what');
    fireEvent.click(await screen.findByRole('option', { name: /^Track\s*So What/ }));

    expect(mocks.navigate).toHaveBeenCalledWith('/albums/al-1');
  });

  it('takes the focus when / is pressed on the page', () => {
    renderBar();
    const input = screen.getByRole('combobox', { name: 'Search your library' });

    fireEvent.keyDown(window, { key: '/' });

    expect(input).toHaveFocus();
  });

  it('leaves / alone while someone is typing in a field', () => {
    render(
      <MemoryRouter>
        <input aria-label="other field" />
        <SearchBar />
      </MemoryRouter>,
    );
    const other = screen.getByLabelText('other field');
    other.focus();

    fireEvent.keyDown(other, { key: '/' });

    expect(other).toHaveFocus();
  });

  it('closes the list on Escape', async () => {
    renderBar();
    type('miles');
    await screen.findByRole('option', { name: /^Artist\s*Miles Davis/ });

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Search your library' }), {
      key: 'Escape',
    });

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
