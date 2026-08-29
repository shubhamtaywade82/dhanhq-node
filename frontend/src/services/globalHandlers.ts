import { captureException, log } from './logger';

/**
 * Global browser handlers — install once at app startup (main.tsx).
 *
 * Catches everything React can't:
 *   - window 'error'            → uncaught exceptions, resource load failures
 *   - 'unhandledrejection'      → promises that rejected with no .catch
 *
 * Without these, a stray `undefined.toFixed()` in a promise silently
 * disappears and the operator just sees a frozen chart.
 */

function onWindowError(event: ErrorEvent): void {
  captureException(event.error ?? event.message, {
    source: 'window.onerror',
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  });
}

function onResourceError(event: Event): void {
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === 'IMG' || target.tagName === 'SCRIPT' || target.tagName === 'LINK')) {
    log.warn('Resource failed to load', {
      source: 'resource-error',
      tag: target.tagName,
      src: (target as HTMLImageElement).src || (target as HTMLLinkElement).href,
    });
  }
}

function onUnhandledRejection(event: PromiseRejectionEvent): void {
  captureException(event.reason, { source: 'unhandledrejection' });
}

export function installGlobalHandlers(): void {
  window.addEventListener('error', onWindowError);
  // Resource load errors don't reach window.onerror — capture them via
  // the capture-phase listener on the event target.
  window.addEventListener('error', onResourceError, true);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
}
