import { useCallback, useEffect, useRef, useState } from 'react';
import FavoriteButton from '../components/FavoriteButton.js';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAudioContext } from '../context/AudioContext.js';
import { formatDuration } from '../utils/format.js';
import { useToast } from '../components/Toast.js';
import PlayActions, { openRowMenuFromPointer, toTrackInfo } from '../components/PlayActions.js';
import type { SmartDefinition, SmartPlaylist as StoredSmartPlaylist } from '../api/types.js';
import { SORT_LABELS, activeFilters, type SortKey } from '../utils/focus.js';
import Button from '../components/ui/Button.js';

interface Rule {
  field: string;
  operator: string;
  value: string;
  value2?: string;
}

type SmartPlaylist = Pick<
  StoredSmartPlaylist,
  'id' | 'name' | 'rules' | 'trackCount' | 'definition'
>;

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
  genre: [
    { value: 'equals', label: 'is' },
    { value: 'contains', label: 'contains' },
  ],
  year: [
    { value: 'equals', label: 'is' },
    { value: 'greaterThan', label: 'after' },
    { value: 'lessThan', label: 'before' },
    { value: 'between', label: 'between' },
  ],
  format: [
    { value: 'equals', label: 'is' },
    { value: 'contains', label: 'contains' },
  ],
  sampleRate: [
    { value: 'equals', label: 'is' },
    { value: 'greaterThan', label: '>' },
    { value: 'lessThan', label: '<' },
  ],
  bitDepth: [
    { value: 'equals', label: 'is' },
    { value: 'greaterThan', label: '>' },
  ],
  artistName: [
    { value: 'equals', label: 'is' },
    { value: 'contains', label: 'contains' },
  ],
};

const EMPTY_RULE: Rule = { field: 'genre', operator: 'equals', value: '' };

// ─── Shared rule editor ──────────────────────────────────────────
// Used by both the create-form (in the list page) and the edit-form
// (in the detail page). Extracted so the two flows can't drift apart.

interface RuleEditorProps {
  name: string;
  onNameChange: (name: string) => void;
  rules: Rule[];
  onRulesChange: (rules: Rule[]) => void;
  onSave: () => void | Promise<void>;
  onCancel: () => void;
  saveLabel?: string;
  saving?: boolean;
}

