import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout.js';
import LoginPage from './pages/LoginPage.js';
import ErrorBoundary from './components/ErrorBoundary.js';
import { useAuth } from './context/AuthContext.js';

// Lazy-loaded pages (code splitting)
const HomePage = lazy(() => import('./pages/HomePage.js'));
const ArtistsPage = lazy(() => import('./pages/ArtistsPage.js'));
const ArtistPage = lazy(() => import('./pages/ArtistPage.js'));
const AlbumPage = lazy(() => import('./pages/AlbumPage.js'));
const AlbumsPage = lazy(() => import('./pages/AlbumsPage.js'));
const SearchPage = lazy(() => import('./pages/SearchPage.js'));
const PlaylistsPage = lazy(() => import('./pages/PlaylistsPage.js'));
const PlaylistPage = lazy(() => import('./pages/PlaylistPage.js'));
const FavoritesPage = lazy(() => import('./pages/FavoritesPage.js'));
const HistoryPage = lazy(() => import('./pages/HistoryPage.js'));
const StatsPage = lazy(() => import('./pages/StatsPage.js'));
const DiscoverPage = lazy(() => import('./pages/DiscoverPage.js'));
const GenresPage = lazy(() => import('./pages/GenresPage.js'));
const RadioPage = lazy(() => import('./pages/RadioPage.js'));
const SmartPlaylistsPage = lazy(() => import('./pages/SmartPlaylistsPage.js'));
const QueuePage = lazy(() => import('./pages/QueuePage.js'));
const SettingsPage = lazy(() => import('./pages/SettingsPage.js'));
const OAuthCallbackPage = lazy(() => import('./pages/OAuthCallbackPage.js'));

function PageLoader() {
  return <div className="flex items-center justify-center py-20 text-gray-400">Loading...</div>;
}

export default function App() {
  // Auth state comes from the server (/auth/setup-status + /auth/me), see
  // AuthContext. A stale token in localStorage never keeps the app "open".
  const { status, signIn } = useAuth();

  if (status === 'loading') {
    return (
      <div className="min-h-screen bg-surface-dark flex items-center justify-center text-gray-400">
        Loading...
      </div>
    );
  }

  if (status === 'setup') {
    return <LoginPage mode="setup" onAuth={signIn} />;
  }

  if (status === 'anonymous') {
    return <LoginPage mode="login" onAuth={signIn} />;
  }

  return (
    <ErrorBoundary>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/artists" element={<ArtistsPage />} />
            <Route path="/artists/:id" element={<ArtistPage />} />
            <Route path="/albums" element={<AlbumsPage />} />
            <Route path="/albums/:id" element={<AlbumPage />} />
            <Route path="/favorites" element={<FavoritesPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/stats" element={<StatsPage />} />
            <Route path="/discover" element={<DiscoverPage />} />
            <Route path="/genres" element={<GenresPage />} />
            <Route path="/genres/:genre" element={<GenresPage />} />
            <Route path="/radio" element={<RadioPage />} />
            <Route path="/smart-playlists" element={<SmartPlaylistsPage />} />
            <Route path="/smart-playlists/:id" element={<SmartPlaylistsPage />} />
            <Route path="/playlists" element={<PlaylistsPage />} />
            <Route path="/playlists/:id" element={<PlaylistPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/queue" element={<QueuePage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          <Route path="/settings/callback/:provider" element={<OAuthCallbackPage />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
