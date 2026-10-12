import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAudioContext } from '../context/AudioContext.js';
import type { FocusHandle } from '../hooks/useFocus.js';
import { notifyBookmarksChanged } from '../hooks/useBookmarks.js';
import type { SmartDefinition, SmartPlaylist } from '../api/types.js';
import { getErrorMessage } from '../pages/settings/shared.js';
import {
  RECENT_DAYS,
  SORT_LABELS,
  activeFilters,
  clearFilters,
  filterCount,
  setValue,
  toggleDecade,
  toggleValue,
  type FocusListKey,
  type SortKey,
} from '../utils/focus.js';
import Button, { buttonClasses } from './ui/Button.js';
import Chip from './ui/Chip.js';
import { shuffledCopy, toTrackInfo } from './PlayActions.js';

/**
 * Focus (R05.2): filter and sort a library list.
 *
 * `FocusBar` sits above the list: the Focus button, the active filters as
 * removable chips, and "Play all" / "Shuffle" for exactly what is shown.
 * `FocusPanel` is the panel itself — a sheet from the bottom on a phone, a
 * side panel on a wider screen — with every facet as chips and their counts.
 */

const SHEET_BREAKPOINT = 640;
/** "Play all" starts at most this many tracks; the queue is not a library. */
export const PLAY_ALL_LIMIT = 1000;
const PLAY_PAGE = 200;

interface BarProps {
  focus: FocusHandle;
  sorts: SortKey[];
  /** Sort to use for the tracks of "Play all"; null = album order. */
  playSort?: (sort: string | null) => string | null;
  /** What the counts in the panel are, when they are not what the page lists. */
  countNote?: string;
}

