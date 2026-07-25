import { useEffect, useState, useRef } from 'react';
import { api } from '../api/client.js';
import { useAudioContext, useProgress } from '../context/AudioContext.js';

interface SyncedLine {
  time: number;
  text: string;
}

interface LyricsData {
  plain: string | null;
  synced: SyncedLine[] | null;
  source: string;
}

export default function LyricsDisplay() {
  const { currentTrack } = useAudioContext();
  const currentTrackId = currentTrack?.id;
  const { currentTime } = useProgress();
  const [lyrics, setLyrics] = useState<LyricsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const activeRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    if (!currentTrackId) {
      setLyrics(null);
      setLoading(false);
      setError(false);
      return;
    }
    // Don't fetch for streaming tracks without local IDs
    if (currentTrackId.startsWith('spotify:')) {
      setLyrics(null);
      setLoading(false);
      setError(false);
      return;
    }

    setLoading(true);
    setError(false);
    const trackId = currentTrackId.replace('tidal:', '').replace('qobuz:', '');
    api
      .getLyrics(trackId)
      .then((res) => {
        if (!cancelled) setLyrics(res.data);
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
          setLyrics(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [currentTrackId]);

  // Auto-scroll to active line
  useEffect(() => {
    if (activeRef.current && containerRef.current) {
      const container = containerRef.current;
      const active = activeRef.current;
      const containerRect = container.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      const offset = activeRect.top - containerRect.top - containerRect.height / 3;
      container.scrollTo({ top: container.scrollTop + offset, behavior: 'smooth' });
    }
  }, [currentTime]);

  if (loading) return <p className="text-xs text-gray-500">Loading lyrics...</p>;
  if (error || !lyrics) return <p className="text-xs text-gray-600">No lyrics available</p>;

  // Synced lyrics with karaoke-style highlighting
  if (lyrics.synced && lyrics.synced.length > 0) {
    const activeLine = findActiveLine(lyrics.synced, currentTime);

    return (
      <div ref={containerRef} className="max-h-64 overflow-y-auto scrollbar-thin pr-2">
        {lyrics.synced.map((line, i) => {
          const isActive = i === activeLine;
          return (
            <div
              key={i}
              ref={isActive ? activeRef : undefined}
              className={`py-1 transition-all duration-300 ${
                isActive
                  ? 'text-white text-base font-medium'
                  : i < activeLine
                    ? 'text-gray-600 text-sm'
                    : 'text-gray-500 text-sm'
              }`}
            >
              {line.text}
            </div>
          );
        })}
      </div>
    );
  }

  // Plain lyrics
  if (lyrics.plain) {
    return (
      <div className="max-h-64 overflow-y-auto text-sm text-gray-400 whitespace-pre-wrap leading-relaxed pr-2">
        {lyrics.plain}
      </div>
    );
  }

  return <p className="text-xs text-gray-600">No lyrics available</p>;
}

function findActiveLine(lines: SyncedLine[], currentTime: number): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (currentTime >= lines[i].time) return i;
  }
  return 0;
}
