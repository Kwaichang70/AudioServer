import { useState, useEffect, lazy, Suspense } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import NowPlayingBar from './NowPlayingBar.js';
import { AudioProvider } from '../context/AudioContext.js';
import { KeyboardShortcuts } from './KeyboardShortcuts.js';
import { useAuth } from '../context/AuthContext.js';
import AppStatusBanners from './AppStatusBanners.js';

const NowPlayingFull = lazy(() => import('./NowPlayingFull.js'));

const navItems = [
  { to: '/', label: 'Home' },
  { to: '/queue', label: 'Queue' },
  { to: '/albums', label: 'Albums' },
  { to: '/artists', label: 'Artists' },
  { to: '/genres', label: 'Genres' },
  { to: '/radio', label: 'Radio' },
  { to: '/favorites', label: 'Favorites' },
  { to: '/history', label: 'History' },
  { to: '/stats', label: 'Stats' },
  { to: '/discover', label: 'Discover' },
  { to: '/playlists', label: 'Playlists' },
  { to: '/smart-playlists', label: 'Smart' },
  { to: '/search', label: 'Search' },
  { to: '/settings', label: 'Settings' },
];

export default function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [showFullscreen, setShowFullscreen] = useState(false);
  const { user, signOut } = useAuth();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showFullscreen) setShowFullscreen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showFullscreen]);

  return (
    <AudioProvider>
      <div className="flex flex-col h-screen bg-surface-dark">
        <AppStatusBanners />
        {/* Top nav */}
        <header className="flex items-center justify-between px-4 md:px-6 py-3 bg-surface border-b border-white/10">
          <div className="flex items-center gap-6">
            <h1 className="text-xl font-bold text-accent tracking-wide">AudioServer</h1>
            <nav className="hidden md:flex gap-1" aria-label="Main">
              {navItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) =>
                    `px-3 py-1 rounded text-sm transition ${
                      isActive ? 'bg-accent text-white' : 'text-gray-400 hover:text-white'
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-3">
            {user && (
              <button
                type="button"
                onClick={() => signOut()}
                title={`Signed in as ${user.username}. Click to sign out.`}
                aria-label={`Sign out ${user.username}`}
                className="hidden md:inline-flex items-center gap-2 min-h-[44px] text-xs text-gray-400 hover:text-white transition rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span className="max-w-[10rem] truncate">{user.username}</span>
                <span className="px-2 py-0.5 rounded border border-white/10">Sign out</span>
              </button>
            )}
            {/* Mobile hamburger */}
            <button
              type="button"
              onClick={() => setMenuOpen(!menuOpen)}
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              aria-controls="mobile-menu"
              className="md:hidden min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-gray-400 hover:text-white text-xl rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span aria-hidden="true">{menuOpen ? '\u2715' : '\u2630'}</span>
            </button>
          </div>
        </header>

        {/* Mobile menu */}
        {menuOpen && (
          <nav
            id="mobile-menu"
            aria-label="Main"
            className="md:hidden bg-surface border-b border-white/10 px-4 py-2 flex flex-wrap gap-2"
          >
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                onClick={() => setMenuOpen(false)}
                className={({ isActive }) =>
                  `inline-flex items-center min-h-[44px] px-3 py-1.5 rounded text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                    isActive ? 'bg-accent text-white' : 'text-gray-400 hover:text-white'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
            {user && (
              <button
                type="button"
                onClick={() => signOut()}
                className="inline-flex items-center min-h-[44px] px-3 py-1 rounded text-sm text-gray-400 hover:text-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Sign out ({user.username})
              </button>
            )}
          </nav>
        )}

        {/* Main content */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          <Outlet />
        </main>

        {/* Bottom: Now Playing bar */}
        <NowPlayingBar onExpandClick={() => setShowFullscreen(true)} />
        <KeyboardShortcuts />
        {showFullscreen && (
          <Suspense fallback={null}>
            <NowPlayingFull onClose={() => setShowFullscreen(false)} />
          </Suspense>
        )}
      </div>
    </AudioProvider>
  );
}
