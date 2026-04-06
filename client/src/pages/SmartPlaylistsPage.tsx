import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAudioContext } from '../context/AudioContext.js';
import { formatDuration } from '../utils/format.js';
import { useToast } from '../components/Toast.js';

interface Rule {
  field: string;
  operator: string;
  value: string;
  value2?: string;
}

interface SmartPlaylist {
  id: string;
  name: string;
  rules: string;
  trackCount: number;
}

interface Track {
  id: string;
  title: string;
  artistName: string;
  albumTitle: string;
  albumId?: string;
  duration?: number;
  format?: string;
}

const FIELDS = [
  { value: 'genre', label: 'Genre' },
  { value: 'year', label: 'Year' },
  { value: 'format', label: 'Format' },
  { value: 'sampleRate', label: 'Sample Rate' },
  { value: 'bitDepth', label: 'Bit Depth' },
  { value: 'artistName', label: 'Artist' },
];

const OPERATORS: Record<string, { value: string; label: string }[]> = {
  genre: [{ value: 'equals', label: 'is' }, { value: 'contains', label: 'contains' }],
  year: [{ value: 'equals', label: 'is' }, { value: 'greaterThan', label: 'after' }, { value: 'lessThan', label: 'before' }, { value: 'between', label: 'between' }],
  format: [{ value: 'equals', label: 'is' }, { value: 'contains', label: 'contains' }],
  sampleRate: [{ value: 'equals', label: 'is' }, { value: 'greaterThan', label: '>' }, { value: 'lessThan', label: '<' }],
  bitDepth: [{ value: 'equals', label: 'is' }, { value: 'greaterThan', label: '>' }],
  artistName: [{ value: 'equals', label: 'is' }, { value: 'contains', label: 'contains' }],
};

export default function SmartPlaylistsPage() {
  const { id } = useParams<{ id?: string }>();
  if (id) return <SmartPlaylistDetail id={id} />;
  return <SmartPlaylistList />;
}

