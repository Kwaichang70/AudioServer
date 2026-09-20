import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: { id: 'u1', username: 'danny', role: 'admin' } as { username: string } | null,
  signOut: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('../../context/AuthContext.js', () => ({
  useAuth: () => ({ user: mocks.user, signOut: mocks.signOut }),
}));
vi.mock('../../context/AudioContext.js', () => ({
  AudioProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../NowPlayingBar.js', () => ({ default: () => <div data-testid="player-bar" /> }));
vi.mock('../AppStatusBanners.js', () => ({ default: () => null }));
vi.mock('../KeyboardShortcuts.js', () => ({ KeyboardShortcuts: () => null }));
vi.mock('../SearchBar.js', () => ({ default: () => <div data-testid="search-bar" /> }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mocks.navigate };
});

const { default: Layout } = await import('../Layout.js');

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Layout />
    </MemoryRouter>,
  );
}

/**
 * R02.1: the frame. Fourteen equal links became named groups on a desktop and
 * four tabs plus "More" on a phone. These check the grouping and that nothing
 * fell off the list on the way.
 */
describe('Layout navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = { username: 'danny' };
  });

  it('groups the sidebar by what things are', () => {
    renderLayout();
    const sidebar = screen.getByRole('navigation', { name: 'Main' });

    expect(within(sidebar).getByText('Library')).toBeInTheDocument();
    expect(within(sidebar).getByText('Collections')).toBeInTheDocument();
    expect(within(sidebar).getByText('Discover')).toBeInTheDocument();
  });

  it('keeps every section reachable from the sidebar', () => {
    renderLayout();
    const sidebar = screen.getByRole('navigation', { name: 'Main' });

    for (const label of [
      'Home',
      'Search',
      'Albums',
      'Artists',
      'Genres',
      'Favorites',
      'Playlists',
      'Smart playlists',
      'For you',
      'Radio',
      'History',
      'Stats',
      'Queue',
      'Settings',
    ]) {
      expect(within(sidebar).getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('puts four tabs plus More within thumb reach on a phone', () => {
    renderLayout();
    const tabs = screen.getByRole('navigation', { name: 'Sections' });

    expect(
      within(tabs)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['⌂Home', '⌕Search', '▤Albums', '≡Queue']);
    expect(within(tabs).getByRole('button', { name: /More/ })).toBeInTheDocument();
  });

  it('opens the rest of the sections from More, and navigates on a tap', () => {
    renderLayout();
    fireEvent.click(screen.getByRole('button', { name: /More/ }));

    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Radio' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Settings' })).toBeInTheDocument();
    // Tabs are not repeated in the sheet.
    expect(within(menu).queryByRole('menuitem', { name: 'Home' })).not.toBeInTheDocument();

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Radio' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/radio');
  });

  it('signs out from the sidebar and from More', () => {
    renderLayout();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out danny' }));
    expect(mocks.signOut).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /More/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Sign out \(danny\)/ }));
    expect(mocks.signOut).toHaveBeenCalledTimes(2);
  });

  it('shows no sign-out when nobody is signed in', () => {
    mocks.user = null;
    renderLayout();

    expect(screen.queryByRole('button', { name: /Sign out/ })).not.toBeInTheDocument();
  });

  it('keeps the player bar and the search bar on every page', () => {
    renderLayout();

    expect(screen.getByTestId('player-bar')).toBeInTheDocument();
    expect(screen.getByTestId('search-bar')).toBeInTheDocument();
  });
});
