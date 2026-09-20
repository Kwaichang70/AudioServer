import { api } from '../../api/client.js';
import { useToast } from '../../components/Toast.js';

/** Spotify through Librespot, to any output (R02.4: moved out of SettingsPage). */
export default function LibrespotSection() {
  const { toast } = useToast();

  return (
    <section className="mb-10">
      <h3 className="text-lg font-semibold mb-4 text-gray-300">
        Librespot (Spotify to any device)
      </h3>
      <div className="bg-surface-light rounded-lg p-4 space-y-3">
        <p className="text-xs text-gray-500">
          Librespot acts as a Spotify Connect receiver on this server, decoding audio and streaming
          it to any DLNA/Volumio device. Requires librespot + ffmpeg installed.
        </p>
        <p className="text-xs text-gray-500">
          Install: <code className="text-gray-400">cargo install librespot</code> and{' '}
          <code className="text-gray-400">ffmpeg</code>
        </p>
        <button
          onClick={async () => {
            const res = await api.librespotStatus();
            const d = res.data;
            toast(
              d.librespotInstalled
                ? `Librespot: ${d.isRunning ? 'running' : 'stopped'}, ffmpeg: ${d.ffmpegInstalled ? 'yes' : 'no'}`
                : 'Librespot not installed',
              d.librespotInstalled ? 'info' : 'error',
            );
          }}
          className="px-3 py-1.5 text-sm bg-surface-dark border border-white/10 rounded hover:border-accent transition"
        >
          Check Status
        </button>
      </div>
    </section>
  );
}
