import { useSyncExternalStore } from 'react';

/**
 * Service worker registration and the update flow (V08.1).
 *
 * A new worker never takes over on its own: it installs, waits, and the app
 * shows "update ready". Only when the person reloads (or taps the banner)
 * does the app tell the waiting worker to skip waiting; the resulting
 * controllerchange reloads the page exactly once. That is what keeps a
 * release from swapping assets under a running page.
 */

interface SwState {
  /** A newer build is installed and waiting to take over. */
  updateReady: boolean;
  /** Build id of the worker in control, when it answered. */
  buildId: string | null;
}

let state: SwState = { updateReady: false, buildId: null };
let waitingRegistration: ServiceWorkerRegistration | null = null;
const listeners = new Set<() => void>();

function setState(patch: Partial<SwState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useServiceWorkerState(): SwState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

function trackWaiting(registration: ServiceWorkerRegistration): void {
  if (registration.waiting && navigator.serviceWorker.controller) {
    waitingRegistration = registration;
    setState({ updateReady: true });
  }
}

async function askBuildId(): Promise<void> {
  const controller = navigator.serviceWorker.controller;
  if (!controller) return;
  const channel = new MessageChannel();
  channel.port1.onmessage = (event) => {
    const id = (event.data as { buildId?: string } | null)?.buildId;
    if (id) setState({ buildId: id });
  };
  controller.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
}

export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        trackWaiting(registration);
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed') trackWaiting(registration);
          });
        });
        // Look for a new release now and then; the browser also checks on navigation.
        window.setInterval(() => registration.update().catch(() => {}), 60 * 60 * 1000);
        askBuildId().catch(() => {});
      })
      .catch(() => {
        // No worker (private mode, unsupported): the app works without it.
      });

    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
  });
}

/** The person accepted the update: let the waiting worker take over (reloads via controllerchange). */
export function applyServiceWorkerUpdate(): void {
  const waiting = waitingRegistration?.waiting;
  if (!waiting) {
    window.location.reload();
    return;
  }
  waiting.postMessage({ type: 'SKIP_WAITING' });
}

/** Test hook. */
export function resetServiceWorkerStateForTests(): void {
  state = { updateReady: false, buildId: null };
  waitingRegistration = null;
}

export function markUpdateReadyForTests(registration: ServiceWorkerRegistration | null): void {
  waitingRegistration = registration;
  setState({ updateReady: true });
}