export function FocusBar({ focus, sorts, playSort, countNote }: BarProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { params, update, composerNames } = focus;
  const chips = activeFilters(params, composerNames);
  const count = filterCount(params);
  const { playAlbum } = useAudioContext();
  const [starting, setStarting] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const question = () => trackQuestion(focus.query, playSort);

  const play = async (shuffle: boolean) => {
    setStarting(true);
    setNote(null);
    try {
      const { filters, sort, order } = question();
      const query = new URLSearchParams(filters);
      if (sort) {
        query.set('sort', sort);
        if (order) query.set('order', order);
      }
      const tracks = [];
      let total = 0;
      for (let page = 1; tracks.length < PLAY_ALL_LIMIT; page += 1) {
        const res = await api.getTracks(page, PLAY_PAGE, query.toString());
        tracks.push(...res.data);
        total = res.meta.total;
        if (page >= res.meta.totalPages) break;
      }
      const list = tracks
        .slice(0, PLAY_ALL_LIMIT)
        .filter((t) => t.availability !== 'missing')
        .map((t) => toTrackInfo(t));
      if (list.length > 0) playAlbum(shuffle ? shuffledCopy(list) : list, 0);
      if (total > PLAY_ALL_LIMIT) {
        setNote(`Started the first ${PLAY_ALL_LIMIT} of ${total} tracks.`);
      } else if (list.length === 0) {
        setNote('Nothing here can play right now.');
      }
    } catch {
      // The toast layer reports API errors; the buttons stay usable.
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="mb-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          ref={buttonRef}
          type="button"
          className={buttonClasses(count > 0 ? 'accent' : 'outline', 'sm')}
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          Focus{count > 0 ? ` · ${count}` : ''}
        </button>
        {params.get('sort') && (
          <span className="text-xs text-gray-500">
            Sorted by {SORT_LABELS[params.get('sort') as SortKey] ?? params.get('sort')}
            {params.get('order') === 'asc' ? ' ↑' : params.get('order') === 'desc' ? ' ↓' : ''}
          </span>
        )}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" disabled={starting} onClick={() => void play(false)}>
          ▶ Play all
        </Button>
        <Button size="sm" variant="ghost" disabled={starting} onClick={() => void play(true)}>
          ⤮ Shuffle
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={saving}
          onClick={() => setSaving((on) => !on)}
        >
          ☆ Save
        </Button>
      </div>
      {saving && (
        <SaveFocus
          suggestion={chips.map((c) => c.label).join(', ')}
          query={focus.query}
          question={question()}
          onDone={(message) => {
            setSaving(false);
            setNote(message);
          }}
        />
      )}
      {chips.length > 0 && (
        <ul className="flex flex-wrap items-center gap-2" aria-label="Active filters">
          {chips.map((chip) => (
            <li key={chip.id}>
              <Chip pressed onClick={() => update(chip.remove)} label={`Remove ${chip.label}`}>
                {chip.label} <span aria-hidden="true">×</span>
              </Chip>
            </li>
          ))}
          <li>
            <button
              type="button"
              onClick={() => update(clearFilters)}
              className="text-xs text-gray-400 underline hover:text-white"
            >
              Clear all
            </button>
          </li>
        </ul>
      )}
      {note && (
        <p className="text-xs text-gray-500" role="status">
          {note}
        </p>
      )}
      <FocusPanel
        open={open}
        onClose={() => {
          setOpen(false);
          buttonRef.current?.focus();
        }}
        focus={focus}
        sorts={sorts}
        countNote={countNote}
      />
    </div>
  );
}

/**
 * The tracks behind a Focus page: its filters, and the page's sort as far as
 * it means the same for a track (see `playSort`). "Play all" plays it and a
 * smart playlist stores it.
 */
function trackQuestion(
  focusQuery: string,
  playSort?: (sort: string | null) => string | null,
): { filters: string; sort?: string; order?: 'asc' | 'desc' } {
  const query = new URLSearchParams(focusQuery);
  const pageSort = query.get('sort');
  const order = query.get('order');
  query.delete('sort');
  query.delete('order');
  const sort = playSort ? playSort(pageSort) : pageSort;
  return {
    filters: query.toString(),
    sort: sort ?? undefined,
    order: sort && (order === 'asc' || order === 'desc') ? order : undefined,
  };
}

/**
 * Save the current Focus (R05.3): as a bookmark (this page with this
 * question, in the sidebar), as a new smart playlist, or as one more OR group
 * of a smart playlist you already have.
 */
function SaveFocus({
  suggestion,
  query,
  question,
  onDone,
}: {
  suggestion: string;
  query: string;
  question: ReturnType<typeof trackQuestion>;
  onDone: (message: string) => void;
}) {
  const location = useLocation();
  const [name, setName] = useState(suggestion);
  const [mine, setMine] = useState<SmartPlaylist[]>([]);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getSmartPlaylists()
      .then((res) => {
        if (!cancelled) setMine((res.data ?? []).filter((sp) => sp.definition));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    try {
      onDone(await action());
    } catch (err) {
      setError(getErrorMessage(err, 'Could not save'));
    } finally {
      setBusy(false);
    }
  };

  const named = name.trim();
  const definition = (): SmartDefinition => ({
    groups: [question.filters],
    sort: question.sort,
    order: question.order,
  });

  return (
    <form
      aria-label="Save this Focus"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-surface-light p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!named) return;
        void run(async () => {
          await api.createBookmark(named, location.pathname, query);
          notifyBookmarksChanged();
          return `Bookmarked as “${named}”.`;
        });
      }}
    >
      <label className="flex min-w-[12rem] flex-1 items-center gap-2 text-xs text-gray-400">
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          placeholder="e.g. Hi-Res jazz, never played"
          className="min-w-0 flex-1 rounded bg-surface-dark border border-white/10 px-2 py-1.5 text-sm text-white"
        />
      </label>
      <Button size="sm" variant="accent" type="submit" disabled={busy || !named}>
        Bookmark
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !named}
        onClick={() =>
          void run(async () => {
            await api.createSmartPlaylistFromFocus(named, definition());
            return `Smart playlist “${named}” created.`;
          })
        }
      >
        New smart playlist
      </Button>
      {mine.length > 0 && (
        <span className="flex items-center gap-2">
          <select
            aria-label="Smart playlist to add to"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="rounded bg-surface-dark border border-white/10 px-2 py-1.5 text-sm"
          >
            <option value="">Add to smart playlist…</option>
            {mine.map((sp) => (
              <option key={sp.id} value={sp.id}>
                {sp.name}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !target}
            onClick={() =>
              void run(async () => {
                const sp = mine.find((p) => p.id === target)!;
                const current = sp.definition!;
                await api.setSmartPlaylistDefinition(sp.id, {
                  ...current,
                  groups: [...current.groups, question.filters],
                });
                return `Added to “${sp.name}” as another group (OR).`;
              })
            }
          >
            Add (OR)
          </Button>
        </span>
      )}
      {error && (
        <p role="alert" className="w-full text-xs text-red-300">
          {error}
        </p>
      )}
    </form>
  );
}

