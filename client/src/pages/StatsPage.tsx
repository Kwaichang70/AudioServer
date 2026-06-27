import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';

type Range = 'week' | 'month' | 'year' | 'all_time';

interface TopArtist {
  name: string;
  listenCount: number;
  localArtistId: string | null;
}
interface TopRelease {
  title: string;
  artist: string;
  listenCount: number;
  localAlbumId: string | null;
}
interface TopRecording {
  title: string;
  artist: string;
  release: string | null;
  listenCount: number;
  localTrackId: string | null;
  localAlbumId: string | null;
}
interface Stats {
  configured: boolean;
  userName: string | null;
  artists: TopArtist[];
  releases: TopRelease[];
  recordings: TopRecording[];
}

const RANGES: { value: Range; label: string }[] = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
  { value: 'all_time', label: 'All time' },
];

function plays(n: number) {
  return `${n.toLocaleString()} ${n === 1 ? 'play' : 'plays'}`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface rounded-lg border border-white/10 p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-3">{title}</h2>
      <ol className="space-y-1">{children}</ol>
    </div>
  );
}

function Row({
  rank,
  primary,
  secondary,
  count,
  to,
}: {
  rank: number;
  primary: string;
  secondary?: string | null;
  count: number;
  to: string | null;
}) {
  const inner = (
    <>
      <span className="w-6 text-right text-xs text-gray-600 tabular-nums shrink-0">{rank}</span>
      <div className="min-w-0 flex-1">
        <p className={`text-sm truncate ${to ? 'text-white' : 'text-gray-300'}`}>{primary}</p>
        {secondary && <p className="text-xs text-gray-500 truncate">{secondary}</p>}
      </div>
      <span className="text-xs text-gray-500 shrink-0 tabular-nums">{plays(count)}</span>
    </>
  );
  const cls = 'flex items-center gap-3 py-1.5 px-2 rounded';
  return to ? (
    <li>
      <Link to={to} className={`${cls} hover:bg-surface-light transition`} title="Open in library">
        {inner}
      </Link>
    </li>
  ) : (
    <li className={cls} title="Not in your library">
      {inner}
    </li>
  );
}

export default function StatsPage() {
  const [range, setRange] = useState<Range>('month');
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listenbrainzStats(range)
      .then((res) => {
        if (!cancelled) setStats(res.data as Stats);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load stats');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-baseline justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold">Listening stats</h1>
          <p className="text-xs text-gray-500">
            Powered by ListenBrainz{stats?.userName ? ` · ${stats.userName}` : ''}
          </p>
        </div>
        <div className="flex gap-1 bg-surface rounded-lg border border-white/10 p-1">
          {RANGES.map((r) => (
            <button
              key={r.value}
              onClick={() => setRange(r.value)}
              className={`px-3 py-1 text-sm rounded transition ${
                range === r.value ? 'bg-accent text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {loading && <p className="text-gray-500 text-sm">Loading…</p>}
      {error && <p className="text-red-400 text-sm">{error}</p>}

      {!loading && stats && !stats.configured && (
        <div className="bg-surface rounded-lg border border-white/10 p-6 text-center">
          <p className="text-gray-300 mb-2">ListenBrainz isn't connected yet.</p>
          <p className="text-sm text-gray-500">
            Connect it in{' '}
            <Link to="/settings" className="text-accent hover:underline">
              Settings → Scrobbling
            </Link>{' '}
            to see your listening stats here.
          </p>
        </div>
      )}

      {!loading && stats?.configured && (
        <>
          {stats.artists.length === 0 &&
          stats.releases.length === 0 &&
          stats.recordings.length === 0 ? (
            <p className="text-gray-500 text-sm">
              No stats for this range yet — ListenBrainz needs a bit of listening history first.
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Section title="Top artists">
                {stats.artists.map((a, i) => (
                  <Row
                    key={`${a.name}-${i}`}
                    rank={i + 1}
                    primary={a.name}
                    count={a.listenCount}
                    to={a.localArtistId ? `/artists/${a.localArtistId}` : null}
                  />
                ))}
              </Section>
              <Section title="Top albums">
                {stats.releases.map((r, i) => (
                  <Row
                    key={`${r.title}-${i}`}
                    rank={i + 1}
                    primary={r.title}
                    secondary={r.artist}
                    count={r.listenCount}
                    to={r.localAlbumId ? `/albums/${r.localAlbumId}` : null}
                  />
                ))}
              </Section>
              <Section title="Top tracks">
                {stats.recordings.map((r, i) => (
                  <Row
                    key={`${r.title}-${i}`}
                    rank={i + 1}
                    primary={r.title}
                    secondary={r.artist}
                    count={r.listenCount}
                    to={r.localAlbumId ? `/albums/${r.localAlbumId}` : null}
                  />
                ))}
              </Section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
