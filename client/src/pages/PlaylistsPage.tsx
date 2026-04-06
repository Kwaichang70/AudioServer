import { useEffect, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useToast } from '../components/Toast.js';

interface Playlist {
  id: string;
  name: string;
  description?: string;
  trackCount?: number;
}

export default function PlaylistsPage() {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const load = () => {
    api.getPlaylists().then((res) => { setPlaylists(res.data); setLoading(false); });
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    await api.createPlaylist(newName.trim());
    setNewName('');
    setShowCreate(false);
    load();
  };

  const handleDelete = async (id: string) => {
    await api.deletePlaylist(id);
    load();
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    const name = file.name.replace(/\.(m3u8?|pls)$/i, '');
    try {
      const res = await api.importPlaylist(name, content);
      toast(`Imported "${name}": ${res.meta?.matched || 0} of ${res.meta?.total || 0} tracks matched`, 'success');
      load();
    } catch (err) {
      toast(`Import failed: ${(err as Error).message}`, 'error');
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  if (loading) return <p className="text-gray-400">Loading playlists...</p>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">
          Playlists <span className="text-sm font-normal text-gray-500">({playlists.length})</span>
        </h2>
        <div className="flex gap-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-1 text-sm bg-surface-light border border-white/10 rounded hover:border-accent transition text-gray-400"
          >
            Import M3U
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".m3u,.m3u8"
            onChange={handleImport}
            className="hidden"
          />
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="px-3 py-1 text-sm bg-accent rounded hover:bg-accent-hover transition"
          >
            + New Playlist
          </button>
        </div>
      </div>

      {showCreate && (
        <div className="flex gap-2 mb-6">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            placeholder="Playlist name..."
            className="flex-1 px-4 py-2 bg-surface-light border border-white/10 rounded text-white placeholder-gray-500 focus:outline-none focus:border-accent"
            autoFocus
          />
          <button onClick={handleCreate} className="px-4 py-2 bg-accent rounded hover:bg-accent-hover transition">
            Create
          </button>
          <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-gray-400 hover:text-white transition">
            Cancel
          </button>
        </div>
      )}

      {playlists.length === 0 ? (
        <p className="text-gray-500 text-center py-12">No playlists yet. Create one to get started.</p>
      ) : (
        <div className="space-y-1">
          {playlists.map((pl) => (
            <div key={pl.id} className="flex items-center gap-4 px-4 py-3 rounded-lg hover:bg-surface-light transition group">
              <Link to={`/playlists/${pl.id}`} className="flex-1 min-w-0">
                <p className="text-sm font-medium group-hover:text-accent transition">{pl.name}</p>
                <p className="text-xs text-gray-500">
                  {pl.trackCount || 0} tracks
                  {pl.description && ` \u00B7 ${pl.description}`}
                </p>
              </Link>
              <button
                onClick={() => handleDelete(pl.id)}
                className="text-xs text-gray-600 hover:text-red-400 transition opacity-0 group-hover:opacity-100"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