interface PanelProps {
  open: boolean;
  onClose: () => void;
  focus: FocusHandle;
  sorts: SortKey[];
  countNote?: string;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs uppercase tracking-wide text-gray-500">{title}</h3>
      <div className="flex flex-wrap gap-2">{children}</div>
    </section>
  );
}

function Count({ n }: { n: number | undefined }) {
  if (n === undefined) return null;
  return <span className="text-[10px] opacity-70">{n}</span>;
}

export function FocusPanel({ open, onClose, focus, sorts, countNote }: PanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [sheet, setSheet] = useState(() => window.innerWidth < SHEET_BREAKPOINT);
  const { params, update, facets } = focus;

  useEffect(() => {
    if (!open) return;
    const onResize = () => setSheet(window.innerWidth < SHEET_BREAKPOINT);
    window.addEventListener('resize', onResize);
    panelRef.current?.querySelector<HTMLElement>('select, button')?.focus();
    return () => window.removeEventListener('resize', onResize);
  }, [open]);

  if (!open) return null;

  const list = (
    key: FocusListKey,
    values: Array<{ value: string; count: number }>,
    label = (v: string) => v,
  ) => {
    const selected = params.getAll(key);
    // A value that gives nothing is hidden — unless it is ticked, so it can
    // always be unticked again.
    const shown = values.filter((v) => v.count > 0 || selected.includes(v.value));
    for (const value of selected) {
      if (!shown.some((v) => v.value === value)) shown.push({ value, count: 0 });
    }
    return shown.map((v) => (
      <Chip
        key={v.value}
        pressed={selected.includes(v.value)}
        onClick={() => update((p) => toggleValue(p, key, v.value))}
      >
        {label(v.value)} <Count n={v.count} />
      </Chip>
    ));
  };

  const flag = (key: 'favorite' | 'unplayed' | 'dedupeEditions', text: string, n?: number) => (
    <Chip
      pressed={params.has(key)}
      onClick={() => update((p) => setValue(p, key, p.has(key) ? undefined : 'true'))}
    >
      {text} <Count n={n} />
    </Chip>
  );
  const recent = (key: 'playedWithin' | 'addedWithin', text: string) => (
    <Chip
      pressed={params.has(key)}
      onClick={() => update((p) => setValue(p, key, p.has(key) ? undefined : String(RECENT_DAYS)))}
    >
      {text}
    </Chip>
  );

  const sort = params.get('sort') ?? '';
  const order = params.get('order');
  const decadeOn = (d: string) =>
    params.get('yearFrom') === d && params.get('yearTo') === String(Number(d) + 9);
  const composerName = (id: string) =>
    facets?.composer.find((c) => c.value === id)?.name ?? 'Composer';
  const sources = facets?.source ?? [];

  const onKeyDown = (event: React.KeyboardEvent) => {
    // Keep keys (Space = play/pause) away from the global shortcuts.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  const panel = (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Escape closes; keys stay out of global shortcuts
    <div className="fixed inset-0 z-[110] flex" onKeyDown={onKeyDown}>
      <button
        type="button"
        aria-label="Close Focus"
        tabIndex={-1}
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Focus"
        className={
          sheet
            ? 'absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-2xl bg-surface border-t border-white/10 p-4 safe-bottom space-y-5'
            : 'absolute inset-y-0 right-0 w-96 max-w-full overflow-y-auto bg-surface border-l border-white/10 p-5 space-y-5 shadow-2xl'
        }
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Focus</h2>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>

        <section className="space-y-2">
          <h3 className="text-xs uppercase tracking-wide text-gray-500">Sort</h3>
          <div className="flex gap-2">
            <select
              aria-label="Sort by"
              value={sort}
              onChange={(e) =>
                update((p) => setValue(setValue(p, 'order', undefined), 'sort', e.target.value))
              }
              className="flex-1 rounded bg-surface-dark border border-white/10 px-2 py-1.5 text-sm"
            >
              <option value="">Default</option>
              {sorts.map((key) => (
                <option key={key} value={key}>
                  {SORT_LABELS[key]}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="outline"
              disabled={!sort}
              aria-label={
                order === 'asc'
                  ? 'Ascending'
                  : order === 'desc'
                    ? 'Descending'
                    : 'Default direction'
              }
              onClick={() =>
                update((p) => setValue(p, 'order', p.get('order') === 'asc' ? 'desc' : 'asc'))
              }
            >
              {order === 'asc' ? '↑' : order === 'desc' ? '↓' : '↕'}
            </Button>
          </div>
        </section>

        {countNote && <p className="text-xs text-gray-500">{countNote}</p>}

        <Section title="Quality">
          {(
            facets?.quality ?? [
              { value: 'lossless', count: undefined },
              { value: 'hires', count: undefined },
            ]
          ).map((q) => (
            <Chip
              key={q.value}
              pressed={params.get('quality') === q.value}
              onClick={() =>
                update((p) =>
                  setValue(p, 'quality', p.get('quality') === q.value ? undefined : q.value),
                )
              }
            >
              {q.value === 'hires' ? 'Hi-Res' : 'Lossless'} <Count n={q.count} />
            </Chip>
          ))}
        </Section>

        {facets && facets.genre.length > 0 && (
          <Section title="Genre">{list('genre', facets.genre)}</Section>
        )}

        {facets && facets.decade.length > 0 && (
          <Section title="Decade">
            {facets.decade
              .filter((d) => d.count > 0 || decadeOn(d.value))
              .map((d) => (
                <Chip
                  key={d.value}
                  pressed={decadeOn(d.value)}
                  onClick={() => update((p) => toggleDecade(p, d.value))}
                >
                  {d.value}s <Count n={d.count} />
                </Chip>
              ))}
          </Section>
        )}

        <Section title="Your stars">
          {[1, 2, 3, 4, 5].map((n) => {
            const value = String(n);
            const count = facets?.rating?.find((r) => r.value === value)?.count;
            const on = params.get('ratingMin') === value;
            if (count === 0 && !on) return null;
            return (
              <Chip
                key={n}
                pressed={on}
                onClick={() => update((p) => setValue(p, 'ratingMin', on ? undefined : value))}
              >
                {n === 5 ? '★ 5' : `★ ${n}+`} <Count n={count} />
              </Chip>
            );
          })}
        </Section>

        <Section title="Yours">
          {flag('favorite', 'Favourites', facets?.favorite)}
          {flag('unplayed', 'Never played', facets?.unplayed)}
          {recent('playedWithin', `Played in the last ${RECENT_DAYS} days`)}
          {recent('addedWithin', `Added in the last ${RECENT_DAYS} days`)}
        </Section>

        {facets && facets.format.length > 0 && (
          <Section title="Format">{list('format', facets.format, (v) => v.toUpperCase())}</Section>
        )}
        {(sources.length > 1 || params.has('source')) && (
          <Section title="Source">{list('source', sources)}</Section>
        )}
        {facets && (facets.tag?.length ?? 0) > 0 && (
          <Section title="Tags">
            {list('tag', facets.tag, (id) => {
              const tag = facets.tag.find((t) => t.value === id);
              return tag ? `# ${tag.name}` : 'Tag';
            })}
          </Section>
        )}
        {facets && facets.composer.length > 0 && (
          <Section title="Composer">{list('composer', facets.composer, composerName)}</Section>
        )}
        {facets && facets.label.length > 0 && (
          <Section title="Label">{list('label', facets.label)}</Section>
        )}

        <Section title="Editions">{flag('dedupeEditions', 'One edition per album')}</Section>

        <div className="sticky bottom-0 -mx-4 sm:-mx-5 flex items-center gap-2 bg-surface px-4 sm:px-5 py-3 border-t border-white/10">
          <Button
            size="sm"
            variant="ghost"
            disabled={filterCount(params) === 0}
            onClick={() => update(clearFilters)}
          >
            Clear all
          </Button>
          <span className="flex-1" />
          <Button size="sm" variant="accent" onClick={onClose}>
            {facets && !countNote ? `Show ${facets.total} albums` : 'Done'}
          </Button>
        </div>
      </div>
    </div>
  );

  return createPortal(panel, document.body);
}
