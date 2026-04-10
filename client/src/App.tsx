import { useState, useEffect, lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout.js';
import LoginPage from './pages/LoginPage.js';
import { api } from './api/client.js';

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
const GenresPage = lazy(() => import('./pages/GenresPage.js'));
const RadioPage = lazy(() => import('./pages/RadioPage.js'));
const SmartPlaylistsPage = lazy(() => import('./pages/SmartPlaylistsPage.js'));
const SettingsPage = lazy(() => import('./pages/SettingsPage.js'));
const OAuthCallbackPage = lazy(() => import('./pages/OAuthCallbackPage.js'));

function PageLoader() {
  return (
    <div className="flex items-center justify-center py-20 text-gray-400">
      Loading...
    </div>
  );
}

export default function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [needsAuth, setNeedsAuth] = useState(false);

  useEffect(() => {
    api.getStats()
      .then(() => {
        setAuthChecked(true);
        setNeedsAuth(false);
      })
      .catch((err) => {
        if (err.message?.includes('Unauthorized') || err.message?.includes('401')) {
          const token = localStorage.getItem('audioserver_token');
          if (token) {
            setAuthChecked(true);
            setNeedsAuth(false);
          } else {
            setNeedsAuth(true);
            setAuthChecked(true);
          }
        } else {
          setAuthChecked(true);
          setNeedsAuth(false);
        }
      });
  }, []);

  const handleAuth = (token: string) => {
    localStorage.setItem('audioserver_token', token);
    setNeedsAuth(false);
  };

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-surface-dark flex items-center justify-center text-gray-400">
        Loading...
      </div>
    );
  }

  if (needsAuth) {
    return <LoginPage onAuth={handleAuth} />;
  }

  return (
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
          <Route path="/genres" element={<GenresPage />} />
          <Route path="/genres/:genre" element={<GenresPage />} />
          <Route path="/radio" element={<RadioPage />} />
          <Route path="/smart-playlists" element={<SmartPlaylistsPage />} />
          <Route path="/smart-playlists/:id" element={<SmartPlaylistsPage />} />
          <Route path="/playlists" element={<PlaylistsPage />} />
          <Route path="/playlists/:id" element={<PlaylistPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="/settings/callback/:provider" element={<OAuthCallbackPage />} />
      </Routes>
    </Suspense>
  );
}
