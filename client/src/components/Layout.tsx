import { useState } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import NowPlayingBar from './NowPlayingBar.js';
import { AudioProvider } from '../context/AudioContext.js';

const navItems = [
  { to: '/', label: 'Home' },
  { to: '/albums', label: 'Albums' },
  { to: '/artists', label: 'Artists' },
  { to: '/favorites', label: 'Favorites' },
  { to: '/history', label: 'History' },
  { to: '/playlists', label: 'Playlists' },
  { to: '/search', label: 'Search' },
  { to: '/settings', label: 'Settings' },
];

export default function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <AudioProvider>
      <div className="flex flex-col h-screen bg-surface-dark">
        {/* Top nav */}
        <header className="flex items-center justify-between px-4 md:px-6 py-3 bg-surface border-b border-white/10">
          <div className="flex items-center gap-6">
            <h1 className="text-xl font-bold text-accent tracking-wide">AudioServer</h1>
            <nav className="hidden md:flex gap-1">
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

          {/* Mobile hamburger */}
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="md:hidden text-gray-400 hover:text-white text-xl"
          >
            {menuOpen ? '\u2715' : '\u2630'}
          </button>
        </header>

        {/* Mobile menu */}
        {menuOpen && (
          <nav className="md:hidden bg-surface border-b border-white/10 px-4 py-2 flex flex-wrap gap-2">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                onClick={() => setMenuOpen(false)}
                className={({ isActive }) =>
                  `px-3 py-1.5 rounded text-sm transition ${
                    isActive ? 'bg-accent text-white' : 'text-gray-400 hover:text-white'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        )}

        {/* Main content */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          <Outlet />
        </main>

        {/* Bottom: Now Playing bar */}
        <NowPlayingBar />
      </div>
    </AudioProvider>
  );
}
