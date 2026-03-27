import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

interface Artist {
  id: string;
  name: string;
}

export default function ArtistsPage() {
  const [artists, setArtists] = useState<Artist[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getArtists().then((res) => {
      setArtists(res.data);
      setLoading(false);
    });
  }, []);

  if (loading) return <p className="text-gray-400">Loading artists...</p>;

  if (artists.length === 0) {
    return <p className="text-gray-400">No artists found. Scan your library first.</p>;
  }

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Artists</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
        {artists.map((artist) => (
          <div
            key={artist.id}
            className="bg-surface-light rounded-lg p-4 text-center hover:bg-surface transition"
          >
            <div className="w-20 h-20 mx-auto mb-3 rounded-full bg-surface-dark flex items-center justify-center text-2xl text-gray-600">
              ♫
            </div>
            <p className="text-sm font-medium truncate">{artist.name}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
