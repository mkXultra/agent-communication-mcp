import { WaitCancelledError } from '../../errors/AppError';
import { linkAbortSignals } from '../../utils/abort';

interface OpenEndedWait {
  abort: (reason: unknown) => void;
  done: Promise<void>;
}

export interface WaitTurn {
  /** Aborts with the caller's signal, or when a newer wait for the same key takes over. */
  signal: AbortSignal;
  /** Resolves once the wait this one took over from (and the ones that one took over from) has finished. */
  previousDone: Promise<void>;
  /** Call when the wait is over, whatever the outcome. */
  end(): void;
}

/**
 * wait_for_messages without a time limit (`timeout: 0`), at most one per room x agent. A newer wait for the same room and
 * agent ends the one in progress: its client has most likely given up on it (a tool call timeout that sent no
 * notifications/cancelled), and it would otherwise take the messages the newer call is waiting for.
 */
export class OpenEndedWaits {
  private readonly waits = new Map<string, OpenEndedWait>();

  start(key: string, openEnded: boolean, signal?: AbortSignal): WaitTurn {
    const previous = this.waits.get(key);
    const link = linkAbortSignals(signal);
    let finished!: () => void;
    const wait: OpenEndedWait = { abort: link.abort, done: new Promise<void>((resolve) => { finished = resolve; }) };
    if (openEnded) this.waits.set(key, wait);
    previous?.abort(new WaitCancelledError('a newer wait_for_messages call for the same agent and room took over'));
    const previousDone = previous?.done ?? Promise.resolve();

    return {
      signal: link.signal,
      previousDone,
      end: () => {
        if (this.waits.get(key) === wait) this.waits.delete(key);
        link.dispose();
        // A wait that takes over from this one also waits for the one this one took over from.
        void previousDone.then(finished);
      },
    };
  }
}
