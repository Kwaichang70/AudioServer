import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import type { LocalSearchResults } from '../api/types.js';

/**
 * Search from anywhere (R02.2).
 *
 * The bar sits in the header on every page, and `/` puts the cursor in it —
 * before this, searching meant navigating to a page first. What drops down is
 * a jump list, not a result page: the first few artists, albums and tracks
 * from the LIBRARY only, so it answers while you type without waiting for
 * Qobuz. Enter opens the full search, which is where the streaming sources
 * and the filters live.
 *
 * A track jumps to its album rather than playing: a list you are reading
 * should not start making sound, and the album is where the play actions are.
 */

const SUGGEST_LIMIT = 5;
const DEBOUNCE_MS = 200;

interface Suggestion {
  key: string;
  label: string;
  detail: string;
  kind: 'Artist' | 'Album' | 'Track';
  to: string;
}

function toSuggestions(results: LocalSearchResults): Suggestion[] {
  const artists = (results.artists ?? []).slice(0, SUGGEST_LIMIT).map((a) => ({
    key: `artist-${a.id}`,
    label: a.name,
    detail: '',
    kind: 'Artist' as const,
    to: `/artists/${a.id}`,
  }));
  const albums = (results.albums ?? []).slice(0, SUGGEST_LIMIT).map((a) => ({
    key: `album-${a.id}`,
    label: a.title,
    detail: a.artistName ?? '',
    kind: 'Album' as const,
    to: `/albums/${a.id}`,
  }));
  const tracks = (results.tracks ?? [])
    .filter((t) => !!t.albumId)
    .slice(0, SUGGEST_LIMIT)
    .map((t) => ({
      key: `track-${t.id}`,
      label: t.title,
      detail: `${t.artistName ?? ''}${t.albumTitle ? ` · ${t.albumTitle}` : ''}`,
      kind: 'Track' as const,
      to: `/albums/${t.albumId}`,
    }));
  return [...artists, ...albums, ...tracks];
}

interface Props {
  /** Compact form for the phone header. */
  compact?: boolean;
}

export default function SearchBar({ compact = false }: Props) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  // `/` focuses the bar from anywhere, the way it used to jump to the search
  // page. Typing in a field keeps its slash.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
        return;
      }
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .search(text, SUGGEST_LIMIT * 3)
        .then((res) => {
          if (!cancelled) {
            setSuggestions(toSuggestions(res.data));
            setActive(-1);
          }
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  const go = (to: string) => {
    setOpen(false);
    inputRef.current?.blur();
    navigate(to);
  };

  const submit = () => {
    const text = query.trim();
    if (!text) return;
    go(`/search?q=${encodeURIComponent(text)}`);
  };

  const showList = open && suggestions.length > 0;

  return (
    <div ref={boxRef} className={`relative ${compact ? 'flex-1' : 'w-full max-w-md'}`}>
      <input
        ref={inputRef}
        type="search"
        value={query}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label="Search your library"
        placeholder={compact ? 'Search' : 'Search your library…  ( / )'}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (active >= 0 && suggestions[active]) go(suggestions[active].to);
            else submit();
            return;
          }
          if (e.key === 'Escape') {
            setOpen(false);
            inputRef.current?.blur();
            return;
          }
          if (!showList) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => (i + 1) % suggestions.length);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => (i - 1 + suggestions.length) % suggestions.length);
          }
        }}
        className="w-full rounded-full bg-surface-dark border border-white/10 px-4 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-accent"
      />

      {showList && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Search suggestions"
          className="absolute left-0 right-0 top-full z-[110] mt-1 max-h-96 overflow-y-auto rounded-lg border border-white/10 bg-surface py-1 shadow-xl"
        >
          {suggestions.map((s, i) => (
            <li key={s.key}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(s.to)}
                className={`flex w-full items-baseline gap-2 px-4 py-2 text-left text-sm transition ${
                  i === active ? 'bg-white/10' : 'hover:bg-white/10'
                }`}
              >
                <span className="w-12 shrink-0 text-[10px] uppercase tracking-wide text-gray-500">
                  {s.kind}
                </span>
                <span className="truncate">{s.label}</span>
                {s.detail && <span className="truncate text-xs text-gray-500">{s.detail}</span>}
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              onClick={submit}
              className="w-full px-4 py-2 text-left text-xs text-gray-400 hover:bg-white/10 hover:text-white"
            >
              Search every source for “{query.trim()}”
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
