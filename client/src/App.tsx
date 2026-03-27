import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout.js';
import ArtistsPage from './pages/ArtistsPage.js';
import AlbumPage from './pages/AlbumPage.js';
import AlbumsPage from './pages/AlbumsPage.js';
import SearchPage from './pages/SearchPage.js';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<AlbumsPage />} />
        <Route path="/artists" element={<ArtistsPage />} />
        <Route path="/albums" element={<AlbumsPage />} />
        <Route path="/albums/:id" element={<AlbumPage />} />
        <Route path="/search" element={<SearchPage />} />
      </Route>
    </Routes>
  );
}
