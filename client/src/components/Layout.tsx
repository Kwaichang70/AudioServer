import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import NowPlayingBar from './NowPlayingBar.js';
import { AudioProvider } from '../context/AudioContext.js';
import { KeyboardShortcuts } from './KeyboardShortcuts.js';
import { useAuth } from '../context/AuthContext.js';
import AppStatusBanners from './AppStatusBanners.js';
import SearchBar from './SearchBar.js';
import { Menu, MenuItem, MenuSeparator } from './ui/Menu.js';

const NowPlayingFull = lazy(() => import('./NowPlayingFull.js'));

/**
 * The frame around every page (R02.1).
 *
 * Fourteen equal links in one row said nothing about what belongs together,
 * and on a phone they were a drawer you had to open first. A desktop now gets
 * a sidebar with named groups, a phone gets five tabs within thumb reach, and
 * both get the search bar in the header. Groups that belong to later sprints
 * (composers, tags, bookmarks) are simply not here yet.
 */

interface NavItem {
  to: string;
  label: string;
  /** The four that fit on a phone's tab bar; the rest live under "More". */
  tab?: { order: number; icon: string };
}

interface NavGroup {
  label: string | null;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    label: null,
    items: [
      { to: '/', label: 'Home', tab: { order: 1, icon: '⌂' } },
      { to: '/search', label: 'Search', tab: { order: 2, icon: '⌕' } },
    ],
  },
  {
    label: 'Library',
    items: [
      { to: '/albums', label: 'Albums', tab: { order: 3, icon: '▤' } },
      { to: '/artists', label: 'Artists' },
      { to: '/genres', label: 'Genres' },
    ],
  },
  {
    label: 'Collections',
    items: [
      { to: '/favorites', label: 'Favorites' },
      { to: '/playlists', label: 'Playlists' },
      { to: '/smart-playlists', label: 'Smart playlists' },
    ],
  },
  {
    label: 'Discover',
    items: [
      { to: '/discover', label: 'For you' },
      { to: '/radio', label: 'Radio' },
      { to: '/history', label: 'History' },
      { to: '/stats', label: 'Stats' },
    ],
  },
  {
    label: null,
    items: [
      { to: '/queue', label: 'Queue', tab: { order: 4, icon: '≡' } },
      { to: '/settings', label: 'Settings' },
    ],
  },
];

const ALL_ITEMS = NAV.flatMap((group) => group.items);
const TABS = ALL_ITEMS.filter((item) => item.tab).sort((a, b) => a.tab!.order - b.tab!.order);
const MORE_ITEMS = ALL_ITEMS.filter((item) => !item.tab);

const sidebarLink = ({ isActive }: { isActive: boolean }) =>
  `block rounded px-3 py-1.5 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
    isActive ? 'bg-accent' : 'text-gray-400 hover:bg-white/10 hover:text-white'
  }`;

export default function Layout() {
  // Which view the full player opens on; false = closed (R01.3 adds lyrics).
  const [fullscreen, setFullscreen] = useState<false | 'upnext' | 'lyrics'>(false);
  const showFullscreen = fullscreen !== false;
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showFullscreen) setFullscreen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showFullscreen]);

  return (
    <AudioProvider>
      <div className="flex h-screen flex-col bg-surface-dark">
        <AppStatusBanners />

        <div className="flex min-h-0 flex-1">
          {/* Sidebar (desktop) */}
          <aside className="hidden w-56 shrink-0 flex-col border-r border-white/10 bg-surface md:flex">
            <h1 className="px-4 py-4 text-xl font-bold tracking-wide text-accent">AudioServer</h1>
            <nav aria-label="Main" className="flex-1 overflow-y-auto px-2 pb-4">
              {NAV.map((group, index) => (
                <div key={group.label ?? `group-${index}`} className="mb-4">
                  {group.label && (
                    <p className="px-3 pb-1 text-[10px] uppercase tracking-wider text-gray-500">
                      {group.label}
                    </p>
                  )}
                  {group.items.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.to === '/'}
                      className={sidebarLink}
                    >
                      {item.label}
                    </NavLink>
                  ))}
                </div>
              ))}
            </nav>
            {user && (
              <button
                type="button"
                onClick={() => signOut()}
                title={`Signed in as ${user.username}. Click to sign out.`}
                aria-label={`Sign out ${user.username}`}
                className="m-2 flex items-center justify-between gap-2 rounded px-3 py-2 text-xs text-gray-400 transition hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span className="max-w-[8rem] truncate">{user.username}</span>
                <span className="rounded border border-white/10 px-2 py-0.5">Sign out</span>
              </button>
            )}
          </aside>

          {/* Header + page */}
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex items-center gap-3 border-b border-white/10 bg-surface px-4 py-2 md:px-6">
              <h1 className="text-lg font-bold tracking-wide text-accent md:hidden">AudioServer</h1>
              <SearchBar />
            </header>

            <main className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
              <Outlet />
            </main>
          </div>
        </div>

        <NowPlayingBar
          onExpandClick={() => setFullscreen('upnext')}
          onLyricsClick={() => setFullscreen('lyrics')}
        />

        {/* Tab bar (phone). Home, Search, Albums and Queue are one thumb tap
            away; everything else opens as a sheet from "More". */}
        <nav
          aria-label="Sections"
          className="safe-bottom flex items-stretch border-t border-white/10 bg-surface md:hidden"
        >
          {TABS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[10px] transition ${
                  isActive ? 'text-accent' : 'text-gray-400'
                }`
              }
            >
              <span aria-hidden="true" className="text-base leading-none">
                {item.tab!.icon}
              </span>
              {item.label}
            </NavLink>
          ))}
          <button
            ref={moreRef}
            type="button"
            onClick={() => setMoreOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            className="flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[10px] text-gray-400"
          >
            <span aria-hidden="true" className="text-base leading-none">
              &#8943;
            </span>
            More
          </button>
        </nav>

        {/* The rest of the sections. A menu item is a button, so it navigates
            rather than wrapping a link inside itself. */}
        <Menu open={moreOpen} onClose={() => setMoreOpen(false)} anchorRef={moreRef} label="More">
          {MORE_ITEMS.map((item) => (
            <MenuItem
              key={item.to}
              onSelect={() => navigate(item.to)}
              onClose={() => setMoreOpen(false)}
            >
              {item.label}
            </MenuItem>
          ))}
          {user && (
            <>
              <MenuSeparator />
              <MenuItem onSelect={() => signOut()} onClose={() => setMoreOpen(false)}>
                Sign out ({user.username})
              </MenuItem>
            </>
          )}
        </Menu>

        <KeyboardShortcuts />
        {showFullscreen && (
          <Suspense fallback={null}>
            <NowPlayingFull
              initialView={fullscreen === 'lyrics' ? 'lyrics' : 'upnext'}
              onClose={() => setFullscreen(false)}
            />
          </Suspense>
        )}
      </div>
    </AudioProvider>
  );
}
