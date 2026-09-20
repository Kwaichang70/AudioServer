import { useSearchParams } from 'react-router-dom';
import AudioPathPanel from '../components/AudioPathPanel.js';
import ZonesSection from '../components/ZonesSection.js';
import { useAuth } from '../context/AuthContext.js';
import PlaybackSection from './settings/PlaybackSection.js';
import LibrarySection from './settings/LibrarySection.js';
import ProvidersSection from './settings/ProvidersSection.js';
import LibrespotSection from './settings/LibrespotSection.js';
import ScrobblingSection from './settings/ScrobblingSection.js';
import SecuritySection from './settings/SecuritySection.js';
import ThemeSection from './settings/ThemeSection.js';
import UsersSection from './settings/UsersSection.js';
import AboutSection from './settings/AboutSection.js';

/**
 * Settings (R02.4).
 *
 * This page was one file of 1400 lines and one column you scrolled through
 * past everything you were not looking for. It is now a section per file
 * behind a list of tabs; the sections themselves are unchanged, and each one
 * loads its own data instead of sharing one big pile of state. `?tab=` makes
 * a section linkable, so "look under Library" can be a link.
 */

interface Tab {
  id: string;
  label: string;
  admin?: boolean;
  render: () => React.ReactNode;
}

const TABS: Tab[] = [
  {
    id: 'playback',
    label: 'Playback',
    render: () => (
      <>
        <PlaybackSection />
        <AudioPathPanel />
      </>
    ),
  },
  { id: 'rooms', label: 'Rooms', admin: true, render: () => <ZonesSection /> },
  { id: 'library', label: 'Library', admin: true, render: () => <LibrarySection /> },
  {
    id: 'providers',
    label: 'Streaming',
    admin: true,
    render: () => (
      <>
        <ProvidersSection />
        <LibrespotSection />
      </>
    ),
  },
  { id: 'scrobbling', label: 'Scrobbling', admin: true, render: () => <ScrobblingSection /> },
  { id: 'account', label: 'Account', render: () => <SecuritySection /> },
  { id: 'appearance', label: 'Appearance', render: () => <ThemeSection /> },
  { id: 'users', label: 'Users', admin: true, render: () => <UsersSection /> },
  { id: 'about', label: 'About', render: () => <AboutSection /> },
];

export default function SettingsPage() {
  const { isAdmin } = useAuth();
  const [params, setParams] = useSearchParams();
  const tabs = TABS.filter((tab) => isAdmin || !tab.admin);
  const current = tabs.find((tab) => tab.id === params.get('tab')) ?? tabs[0];

  return (
    <div className="mx-auto max-w-4xl md:flex md:gap-8">
      <div className="md:w-44 md:shrink-0">
        <h2 className="mb-4 text-2xl font-bold">Settings</h2>
        {/* A tab list on a desktop; on a phone the same tabs wrap into rows,
            which beats a select nobody can see the options of. */}
        <div
          role="tablist"
          aria-label="Settings sections"
          aria-orientation="vertical"
          className="mb-6 flex flex-wrap gap-1 md:mb-0 md:flex-col"
        >
          {tabs.map((tab) => {
            const active = tab.id === current.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`settings-tab-${tab.id}`}
                aria-selected={active}
                aria-controls="settings-panel"
                onClick={() => setParams(tab.id === tabs[0].id ? {} : { tab: tab.id })}
                className={`rounded px-3 py-1.5 text-left text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  active ? 'bg-accent' : 'text-gray-400 hover:bg-white/10 hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      <div
        id="settings-panel"
        role="tabpanel"
        aria-labelledby={`settings-tab-${current.id}`}
        className="min-w-0 flex-1"
      >
        {current.render()}
        {!isAdmin && (
          <p className="mt-6 rounded-lg bg-surface-light p-4 text-sm text-gray-400">
            Library scans, streaming-provider connections, Librespot, scrobbling targets and user
            accounts are managed by an administrator. See docs/permissions.md for the full matrix.
          </p>
        )}
      </div>
    </div>
  );
}
