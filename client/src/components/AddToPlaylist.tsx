import { useEffect, useState, useRef } from 'react';
import { api } from '../api/client.js';

interface Playlist {
  id: string;
  name: string;
}

interface Props {
  trackId: string;
}

export default function AddToPlaylist({ trackId }: Props) {
  const [open, setOpen] = useState(false);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [added, setAdded] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && playlists.length === 0) {
      api.getPlaylists().then((res) => setPlaylists(res.data));
    }
  }, [open]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleAdd = async (playlistId: string, playlistName: string) => {
    await api.addToPlaylist(playlistId, trackId);
    setAdded(playlistName);
    setTimeout(() => { setAdded(''); setOpen(false); }, 1000);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className="text-gray-600 hover:text-accent transition text-sm px-1"
        title="Add to playlist"
      >
        +
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-48 bg-surface border border-white/10 rounded-lg shadow-xl z-50 py-1">
          {added ? (
            <p className="px-3 py-2 text-xs text-accent">Added to {added}</p>
          ) : playlists.length === 0 ? (
            <p className="px-3 py-2 text-xs text-gray-500">No playlists yet</p>
          ) : (
            playlists.map((pl) => (
              <button
                key={pl.id}
                onClick={(e) => { e.stopPropagation(); handleAdd(pl.id, pl.name); }}
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-surface-light transition"
              >
                {pl.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
