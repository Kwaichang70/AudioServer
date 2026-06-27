import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api/client.js';

interface Artist {
  id: string;
  name: string;
}

interface Album {
  id: string;
  title: string;
  artistName: string;
  year?: number;
  trackCount?: number;
}

interface SimilarArtist {
  name: string;
  match: number;
  localArtistId: string | null;
}

export default function ArtistPage() {
  const { id } = useParams<{ id: string }>();
  const [artist, setArtist] = useState<Artist | null>(null);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [similar, setSimilar] = useState<SimilarArtist[]>([]);

  useEffect(() => {
    if (!id) return;
    setSimilar([]);
    api.getArtist(id).then((res) => setArtist(res.data));
    api.getArtistAlbums(id).then((res) => setAlbums(res.data));
    api
      .getSimilarArtists(id)
      .then((res) => setSimilar(res.data?.similar ?? []))
      .catch(() => setSimilar([]));
  }, [id]);

  if (!artist) return <p className="text-gray-400">Loading...</p>;

  return (
    <div>
      <div className="mb-8">
        <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">Artist</p>
        <h2 className="text-3xl font-bold">{artist.name}</h2>
        <p className="text-sm text-gray-500 mt-1">{albums.length} albums</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
        {albums.map((album) => (
          <Link
            key={album.id}
            to={`/albums/${album.id}`}
            className="group bg-surface-light rounded-lg p-3 hover:bg-surface transition"
          >
            <div className="aspect-square bg-surface-dark rounded mb-2 overflow-hidden">
              <img
                src={api.getAlbumCoverUrl(album.id)}
                alt={album.title}
                className="w-full h-full object-cover"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            </div>
            <p className="text-sm font-medium truncate group-hover:text-accent transition">
              {album.title}
            </p>
            {album.year && <p className="text-xs text-gray-500">{album.year}</p>}
            {album.trackCount && <p className="text-xs text-gray-500">{album.trackCount} tracks</p>}
          </Link>
        ))}
      </div>

      {similar.length > 0 && (
        <div className="mt-10">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-3">
            Listeners also like
          </h3>
          <div className="flex flex-wrap gap-2">
            {similar.map((s) => (
              <Link
                key={s.name}
                to={
                  s.localArtistId
                    ? `/artists/${s.localArtistId}`
                    : `/search?q=${encodeURIComponent(s.name)}`
                }
                className={`px-3 py-1.5 rounded-full text-sm border transition ${
                  s.localArtistId
                    ? 'border-accent/40 text-accent hover:bg-accent/10'
                    : 'border-white/10 text-gray-300 hover:bg-surface-light'
                }`}
                title={s.localArtistId ? 'In your library' : 'Search across your sources'}
              >
                {s.name}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
