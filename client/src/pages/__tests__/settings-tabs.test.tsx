import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ isAdmin: true }));

vi.mock('../../context/AuthContext.js', () => ({ useAuth: () => ({ isAdmin: mocks.isAdmin }) }));

// Each section is covered by its own behaviour elsewhere; here only the shell
// is under test, so they are stand-ins.
const stub = (name: string) => ({ default: () => <div data-testid={name} /> });
vi.mock('../../components/AudioPathPanel.js', () => stub('audio-path'));
vi.mock('../../components/ZonesSection.js', () => stub('rooms'));
vi.mock('../settings/PlaybackSection.js', () => stub('playback'));
vi.mock('../settings/LibrarySection.js', () => stub('library'));
vi.mock('../settings/ProvidersSection.js', () => stub('providers'));
vi.mock('../settings/LibrespotSection.js', () => stub('librespot'));
vi.mock('../settings/ScrobblingSection.js', () => stub('scrobbling'));
vi.mock('../settings/SecuritySection.js', () => stub('account'));
vi.mock('../settings/ThemeSection.js', () => stub('appearance'));
vi.mock('../settings/UsersSection.js', () => stub('users'));
vi.mock('../settings/AboutSection.js', () => stub('about'));
vi.mock('../../components/TranscodeTrial.js', () => stub('transcode-trial'));
vi.mock('../settings/ApiKeysSection.js', () => stub('api-keys'));

const { default: SettingsPage } = await import('../SettingsPage.js');

function renderSettings(path = '/settings') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsPage />
    </MemoryRouter>,
  );
}

/**
 * R02.4: one file of 1400 lines and one long scroll became a section per file
 * behind tabs. What matters here is the shell: which tabs exist for whom, that
 * one panel shows at a time, and that `?tab=` makes a section linkable.
 */
describe('Settings tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAdmin = true;
  });

  it('opens on playback and shows only that section', () => {
    renderSettings();

    expect(screen.getByTestId('playback')).toBeInTheDocument();
    expect(screen.getByTestId('audio-path')).toBeInTheDocument();
    expect(screen.queryByTestId('library')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Playback' })).toHaveAttribute('aria-selected', 'true');
  });

  it('switches section on a tab click', () => {
    renderSettings();

    fireEvent.click(screen.getByRole('tab', { name: 'Library' }));

    expect(screen.getByTestId('library')).toBeInTheDocument();
    expect(screen.queryByTestId('playback')).not.toBeInTheDocument();
  });

  it('opens the section named in the address, so it can be linked', () => {
    renderSettings('/settings?tab=scrobbling');

    expect(screen.getByTestId('scrobbling')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Scrobbling' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('falls back to the first section for an unknown tab', () => {
    renderSettings('/settings?tab=nonsense');

    expect(screen.getByTestId('playback')).toBeInTheDocument();
  });

  it('hides admin sections from a regular user and says who manages them', () => {
    mocks.isAdmin = false;
    renderSettings();

    for (const label of ['Library', 'Streaming', 'Users', 'Rooms', 'Scrobbling']) {
      expect(screen.queryByRole('tab', { name: label })).not.toBeInTheDocument();
    }
    expect(screen.getByRole('tab', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByText(/managed by an administrator/)).toBeInTheDocument();
  });

  it('keeps an admin-only section out of reach through the address too', () => {
    mocks.isAdmin = false;
    renderSettings('/settings?tab=users');

    expect(screen.queryByTestId('users')).not.toBeInTheDocument();
    expect(screen.getByTestId('playback')).toBeInTheDocument();
  });

  it('wires the panel to its tab for a screen reader', () => {
    renderSettings('/settings?tab=account');
    const tab = screen.getByRole('tab', { name: 'Account' });
    const panel = screen.getByRole('tabpanel');

    expect(panel).toHaveAttribute('aria-labelledby', tab.id);
    expect(tab).toHaveAttribute('aria-controls', panel.id);
  });

  it('moves between tabs with the arrow keys, Home and End (U02)', () => {
    renderSettings();
    const playback = screen.getByRole('tab', { name: 'Playback' });
    expect(playback).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Rooms' })).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(playback, { key: 'ArrowRight' });
    const rooms = screen.getByRole('tab', { name: 'Rooms' });
    expect(rooms).toHaveAttribute('aria-selected', 'true');
    expect(rooms).toHaveFocus();
    expect(screen.getByTestId('rooms')).toBeInTheDocument();

    fireEvent.keyDown(rooms, { key: 'ArrowUp' });
    expect(screen.getByRole('tab', { name: 'Playback' })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Playback' }), { key: 'End' });
    const tabs = screen.getAllByRole('tab');
    expect(tabs[tabs.length - 1]).toHaveFocus();
    expect(tabs[tabs.length - 1]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(tabs[tabs.length - 1], { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'Playback' })).toHaveFocus();
  });
});
