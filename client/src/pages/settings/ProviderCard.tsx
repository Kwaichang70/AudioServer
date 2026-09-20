import type { ProviderStatus } from './shared.js';

export default function ProviderCard({
  name,
  icon,
  status,
  onConnect,
  onDisconnect,
  envVars,
  note,
}: {
  name: string;
  icon: string;
  status?: ProviderStatus;
  onConnect: () => void;
  onDisconnect: () => void;
  envVars: string[];
  note?: string;
}) {
  const configured = status?.configured ?? status?.available ?? false;
  const authenticated = status?.authenticated ?? false;

  return (
    <div className="bg-surface-light rounded-lg p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl">{icon}</span>
          <div>
            <p className="text-sm font-medium">{name}</p>
            <p className="text-xs text-gray-500">
              {!configured
                ? `Not configured \u2014 set ${envVars.join(' and ')} in .env`
                : authenticated
                  ? 'Connected'
                  : 'Not connected'}
            </p>
            {note && <p className="text-xs text-amber-400 mt-1">{note}</p>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {authenticated && (
            <span className="w-2 h-2 rounded-full bg-green-500" title="Connected" />
          )}
          {configured && !authenticated && (
            <button
              onClick={onConnect}
              className="px-4 py-1.5 text-sm bg-accent rounded hover:bg-accent-hover transition"
            >
              Connect
            </button>
          )}
          {authenticated && (
            <button
              onClick={onDisconnect}
              className="px-3 py-1.5 text-xs text-gray-500 hover:text-red-400 transition"
            >
              Disconnect
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
