import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time errors anywhere below it in the tree and shows a
 * fallback UI instead of letting the whole app crash to a blank screen.
 * Lifecycle hooks (componentDidCatch) only fire on render-time errors —
 * async errors and event handlers must be reported via the API client.
 */
class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
      return (
        <div className="min-h-screen bg-surface-dark text-gray-200 flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-surface rounded-lg p-6 border border-white/10">
            <h1 className="text-xl font-semibold text-accent mb-2">Something went wrong</h1>
            <p className="text-sm text-gray-400 mb-4">
              The app hit an unexpected error. You can try recovering — your queue and current track
              should be preserved.
            </p>
            <pre className="text-xs text-gray-500 bg-surface-dark rounded p-3 overflow-auto max-h-48 mb-4">
              {this.state.error.message}
            </pre>
            <div className="flex gap-2">
              <button
                onClick={this.reset}
                className="px-4 py-2 bg-accent text-white rounded hover:opacity-90 transition"
              >
                Try again
              </button>
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 bg-surface-dark border border-white/10 rounded hover:bg-white/5 transition"
              >
                Reload page
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
export { ErrorBoundary };
