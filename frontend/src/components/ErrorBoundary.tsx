import { Component, type ReactNode, type ErrorInfo } from 'react';
import { captureException } from '../services/logger';

interface Props {
  children: ReactNode;
  /** Optional label for the wrapped region (e.g. "AgentConsole"). */
  region?: string;
}

interface State {
  hasError: boolean;
  message: string;
}

/**
 * React Error Boundary — catches render-phase exceptions in any
 * subtree, reports them (with componentStack) to the backend log
 * ingest, and shows an inline recovery card instead of a dead screen.
 *
 * The control plane must survive a broken widget: a crashing Greeks
 * panel should never take the kill-switch UI down with it.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(err: Error): State {
    return { hasError: true, message: err.message };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    captureException(error, {
      source: 'ErrorBoundary',
      region: this.props.region ?? 'app',
      componentStack: errorInfo.componentStack,
    });
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-center">
        <p className="text-sm font-semibold text-red-400">
          {this.props.region ? `${this.props.region} crashed` : 'This panel crashed'}
        </p>
        <p className="mt-1 text-xs text-slate-400">{this.state.message}</p>
        <p className="mt-1 text-xs text-slate-500">The error was reported. Other panels keep running.</p>
        <button
          type="button"
          onClick={() => this.setState({ hasError: false, message: '' })}
          className="mt-3 rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800"
        >
          Retry
        </button>
      </div>
    );
  }
}

export default ErrorBoundary;
