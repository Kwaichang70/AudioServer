import { useEffect, useState, useRef } from 'react';
import { api } from '../api/client.js';

interface Device {
  id: string;
  name: string;
  type: string;
  isOnline: boolean;
  host?: string;
}

const deviceTypeIcons: Record<string, string> = {
  browser: '\u{1F4BB}',
  dlna: '\u{1F50A}',
  sonos: '\u{1F3B5}',
  volumio: '\u{1F3B6}',
};

interface Props {
  selectedDeviceId: string;
  onSelect: (deviceId: string) => void;
}

export default function DeviceSelector({ selectedDeviceId, onSelect }: Props) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const loadDevices = (discover = false) => {
    const fn = discover ? api.discoverDevices : api.getDevices;
    if (discover) setScanning(true);
    fn().then((res) => {
      setDevices(res.data);
      setScanning(false);
    }).catch(() => setScanning(false));
  };

  useEffect(() => {
    loadDevices();
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selected = devices.find((d) => d.id === selectedDeviceId);
  const onlineDevices = devices.filter((d) => d.isOnline);
  const offlineDevices = devices.filter((d) => !d.isOnline);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2 py-1 text-xs rounded bg-surface-dark border border-white/10 hover:border-accent transition"
        title="Select output device"
      >
        <span>{deviceTypeIcons[selected?.type || 'browser'] || '\u{1F50A}'}</span>
        <span className="max-w-[100px] truncate">{selected?.name || 'Browser'}</span>
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-72 bg-surface border border-white/10 rounded-lg shadow-xl z-50">
          <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Output Devices</p>
            <button
              onClick={() => loadDevices(true)}
              disabled={scanning}
              className="text-xs text-accent hover:text-accent-hover transition disabled:opacity-50"
            >
              {scanning ? 'Scanning...' : 'Refresh'}
            </button>
          </div>

          <div className="py-1 max-h-64 overflow-y-auto">
            {onlineDevices.map((device) => (
              <button
                key={device.id}
                onClick={() => { onSelect(device.id); setOpen(false); }}
                className={`w-full text-left px-3 py-2 flex items-center gap-3 transition cursor-pointer
                  ${device.id === selectedDeviceId ? 'bg-accent/20 text-accent' : 'hover:bg-surface-light'}
                `}
              >
                <span className="text-lg">{deviceTypeIcons[device.type] || '\u{1F50A}'}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{device.name}</p>
                  <p className="text-xs text-gray-500">
                    {device.type.toUpperCase()}
                    {device.host && ` \u00B7 ${device.host}`}
                  </p>
                </div>
                {device.id === selectedDeviceId && (
                  <span className="text-accent text-sm">&#10003;</span>
                )}
              </button>
            ))}

            {offlineDevices.length > 0 && (
              <>
                <div className="px-3 py-1 mt-1">
                  <p className="text-xs text-gray-600">Offline</p>
                </div>
                {offlineDevices.map((device) => (
                  <div key={device.id} className="px-3 py-2 flex items-center gap-3 opacity-40">
                    <span className="text-lg">{deviceTypeIcons[device.type] || '\u{1F50A}'}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm truncate">{device.name}</p>
                      <p className="text-xs text-gray-600">{device.type.toUpperCase()} \u00B7 Offline</p>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
