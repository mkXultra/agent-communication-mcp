// Agent Communication MCP Server - fetch for the cloud API
//
// The fetch built into Node 26 (undici 8) checks an idle keep-alive connection before it writes the next request on
// it, from an unref'd setImmediate. An unref'd immediate does not stop the event loop from blocking, so when nothing
// else is due (the request was started from a timer callback, or after a WebSocket frame, with only long timers
// pending) the request is not written until an unrelated timer or I/O event wakes the loop: seconds, up to the
// request timeout. `cloudFetch` keeps a ref'd timer ticking while the request is dispatched, so the loop turns and
// the check runs at once. Node 18-22 (undici 5-6) do not make that check and are not affected.

/** How often the loop is woken while a request is being dispatched. */
const DISPATCH_TICK_MS = 1;
/** The check is scheduled while fetch() dispatches the request; the loop only has to turn in the first moments. */
const DISPATCH_WINDOW_MS = 200;

export async function cloudFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const started = Date.now();
  const ticker = setInterval(() => {
    if (Date.now() - started >= DISPATCH_WINDOW_MS) clearInterval(ticker);
  }, DISPATCH_TICK_MS);
  try {
    return await fetch(input, init);
  } finally {
    clearInterval(ticker);
  }
}
