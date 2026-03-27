import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';

interface Album {
  id: string;
  title: string;
  artistName: string;
  year?: number;
  trackCount?: number;
}

export default function AlbumsPage() {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [scanInfo, setScanInfo] = useState('');

  const loadAlbums = () => {
    api.getAlbums().then((res) => {
      setAlbums(res.data);
      setLoading(false);
    });
  };

  useEffect(() => {
    loadAlbums();
  }, []);

  const startScan = async () => {
    setScanning(true);
    await api.scanLibrary();
    // Poll scan status
    const interval = setInterval(async () => {
      const res = await api.getScanStatus();
      const s = res.data;
      setScanInfo(`${s.processedFiles} files | ${s.artists} artists | ${s.albums} albums | ${s.tracks} tracks`);
      if (!s.isScanning) {
        clearInterval(interval);
        setScanning(false);
        setScanInfo('');
        loadAlbums();
      }
    }, 2000);
  };

  if (loading) return <p className="text-gray-400">Loading albums...</p>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">
          Albums <span className="text-sm font-normal text-gray-500">({albums.length})</span>
        </h2>
        <div className="flex items-center gap-3">
          {scanning && <span className="text-xs text-gray-400 animate-pulse">{scanInfo}</span>}
          <button
            onClick={startScan}
            disabled={scanning}
            className="px-3 py-1 text-sm bg-surface-light border border-white/10 rounded hover:border-accent transition disabled:opacity-50"
          >
            {scanning ? 'Scanning...' : 'Scan Library'}
          </button>
        </div>
      </div>

      {albums.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-gray-400 mb-4">No albums found in your library.</p>
          <button
            onClick={startScan}
            className="px-4 py-2 bg-accent rounded hover:bg-accent-hover transition"
          >
            Scan Library
          </button>
        </div>
      ) : (
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
                    (e.target as HTMLImageElement).parentElement!.classList.add('flex', 'items-center', 'justify-center');
                    const span = document.createElement('span');
                    span.className = 'text-4xl text-gray-600';
                    span.textContent = '\u266A';
                    (e.target as HTMLImageElement).parentElement!.appendChild(span);
                  }}
                />
              </div>
              <p className="text-sm font-medium truncate group-hover:text-accent transition">{album.title}</p>
              <p className="text-xs text-gray-400 truncate">{album.artistName}</p>
              {album.year && <p className="text-xs text-gray-500">{album.year}</p>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
