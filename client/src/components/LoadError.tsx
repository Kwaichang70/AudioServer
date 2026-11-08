/**
 * A list that could not be loaded says so, with a way to try again — not
 * "No albums found", which reads like an empty library (U03).
 */
export default function LoadError({
  what,
  message,
  onRetry,
  compact = false,
}: {
  what: string;
  message: string;
  onRetry: () => void;
  compact?: boolean;
}) {
  return (
    <div role="alert" className={compact ? 'text-center my-4' : 'text-center py-20'}>
      <p className="text-gray-300 mb-1">Could not load {what}.</p>
      <p className="text-sm text-gray-500 mb-4">{message}</p>
      <button
        onClick={onRetry}
        className="px-4 py-2 bg-surface-light border border-white/10 rounded hover:border-accent transition text-sm"
      >
        Try again
      </button>
    </div>
  );
}