function SmartPlaylistList() {
  const [playlists, setPlaylists] = useState<SmartPlaylist[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [rules, setRules] = useState<Rule[]>([{ field: 'genre', operator: 'equals', value: '' }]);
  const { toast } = useToast();

  const load = () => {
    api.getSmartPlaylists().then((res) => setPlaylists(res.data)).catch(() => {}).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!newName.trim() || rules.some((r) => !r.value)) {
      toast('Fill in all fields', 'error');
      return;
    }
    await api.createSmartPlaylist(newName.trim(), rules);
    setNewName('');
    setRules([{ field: 'genre', operator: 'equals', value: '' }]);
    setShowCreate(false);
    load();
  };

  const handleDelete = async (id: string) => {
    await api.deleteSmartPlaylist(id);
    load();
  };

  const updateRule = (index: number, updates: Partial<Rule>) => {
    setRules((prev) => prev.map((r, i) => i === index ? { ...r, ...updates } : r));
  };

  if (loading) return <p className="text-gray-400">Loading...</p>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">
          Smart Playlists <span className="text-sm font-normal text-gray-500">({playlists.length})</span>
        </h2>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-3 py-1 text-sm bg-accent rounded hover:bg-accent-hover transition"
        >
          + New Smart Playlist
        </button>
      </div>

      {showCreate && (
        <div className="bg-surface-light rounded-lg p-4 mb-6 space-y-3">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Smart playlist name..."
            className="w-full px-4 py-2 bg-surface-dark border border-white/10 rounded text-white placeholder-gray-500 focus:outline-none focus:border-accent"
          />

          <p className="text-xs text-gray-400 uppercase tracking-wider">Rules</p>
          {rules.map((rule, i) => (
            <div key={i} className="flex gap-2 items-center flex-wrap">
              <select
                value={rule.field}
                onChange={(e) => updateRule(i, { field: e.target.value, operator: OPERATORS[e.target.value]?.[0]?.value || 'equals' })}
                className="px-3 py-1.5 bg-surface-dark border border-white/10 rounded text-sm text-white"
              >
                {FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
              <select
                value={rule.operator}
                onChange={(e) => updateRule(i, { operator: e.target.value })}
                className="px-3 py-1.5 bg-surface-dark border border-white/10 rounded text-sm text-white"
              >
                {(OPERATORS[rule.field] || []).map((op) => (
                  <option key={op.value} value={op.value}>{op.label}</option>
                ))}
              </select>
              <input
                type="text"
                value={rule.value}
                onChange={(e) => updateRule(i, { value: e.target.value })}
                placeholder="Value..."
                className="flex-1 min-w-[120px] px-3 py-1.5 bg-surface-dark border border-white/10 rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-accent"
              />
              {rule.operator === 'between' && (
                <input
                  type="text"
                  value={rule.value2 || ''}
                  onChange={(e) => updateRule(i, { value2: e.target.value })}
                  placeholder="To..."
                  className="w-24 px-3 py-1.5 bg-surface-dark border border-white/10 rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-accent"
                />
              )}
              {rules.length > 1 && (
                <button
                  onClick={() => setRules((prev) => prev.filter((_, j) => j !== i))}
                  className="text-gray-500 hover:text-red-400 text-sm"
                >
                  &times;
                </button>
              )}
            </div>
          ))}

          <div className="flex gap-2">
            <button
              onClick={() => setRules([...rules, { field: 'genre', operator: 'equals', value: '' }])}
              className="text-xs text-gray-400 hover:text-accent transition"
            >
              + Add rule
            </button>
          </div>

          <div className="flex gap-2 pt-2">
            <button onClick={handleCreate} className="px-4 py-2 bg-accent rounded hover:bg-accent-hover transition text-sm">
              Create
            </button>
            <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-gray-400 hover:text-white transition text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}

      {playlists.length === 0 && !showCreate ? (
        <p className="text-gray-500 text-center py-12">No smart playlists yet. Create one based on genre, year, format, or artist rules.</p>
      ) : (
        <div className="space-y-1">
          {playlists.map((pl) => (
            <div key={pl.id} className="flex items-center gap-4 px-4 py-3 rounded-lg hover:bg-surface-light transition group">
              <Link to={`/smart-playlists/${pl.id}`} className="flex-1 min-w-0">
                <p className="text-sm font-medium group-hover:text-accent transition">{pl.name}</p>
                <p className="text-xs text-gray-500">{pl.trackCount || 0} tracks (auto-generated)</p>
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

function SmartPlaylistDetail({ id }: { id: string }) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const { playTrack, playAlbum, currentTrack, isPlaying } = useAudioContext();

  useEffect(() => {
    api.getSmartPlaylistTracks(id).then((res) => setTracks(res.data)).catch(() => {}).finally(() => setLoading(false));
    api.getSmartPlaylists().then((res) => {
      const sp = res.data.find((p: SmartPlaylist) => p.id === id);
      if (sp) setName(sp.name);
    }).catch(() => {});
  }, [id]);

  if (loading) return <p className="text-gray-400">Loading...</p>;

  return (
    <div>
      <Link to="/smart-playlists" className="text-sm text-gray-400 hover:text-accent transition">&larr; Smart Playlists</Link>
      <div className="mt-2 mb-8">
        <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">Smart Playlist</p>
        <h2 className="text-3xl font-bold mb-2">{name}</h2>
        <p className="text-sm text-gray-500">{tracks.length} tracks (auto-generated from rules)</p>
        {tracks.length > 0 && (
          <button
            onClick={() => playAlbum(tracks)}
            className="mt-4 px-6 py-2 bg-accent rounded-full hover:bg-accent-hover transition text-sm font-medium"
          >
            Play All
          </button>
        )}
      </div>

      {tracks.length === 0 ? (
        <p className="text-gray-500 text-center py-8">No tracks match the rules.</p>
      ) : (
        <div className="space-y-0.5">
          {tracks.map((track, i) => {
            const isCurrent = currentTrack?.id === track.id;
            return (
              <button
                key={`${track.id}-${i}`}
                onClick={() => playTrack(track)}
                className={`w-full flex items-center gap-4 px-4 py-2 rounded hover:bg-surface-light transition text-left ${isCurrent ? 'text-accent' : ''}`}
              >
                <span className="w-6 text-sm text-gray-500 text-right shrink-0">
                  {isCurrent && isPlaying ? <span className="animate-pulse">&#9654;</span> : i + 1}
                </span>
                <div className="w-8 h-8 rounded bg-surface-dark overflow-hidden shrink-0">
                  {track.albumId && (
                    <img
                      src={api.getAlbumCoverUrl(track.albumId)}
                      alt=""
                      className="w-full h-full object-cover"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{track.title}</p>
                  <p className="text-xs text-gray-500 truncate">{track.artistName} &middot; {track.albumTitle}</p>
                </div>
                {track.format && <span className="text-[10px] text-gray-600 shrink-0">{track.format}</span>}
                <span className="text-sm text-gray-400 shrink-0">{formatDuration(track.duration)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
