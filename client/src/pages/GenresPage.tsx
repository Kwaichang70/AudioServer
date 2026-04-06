import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import AlbumCover from '../components/AlbumCover.js';

interface Genre {
  genre: string;
  albumCount: number;
  trackCount: number;
}

interface Album {
  id: string;
  title: string;
  artistName: string;
  year?: number;
}

const genreColors = [
  'from-violet-800/50 to-indigo-900/50',
  'from-rose-800/50 to-pink-900/50',
  'from-emerald-800/50 to-teal-900/50',
  'from-amber-800/50 to-orange-900/50',
  'from-sky-800/50 to-cyan-900/50',
  'from-fuchsia-800/50 to-purple-900/50',
  'from-red-800/50 to-rose-900/50',
  'from-blue-800/50 to-indigo-900/50',
];

function getGenreColor(genre: string): string {
  let hash = 0;
  for (let i = 0; i < genre.length; i++) hash = ((hash << 5) - hash + genre.charCodeAt(i)) | 0;
  return genreColors[Math.abs(hash) % genreColors.length];
}

export default function GenresPage() {
  const { genre } = useParams<{ genre?: string }>();

  if (genre) return <GenreDetail genre={decodeURIComponent(genre)} />;
  return <GenreList />;
}

function GenreList() {
  const [genres, setGenres] = useState<Genre[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getGenres().then((res) => setGenres(res.data)).catch(() => {}).finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-gray-400">Loading genres...</p>;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">
        Genres <span className="text-sm font-normal text-gray-500">({genres.length})</span>
      </h2>

      {genres.length === 0 ? (
        <p className="text-gray-500 text-center py-12">No genres found. Scan your library to populate genre tags.</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {genres.map((g) => (
            <Link
              key={g.genre}
              to={`/genres/${encodeURIComponent(g.genre)}`}
              className={`bg-gradient-to-br ${getGenreColor(g.genre)} rounded-lg p-4 hover:scale-[1.02] transition group`}
            >
              <p className="text-lg font-bold group-hover:text-accent transition">{g.genre}</p>
              <p className="text-xs text-gray-400 mt-1">
                {g.albumCount} albums &middot; {g.trackCount} tracks
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function GenreDetail({ genre }: { genre: string }) {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getGenreAlbums(genre).then((res) => setAlbums(res.data)).catch(() => {}).finally(() => setLoading(false));
  }, [genre]);

  if (loading) return <p className="text-gray-400">Loading...</p>;

  return (
    <div>
      <Link to="/genres" className="text-sm text-gray-400 hover:text-accent transition">&larr; All Genres</Link>
      <h2 className="text-2xl font-bold mt-2 mb-6">
        {genre} <span className="text-sm font-normal text-gray-500">({albums.length} albums)</span>
      </h2>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
        {albums.map((album) => (
          <Link
            key={album.id}
            to={`/albums/${album.id}`}
            className="group bg-surface-light rounded-lg p-3 hover:bg-surface transition"
          >
            <div className="mb-2">
              <AlbumCover albumId={album.id} title={album.title} artistName={album.artistName} />
            </div>
            <p className="text-sm font-medium truncate group-hover:text-accent transition">{album.title}</p>
            <p className="text-xs text-gray-400 truncate">{album.artistName}</p>
            {album.year && <p className="text-xs text-gray-500">{album.year}</p>}
          </Link>
        ))}
      </div>
    </div>
  );
}
