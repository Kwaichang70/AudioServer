import { Outlet, NavLink } from 'react-router-dom';
import NowPlayingBar from './NowPlayingBar.js';
import { AudioProvider } from '../context/AudioContext.js';

const navItems = [
  { to: '/albums', label: 'Albums' },
  { to: '/artists', label: 'Artists' },
  { to: '/search', label: 'Search' },
];

export default function Layout() {
  return (
    <AudioProvider>
      <div className="flex flex-col h-screen bg-surface-dark">
        {/* Top nav */}
        <header className="flex items-center gap-6 px-6 py-3 bg-surface border-b border-white/10">
          <h1 className="text-xl font-bold text-accent tracking-wide">AudioServer</h1>
          <nav className="flex gap-4">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
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
        </header>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>

        {/* Bottom: Now Playing bar */}
        <NowPlayingBar />
      </div>
    </AudioProvider>
  );
}
