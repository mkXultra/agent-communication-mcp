// Agent Communication MCP Server - waiting that an AbortSignal can end early
// wait_for_messages ends when the MCP request is cancelled, when the server shuts down, or when a newer wait for the
// same agent and room takes over from one without a time limit.

/** Resolves after `ms`, or as soon as `signal` aborts (the caller checks `signal.aborted`). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Resolves when `promise` settles or `signal` aborts, whichever comes first. `promise` itself goes on. */
export function settledOrAborted(promise: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      signal?.removeEventListener('abort', done);
      resolve();
    };
    signal?.addEventListener('abort', done, { once: true });
    promise.then(done, done);
  });
}

/**
 * A controller that aborts, with the same reason, as soon as one of `signals` does (`AbortSignal.any` needs
 * Node.js 20.3). Call `dispose` when done so that longer-lived signals do not keep the listeners.
 */
export function linkAbortSignals(...signals: Array<AbortSignal | undefined>): { signal: AbortSignal; abort: (reason?: unknown) => void; dispose: () => void } {
  const controller = new AbortController();
  const sources = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const listeners = new Map<AbortSignal, () => void>();
  for (const source of sources) {
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    const listener = (): void => controller.abort(source.reason);
    listeners.set(source, listener);
    source.addEventListener('abort', listener, { once: true });
  }
  return {
    signal: controller.signal,
    abort: (reason?: unknown) => controller.abort(reason),
    dispose: () => {
      for (const [source, listener] of listeners) source.removeEventListener('abort', listener);
      listeners.clear();
    },
  };
}
