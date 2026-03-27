import { useState, useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout.js';
import HomePage from './pages/HomePage.js';
import ArtistsPage from './pages/ArtistsPage.js';
import ArtistPage from './pages/ArtistPage.js';
import AlbumPage from './pages/AlbumPage.js';
import AlbumsPage from './pages/AlbumsPage.js';
import SearchPage from './pages/SearchPage.js';
import PlaylistsPage from './pages/PlaylistsPage.js';
import PlaylistPage from './pages/PlaylistPage.js';
import LoginPage from './pages/LoginPage.js';
import { api } from './api/client.js';

export default function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [needsAuth, setNeedsAuth] = useState(false);

  useEffect(() => {
    // Check if auth is required (server returns 401 if users exist and no token)
    api.getStats()
      .then(() => {
        setAuthChecked(true);
        setNeedsAuth(false);
      })
      .catch((err) => {
        if (err.message?.includes('Unauthorized') || err.message?.includes('401')) {
          // Check for stored token
          const token = localStorage.getItem('audioserver_token');
          if (token) {
            setAuthChecked(true);
            setNeedsAuth(false);
          } else {
            setNeedsAuth(true);
            setAuthChecked(true);
          }
        } else {
          // Server error or no auth required
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
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/artists" element={<ArtistsPage />} />
        <Route path="/artists/:id" element={<ArtistPage />} />
        <Route path="/albums" element={<AlbumsPage />} />
        <Route path="/albums/:id" element={<AlbumPage />} />
        <Route path="/playlists" element={<PlaylistsPage />} />
        <Route path="/playlists/:id" element={<PlaylistPage />} />
        <Route path="/search" element={<SearchPage />} />
      </Route>
    </Routes>
  );
}
