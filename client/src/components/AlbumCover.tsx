import { useState } from 'react';
import { api } from '../api/client.js';

interface Props {
  albumId: string;
  title: string;
  artistName?: string;
  coverUrl?: string; // For Spotify/Qobuz external covers
  size?: 'sm' | 'md' | 'lg';
}

const colors = [
  'from-violet-900 to-indigo-800',
  'from-rose-900 to-pink-800',
  'from-emerald-900 to-teal-800',
  'from-amber-900 to-orange-800',
  'from-sky-900 to-cyan-800',
  'from-fuchsia-900 to-purple-800',
];

function getColorFromTitle(title: string): string {
  let hash = 0;
  for (let i = 0; i < title.length; i++) hash = ((hash << 5) - hash + title.charCodeAt(i)) | 0;
  return colors[Math.abs(hash) % colors.length];
}

export default function AlbumCover({ albumId, title, artistName, coverUrl, size = 'md' }: Props) {
  const [failed, setFailed] = useState(false);

  const src = coverUrl || api.getAlbumCoverUrl(albumId);
  const gradient = getColorFromTitle(title);
  const initial = title.charAt(0).toUpperCase();

  if (failed) {
    return (
      <div className={`aspect-square rounded bg-gradient-to-br ${gradient} flex flex-col items-center justify-center`}>
        <span className={size === 'sm' ? 'text-2xl' : size === 'lg' ? 'text-6xl' : 'text-4xl'}>{initial}</span>
        {size !== 'sm' && artistName && (
          <span className="text-xs text-white/40 mt-1 px-2 truncate max-w-full">{artistName}</span>
        )}
      </div>
    );
  }

  return (
    <div className="aspect-square rounded overflow-hidden bg-surface-dark">
      <img
        src={src}
        alt={title}
        className="w-full h-full object-cover"
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </div>
  );
}