function RuleEditor({
  name,
  onNameChange,
  rules,
  onRulesChange,
  onSave,
  onCancel,
  saveLabel = 'Save',
  saving = false,
}: RuleEditorProps) {
  const updateRule = (index: number, updates: Partial<Rule>) => {
    onRulesChange(rules.map((r, i) => (i === index ? { ...r, ...updates } : r)));
  };

  return (
    <div className="bg-surface-light rounded-lg p-4 space-y-3">
      <input
        type="text"
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        placeholder="Smart playlist name..."
        className="w-full px-4 py-2 bg-surface-dark border border-white/10 rounded text-white placeholder-gray-500 focus:outline-none focus:border-accent"
      />

      <p className="text-xs text-gray-400 uppercase tracking-wider">Rules</p>
      {rules.map((rule, i) => (
        <div key={i} className="flex gap-2 items-center flex-wrap">
          <select
            value={rule.field}
            onChange={(e) =>
              updateRule(i, {
                field: e.target.value,
                operator: OPERATORS[e.target.value]?.[0]?.value || 'equals',
              })
            }
            className="px-3 py-1.5 bg-surface-dark border border-white/10 rounded text-sm text-white"
          >
            {FIELDS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          <select
            value={rule.operator}
            onChange={(e) => updateRule(i, { operator: e.target.value })}
            className="px-3 py-1.5 bg-surface-dark border border-white/10 rounded text-sm text-white"
          >
            {(OPERATORS[rule.field] || []).map((op) => (
              <option key={op.value} value={op.value}>
                {op.label}
              </option>
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
              onClick={() => onRulesChange(rules.filter((_, j) => j !== i))}
              className="text-gray-500 hover:text-red-400 text-sm"
              title="Remove rule"
            >
              &times;
            </button>
          )}
        </div>
      ))}

      <div className="flex gap-2">
        <button
          onClick={() => onRulesChange([...rules, { ...EMPTY_RULE }])}
          className="text-xs text-gray-400 hover:text-accent transition"
        >
          + Add rule
        </button>
      </div>

      <div className="flex gap-2 pt-2">
        <button
          onClick={onSave}
          disabled={saving}
          className="px-4 py-2 bg-accent rounded hover:bg-accent-hover transition text-sm disabled:opacity-50"
        >
          {saving ? 'Saving...' : saveLabel}
        </button>
        <button
          onClick={onCancel}
          disabled={saving}
          className="px-4 py-2 text-gray-400 hover:text-white transition text-sm"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// Defensive parse: rules column stores JSON. Bad data shouldn't crash the page.
function parseRules(rulesJson: string): Rule[] {
  try {
    const parsed = JSON.parse(rulesJson);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as Rule[];
  } catch {
    // fall through
  }
  return [{ ...EMPTY_RULE }];
}

// ─── Focus definitions (R05.3) ───────────────────────────────────

/**
 * A playlist made of field conditions only is one the rule editor can still
 * edit without losing anything. Anything built in Focus is edited as groups.
 */
function isRuleOnly(definition: SmartDefinition | null | undefined): boolean {
  if (!definition) return true;
  if (definition.groups.length !== 1) return false;
  return [...new URLSearchParams(definition.groups[0]).keys()].every((key) => key === 'rule');
}

/** A group in words, the way the Focus bar shows active filters. */
function groupLabel(group: string): string {
  const chips = activeFilters(new URLSearchParams(group));
  return chips.length > 0 ? chips.map((c) => c.label).join(' · ') : 'All tracks';
}

/** Open a group as a Focus page, with the playlist's sort. */
function groupHref(group: string, definition: SmartDefinition): string {
  const params = new URLSearchParams(group);
  if (definition.sort) params.set('sort', definition.sort);
  if (definition.order) params.set('order', definition.order);
  const query = params.toString();
  return query ? `/tracks?${query}` : '/tracks';
}

const PLAYLIST_SORTS: SortKey[] = [
  'artist',
  'title',
  'year',
  'added',
  'lastPlayed',
  'plays',
  'duration',
];

function DefinitionSummary({ definition }: { definition: SmartDefinition }) {
  return (
    <div className="mt-3 space-y-1 text-sm text-gray-400" data-testid="smart-definition">
      <p className="text-xs uppercase tracking-wider text-gray-500">
        {definition.groups.length > 1 ? 'Tracks matching any of' : 'Tracks matching'}
      </p>
      <ul className="space-y-1">
        {definition.groups.map((group, i) => (
          <li key={`${i}-${group}`} className="flex flex-wrap items-center gap-2">
            {i > 0 && <span className="text-xs text-gray-500">or</span>}
            <span>{groupLabel(group)}</span>
            <Link to={groupHref(group, definition)} className="text-xs text-accent hover:underline">
              Open in Focus
            </Link>
          </li>
        ))}
      </ul>
      <p className="text-xs text-gray-500">
        {definition.sort
          ? `Sorted by ${SORT_LABELS[definition.sort as SortKey] ?? definition.sort}`
          : 'Album order'}
        {definition.order === 'desc' ? ' ↓' : ''} · at most {definition.limit ?? 200} tracks
      </p>
    </div>
  );
}

function DefinitionEditor({
  playlist,
  onCancel,
  onSaved,
}: {
  playlist: SmartPlaylist;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const definition = playlist.definition!;
  const [name, setName] = useState(playlist.name);
  const [groups, setGroups] = useState(definition.groups);
  const [sort, setSort] = useState(definition.sort ?? '');
  const [order, setOrder] = useState<'asc' | 'desc'>(definition.order ?? 'asc');
  const [limit, setLimit] = useState(String(definition.limit ?? 200));
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const save = async () => {
    const max = Math.round(Number(limit));
    if (!name.trim() || !Number.isFinite(max) || max < 1 || max > 1000) {
      toast('A name, and a limit between 1 and 1000', 'error');
      return;
    }
    setSaving(true);
    try {
      if (name.trim() !== playlist.name)
        await api.updateSmartPlaylist(playlist.id, { name: name.trim() });
      await api.setSmartPlaylistDefinition(playlist.id, {
        groups,
        sort: sort || undefined,
        order: sort ? order : undefined,
        limit: max,
      });
      toast('Smart playlist updated', 'success');
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      aria-label="Edit smart playlist"
      className="space-y-4 rounded-lg bg-surface-light p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="block text-xs text-gray-400">
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 block w-full rounded bg-surface-dark border border-white/10 px-3 py-2 text-sm text-white"
        />
      </label>
      <div>
        <p className="text-xs text-gray-400 mb-1">Groups (a track that matches any group is in)</p>
        <ul className="space-y-1">
          {groups.map((group, i) => (
            <li key={`${i}-${group}`} className="flex items-center gap-2 text-sm">
              <span className="flex-1">{groupLabel(group)}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={groups.length === 1}
                onClick={() => setGroups(groups.filter((_, j) => j !== i))}
                aria-label={`Remove group ${groupLabel(group)}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <p className="mt-1 text-xs text-gray-500">
          Add a group from any Focus page: Save → “Add to smart playlist”.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-gray-400">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="mt-1 block rounded bg-surface-dark border border-white/10 px-2 py-1.5 text-sm text-white"
          >
            <option value="">Album order</option>
            {PLAYLIST_SORTS.map((key) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-gray-400">
          Direction
          <select
            value={order}
            disabled={!sort}
            onChange={(e) => setOrder(e.target.value === 'desc' ? 'desc' : 'asc')}
            className="mt-1 block rounded bg-surface-dark border border-white/10 px-2 py-1.5 text-sm text-white"
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </label>
        <label className="text-xs text-gray-400">
          At most
          <input
            type="number"
            min={1}
            max={1000}
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            className="mt-1 block w-24 rounded bg-surface-dark border border-white/10 px-2 py-1.5 text-sm text-white"
          />
        </label>
      </div>
      <div className="flex gap-2">
        <Button type="submit" variant="accent" size="sm" disabled={saving}>
          {saving ? 'Saving...' : 'Save changes'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ─── Page entry ──────────────────────────────────────────────────

export default function SmartPlaylistsPage() {
  const { id } = useParams<{ id?: string }>();
  if (id) return <SmartPlaylistDetail id={id} />;
  return <SmartPlaylistList />;
}

// ─── List + create ───────────────────────────────────────────────

function SmartPlaylistList() {
  const [playlists, setPlaylists] = useState<SmartPlaylist[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [rules, setRules] = useState<Rule[]>([{ ...EMPTY_RULE }]);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const load = () => {
    api
      .getSmartPlaylists()
      .then((res) => setPlaylists(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const handleCreate = async () => {
    if (!newName.trim() || rules.some((r) => !r.value)) {
      toast('Fill in all fields', 'error');
      return;
    }
    setSaving(true);
    try {
      await api.createSmartPlaylist(newName.trim(), rules);
      setNewName('');
      setRules([{ ...EMPTY_RULE }]);
      setShowCreate(false);
      load();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    await api.deleteSmartPlaylist(id);
    load();
  };

  if (loading) return <p className="text-gray-400">Loading...</p>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">
          Smart Playlists{' '}
          <span className="text-sm font-normal text-gray-500">({playlists.length})</span>
        </h2>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-3 py-1 text-sm bg-accent rounded hover:bg-accent-hover transition"
        >
          + New Smart Playlist
        </button>
      </div>

      <p className="-mt-4 mb-6 text-xs text-gray-500">
        Or build one with Focus: filter{' '}
        <Link to="/tracks" className="text-accent hover:underline">
          Tracks
        </Link>{' '}
        or{' '}
        <Link to="/albums" className="text-accent hover:underline">
          Albums
        </Link>
        , then Save → New smart playlist.
      </p>

      {showCreate && (
        <div className="mb-6">
          <RuleEditor
            name={newName}
            onNameChange={setNewName}
            rules={rules}
            onRulesChange={setRules}
            onSave={handleCreate}
            onCancel={() => {
              setShowCreate(false);
              setNewName('');
              setRules([{ ...EMPTY_RULE }]);
            }}
            saveLabel="Create"
            saving={saving}
          />
        </div>
      )}

      {playlists.length === 0 && !showCreate ? (
        <p className="text-gray-500 text-center py-12">
          No smart playlists yet. Create one based on genre, year, format, or artist rules.
        </p>
      ) : (
        <div className="space-y-1">
          {playlists.map((pl) => (
            <div
              key={pl.id}
              className="flex items-center gap-4 px-4 py-3 rounded-lg hover:bg-surface-light transition group"
            >
              <Link to={`/smart-playlists/${pl.id}`} className="flex-1 min-w-0">
                <p className="text-sm font-medium group-hover:text-accent transition">{pl.name}</p>
                <p className="text-xs text-gray-500">
                  {pl.trackCount || 0} tracks (auto-generated)
                </p>
              </Link>
              <button
                onClick={() => handleDelete(pl.id)}
                className="text-xs text-gray-600 hover:text-red-400 transition opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                aria-label={`Delete smart playlist ${pl.name}`}
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

// ─── Detail + edit ───────────────────────────────────────────────

function SmartPlaylistDetail({ id }: { id: string }) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [playlist, setPlaylist] = useState<SmartPlaylist | null>(null);
  const [loading, setLoading] = useState(true);
  const { playAlbum, currentTrack, isPlaying } = useAudioContext();
  const { toast } = useToast();

  // Edit-mode state. When `editing` is true, we render the RuleEditor in place
  // of the track list. Saving re-loads both the playlist and its tracks.
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editRules, setEditRules] = useState<Rule[]>([{ ...EMPTY_RULE }]);
  const [saving, setSaving] = useState(false);
  const loadRequestRef = useRef(0);
  const activePlaylistIdRef = useRef(id);
  activePlaylistIdRef.current = id;
  const invalidateLoads = useCallback(() => {
    loadRequestRef.current++;
  }, []);

  const loadAll = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    try {
      const [tracksResponse, playlistsResponse] = await Promise.all([
        api.getSmartPlaylistTracks(id),
        api.getSmartPlaylists(),
      ]);
      if (requestId !== loadRequestRef.current) return;
      setTracks(tracksResponse.data);
      setPlaylist(playlistsResponse.data.find((playlist) => playlist.id === id) ?? null);
    } catch {
      // Preserve the current/reset state; callers can retry through a later load.
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    setTracks([]);
    setPlaylist(null);
    setEditing(false);
    setEditName('');
    setEditRules([{ ...EMPTY_RULE }]);
    setSaving(false);
    void loadAll();
    return invalidateLoads;
  }, [invalidateLoads, loadAll]);

  const startEdit = () => {
    if (!playlist) return;
    setEditName(playlist.name);
    setEditRules(parseRules(playlist.rules));
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditName('');
    setEditRules([{ ...EMPTY_RULE }]);
  };

  const saveEdit = async () => {
    if (!editName.trim() || editRules.some((r) => !r.value)) {
      toast('Fill in all fields', 'error');
      return;
    }
    const playlistId = id;
    setSaving(true);
    try {
      await api.updateSmartPlaylist(id, { name: editName.trim(), rules: editRules });
      if (activePlaylistIdRef.current !== playlistId) return;
      toast('Smart playlist updated', 'success');
      setEditing(false);
      void loadAll();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading && !playlist) return <p className="text-gray-400">Loading...</p>;

  return (
    <div>
      <Link to="/smart-playlists" className="text-sm text-gray-400 hover:text-accent transition">
        &larr; Smart Playlists
      </Link>
      <div className="mt-2 mb-8">
        <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">Smart Playlist</p>
        <div className="flex items-baseline gap-3 mb-2">
          <h2 className="text-3xl font-bold">{playlist?.name ?? ''}</h2>
          {!editing && playlist && (
            <button
              onClick={startEdit}
              className="text-xs text-gray-400 hover:text-accent transition"
            >
              {isRuleOnly(playlist.definition) ? 'Edit rules' : 'Edit'}
            </button>
          )}
        </div>
        <p className="text-sm text-gray-500">{tracks.length} tracks (auto-generated)</p>
        {!editing && playlist?.definition && !isRuleOnly(playlist.definition) && (
          <DefinitionSummary definition={playlist.definition} />
        )}
        {!editing && tracks.length > 0 && (
          <button
            onClick={() => playAlbum(tracks)}
            className="mt-4 px-6 py-2 bg-accent rounded-full hover:bg-accent-hover transition text-sm font-medium"
          >
            Play All
          </button>
        )}
      </div>

      {editing && playlist && !isRuleOnly(playlist.definition) ? (
        <DefinitionEditor
          playlist={playlist}
          onCancel={cancelEdit}
          onSaved={() => {
            setEditing(false);
            void loadAll();
          }}
        />
      ) : editing ? (
        <RuleEditor
          name={editName}
          onNameChange={setEditName}
          rules={editRules}
          onRulesChange={setEditRules}
          onSave={saveEdit}
          onCancel={cancelEdit}
          saveLabel="Save changes"
          saving={saving}
        />
      ) : tracks.length === 0 ? (
        <p className="text-gray-500 text-center py-8">No tracks match the rules.</p>
      ) : (
        <div className="space-y-0.5">
          {tracks.map((track, i) => {
            const isCurrent = currentTrack?.id === track.id;
            return (
              <div
                key={`${track.id}-${i}`}
                data-play-actions-row
                className="flex items-center gap-1"
              >
                <button
                  onClick={() => playAlbum(tracks, i)}
                  onContextMenu={openRowMenuFromPointer}
                  className={`flex-1 min-w-0 flex items-center gap-4 px-4 py-2 rounded hover:bg-surface-light transition text-left ${isCurrent ? 'text-accent' : ''}`}
                >
                  <span className="w-6 text-sm text-gray-500 text-right shrink-0">
                    {isCurrent && isPlaying ? (
                      <span className="animate-pulse">&#9654;</span>
                    ) : (
                      i + 1
                    )}
                  </span>
                  <div className="w-8 h-8 rounded bg-surface-dark overflow-hidden shrink-0">
                    {track.albumId && (
                      <img
                        src={api.getAlbumCoverUrl(track.albumId)}
                        alt=""
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{track.title}</p>
                    <p className="text-xs text-gray-500 truncate">
                      {track.artistName} &middot; {track.albumTitle}
                    </p>
                  </div>
                  {track.format && (
                    <span className="text-[10px] text-gray-600 shrink-0">{track.format}</span>
                  )}
                  <span className="text-sm text-gray-400 shrink-0">
                    {formatDuration(track.duration)}
                  </span>
                </button>
                <FavoriteButton kind="track" id={track.id} title={track.title} />
                <PlayActions
                  target={{
                    kind: 'track',
                    track: toTrackInfo(track),
                    list: tracks.map((t) => toTrackInfo(t)),
                    index: i,
                  }}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
