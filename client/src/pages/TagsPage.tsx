import { useCallback, useEffect, useState } from 'react';
import FavoriteButton from '../components/FavoriteButton.js';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import type { Tag, TagDetail, TagItemType } from '../api/types.js';
import { useAudioContext } from '../context/AudioContext.js';
import AlbumCover from '../components/AlbumCover.js';
import PlayActions, { CardActions, shuffledCopy, toTrackInfo } from '../components/PlayActions.js';
import Button, { buttonClasses } from '../components/ui/Button.js';
import Chip from '../components/ui/Chip.js';
import { notifyTagsChanged } from '../hooks/useTags.js';
import { formatDuration } from '../utils/format.js';
import { getErrorMessage } from './settings/shared.js';

/**
 * Tags (R06.2): your own order of the library. The list shows yours and the
 * household's shared ones; a tag's page shows what it holds, plays or
 * shuffles it, and — when it is yours — lets you rename, share or prune it.
 */

export default function TagsPage() {
  const { id } = useParams<{ id?: string }>();
  return id ? <TagDetailView id={id} /> : <TagList />;
}

function describe(tag: Tag): string {
  const parts: string[] = [];
  const { album, artist, track, playlist } = tag.counts;
  if (album) parts.push(`${album} album${album === 1 ? '' : 's'}`);
  if (artist) parts.push(`${artist} artist${artist === 1 ? '' : 's'}`);
  if (track) parts.push(`${track} track${track === 1 ? '' : 's'}`);
  if (playlist) parts.push(`${playlist} playlist${playlist === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : 'Empty';
}

function usePlayTag() {
  const { playAlbum } = useAudioContext();
  const [starting, setStarting] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const play = async (tag: Pick<Tag, 'id' | 'name'>, shuffle: boolean) => {
    setStarting(tag.id);
    setNote(null);
    try {
      const res = await api.getTagTracks(tag.id);
      const list = (res.data ?? []).map((t) => toTrackInfo(t));
      if (list.length === 0) setNote(`Nothing in “${tag.name}” can play right now.`);
      else playAlbum(shuffle ? shuffledCopy(list) : list, 0);
    } catch {
      // API errors are toasted globally.
    } finally {
      setStarting(null);
    }
  };
  return { play, starting, note };
}

function TagList() {
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { play, starting, note } = usePlayTag();

  const load = useCallback(() => {
    api
      .getTags()
      .then((res) => setTags(res.data ?? []))
      .catch(() => setTags([]));
  }, []);
  useEffect(load, [load]);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    try {
      await api.createTag(trimmed, shared);
      setName('');
      setShared(false);
      notifyTagsChanged();
      load();
    } catch (err) {
      setError(getErrorMessage(err, 'Could not create the tag'));
    }
  };

  if (tags === null) return <p className="text-gray-400">Loading tags...</p>;
  const mine = tags.filter((t) => t.mine);
  const theirs = tags.filter((t) => !t.mine);

  const row = (tag: Tag) => (
    <li
      key={tag.id}
      className="flex items-center gap-3 rounded-lg px-4 py-3 hover:bg-surface-light"
    >
      <Link to={`/tags/${tag.id}`} className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          # {tag.name}
          {tag.shared && tag.mine && <span className="ml-2 text-xs text-gray-500">shared</span>}
          {!tag.mine && tag.ownerName && (
            <span className="ml-2 text-xs text-gray-500">from {tag.ownerName}</span>
          )}
        </p>
        <p className="text-xs text-gray-500">{describe(tag)}</p>
      </Link>
      <Button
        size="sm"
        variant="ghost"
        disabled={starting === tag.id || tag.itemCount === 0}
        onClick={() => void play(tag, true)}
        aria-label={`Shuffle ${tag.name}`}
      >
        ⤮ Shuffle
      </Button>
    </li>
  );

  return (
    <div className="max-w-3xl">
      <h2 className="mb-6 text-2xl font-bold">
        Tags <span className="text-sm font-normal text-gray-500">({tags.length})</span>
      </h2>
      <form
        aria-label="New tag"
        className="mb-6 flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          placeholder="New tag, e.g. Sunday morning"
          aria-label="Tag name"
          className="min-w-[12rem] flex-1 rounded bg-surface-dark border border-white/10 px-3 py-2 text-sm"
        />
        <label className="flex items-center gap-2 text-xs text-gray-400">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
          Share with the household
        </label>
        <Button type="submit" size="sm" variant="accent" disabled={!name.trim()}>
          Create
        </Button>
        {error && (
          <p role="alert" className="w-full text-xs text-red-300">
            {error}
          </p>
        )}
      </form>
      {note && (
        <p role="status" className="mb-4 text-xs text-gray-500">
          {note}
        </p>
      )}
      {tags.length === 0 ? (
        <p className="py-12 text-center text-gray-500">
          No tags yet. Create one here, or use “Add tag” in the menu of any album, artist or track.
        </p>
      ) : (
        <>
          {mine.length > 0 && <ul aria-label="Your tags">{mine.map(row)}</ul>}
          {theirs.length > 0 && (
            <>
              <h3 className="mt-6 mb-2 px-4 text-xs uppercase tracking-wider text-gray-500">
                Shared with you
              </h3>
              <ul aria-label="Shared with you">{theirs.map(row)}</ul>
            </>
          )}
        </>
      )}
    </div>
  );
}

function TagDetailView({ id }: { id: string }) {
  const [tag, setTag] = useState<TagDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const { play, starting, note } = usePlayTag();
  const { playAlbum } = useAudioContext();
  const navigate = useNavigate();

  const load = useCallback(() => {
    api
      .getTag(id)
      .then((res) => {
        setTag(res.data);
        setMissing(false);
      })
      .catch(() => setMissing(true));
  }, [id]);
  useEffect(() => {
    setTag(null);
    load();
  }, [load]);

  if (missing)
    return <p className="text-gray-400">This tag does not exist, or is not shared with you.</p>;
  if (!tag) return <p className="text-gray-400">Loading...</p>;

  const changed = () => {
    notifyTagsChanged();
    load();
  };
  const remove = async (type: TagItemType, itemId: string) => {
    await api.removeTagItem(tag.id, type, itemId);
    changed();
  };
  const removeButton = (type: TagItemType, itemId: string, label: string) =>
    tag.mine && (
      <button
        type="button"
        onClick={() => void remove(type, itemId)}
        aria-label={`Remove ${label} from ${tag.name}`}
        className="rounded px-2 text-xs text-gray-500 hover:text-white"
      >
        ×
      </button>
    );
  const tracks = tag.items.tracks.filter((t) => t.availability !== 'missing');
  const trackInfos = tracks.map((t) => toTrackInfo(t));

  return (
    <div>
      <Link to="/tags" className="text-sm text-gray-400 hover:text-accent">
        &larr; Tags
      </Link>
      <div className="mt-2 mb-6">
        <p className="mb-1 text-xs uppercase tracking-wider text-gray-400">
          Tag{!tag.mine && tag.ownerName ? ` · from ${tag.ownerName}` : ''}
          {tag.mine && tag.shared ? ' · shared with the household' : ''}
        </p>
        {renaming ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim()) return;
              void api.updateTag(tag.id, { name: name.trim() }).then(() => {
                setRenaming(false);
                changed();
              });
            }}
          >
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Tag name"
              className="rounded bg-surface-dark border border-white/10 px-3 py-1.5 text-xl"
            />
            <Button type="submit" size="sm" variant="accent">
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <h2 className="text-3xl font-bold"># {tag.name}</h2>
        )}
        <p className="mt-1 text-sm text-gray-500">{describe(tag)}</p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            variant="accent"
            disabled={starting === tag.id || tag.itemCount === 0}
            onClick={() => void play(tag, false)}
          >
            ▶ Play
          </Button>
          <Button
            disabled={starting === tag.id || tag.itemCount === 0}
            onClick={() => void play(tag, true)}
          >
            ⤮ Shuffle
          </Button>
          <Link to={`/albums?tag=${encodeURIComponent(tag.id)}`} className={buttonClasses('ghost')}>
            Refine in Focus
          </Link>
          {tag.mine && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setName(tag.name);
                  setRenaming(true);
                }}
              >
                Rename
              </Button>
              <Chip
                pressed={tag.shared}
                onClick={() => void api.updateTag(tag.id, { shared: !tag.shared }).then(changed)}
              >
                {tag.shared ? 'Shared' : 'Share with the household'}
              </Chip>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (!window.confirm(`Delete the tag “${tag.name}”? The music stays.`)) return;
                  void api.deleteTag(tag.id).then(() => {
                    notifyTagsChanged();
                    navigate('/tags');
                  });
                }}
              >
                Delete
              </Button>
            </>
          )}
        </div>
        {note && (
          <p role="status" className="mt-2 text-xs text-gray-500">
            {note}
          </p>
        )}
      </div>

      {tag.items.albums.length > 0 && (
        <section className="mb-8" aria-label="Albums">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">
            Albums
          </h3>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {tag.items.albums.map((album) => (
              <div key={album.id} data-play-actions-row className="group relative">
                <Link
                  to={`/albums/${album.id}`}
                  className="block rounded-lg bg-surface-light p-3 transition hover:bg-surface"
                >
                  <div className="mb-2">
                    <AlbumCover
                      albumId={album.id}
                      title={album.title}
                      artistName={album.artistName}
                      coverUrl={album.coverUrl}
                    />
                  </div>
                  <p className="truncate text-sm font-medium">{album.title}</p>
                  <p className="truncate text-xs text-gray-400">{album.artistName}</p>
                </Link>
                <CardActions target={{ kind: 'album', albumId: album.id, title: album.title }} />
                {tag.mine && (
                  <div className="mt-1 text-right">
                    {removeButton('album', album.id, album.title)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {tag.items.artists.length > 0 && (
        <section className="mb-8" aria-label="Artists">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">
            Artists
          </h3>
          <ul className="flex flex-wrap gap-2">
            {tag.items.artists.map((artist) => (
              <li key={artist.id} className="flex items-center rounded-full bg-surface-light pl-3">
                <Link to={`/artists/${artist.id}`} className="py-1 text-sm hover:text-accent">
                  {artist.name}
                </Link>
                {removeButton('artist', artist.id, artist.name)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {tag.items.tracks.length > 0 && (
        <section className="mb-8" aria-label="Tracks">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">
            Tracks
          </h3>
          <ul>
            {tag.items.tracks.map((track) => {
              const index = tracks.indexOf(track);
              return (
                <li
                  key={track.id}
                  data-play-actions-row
                  className={`flex items-center gap-2 border-b border-white/5 py-2 ${index < 0 ? 'opacity-50' : ''}`}
                >
                  <button
                    type="button"
                    disabled={index < 0}
                    onClick={() => playAlbum(trackInfos, index)}
                    className="min-w-0 flex-1 text-left"
                    aria-label={`Play ${track.title} by ${track.artistName}`}
                  >
                    <span className="block truncate text-sm">{track.title}</span>
                    <span className="block truncate text-xs text-gray-500">
                      {track.artistName} · {track.albumTitle}
                    </span>
                  </button>
                  <span className="text-xs text-gray-500">{formatDuration(track.duration)}</span>
                  {index >= 0 && <FavoriteButton kind="track" id={track.id} title={track.title} />}
                  {index >= 0 && (
                    <PlayActions
                      target={{ kind: 'track', track: trackInfos[index], list: trackInfos, index }}
                    />
                  )}
                  {removeButton('track', track.id, track.title)}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {tag.items.playlists.length > 0 && (
        <section className="mb-8" aria-label="Playlists">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">
            Playlists
          </h3>
          <ul className="flex flex-wrap gap-2">
            {tag.items.playlists.map((playlist) => (
              <li
                key={playlist.id}
                className="flex items-center rounded-full bg-surface-light pl-3"
              >
                <Link to={`/playlists/${playlist.id}`} className="py-1 text-sm hover:text-accent">
                  {playlist.name}
                </Link>
                {removeButton('playlist', playlist.id, playlist.name)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {tag.itemCount === 0 && (
        <p className="py-12 text-center text-gray-500">
          Nothing here yet. Use “Add tag” in the menu of an album, artist or track.
        </p>
      )}
    </div>
  );
}
