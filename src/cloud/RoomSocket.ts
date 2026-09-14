// Agent Communication MCP Server - one WebSocket connection to a room (GET /rooms/{roomName}/ws)
// docs/api.yaml `connectRoomSocket`, `ServerFrame` / `ClientFrame`; docs/cloud-architecture.md §5.4.
//
// The connection buffers every `message` frame it receives (backlog and live) so a later
// wait_for_messages call can return messages that arrived while nobody was waiting.

import WebSocket from 'ws';
import type { IncomingMessage } from 'http';
import { AppError } from '../errors/index.js';
import { parseApiErrorBody, toAppError } from './errors.js';
import type {
  AckFrame,
  ApiErrorBody,
  ApiMessage,
  ReadClientFrame,
  ServerFrame,
  WaitEndFrame,
  WaitStartFrame,
  WaitingFrame,
} from './types.js';

/** The same exclusion the file mode applies to unread messages (MessageService.getUnreadMessages). */
export const SYSTEM_AGENT = 'system';

/** The connection is gone (closed, reset, unanswered). Reconnecting may help. */
export class RoomSocketClosedError extends Error {
  constructor(reason: string) {
    super(`Room WebSocket closed: ${reason}`);
    this.name = 'RoomSocketClosedError';
  }
}

/** The WebSocket could not be established for a non-definitive reason (network, 5xx, 429, ...). */
export class RoomSocketUnavailableError extends Error {
  constructor(reason: string) {
    super(`Room WebSocket unavailable: ${reason}`);
    this.name = 'RoomSocketUnavailableError';
  }
}

/** The server answered a client frame with an `error` frame. */
export class RoomSocketFrameError extends Error {
  constructor(readonly error: ApiErrorBody) {
    super(error.message);
    this.name = 'RoomSocketFrameError';
  }
}

export interface RoomSocketOptions {
  url: string;
  headers: Record<string, string>;
  roomName: string;
  agentName: string;
  connectTimeoutMs?: number;
  /** WebSocket protocol ping interval (not application frames, which would wake the Durable Object). */
  pingIntervalMs?: number;
  maxBufferedMessages?: number;
}

type AckableFrame = WaitStartFrame | WaitEndFrame | (ReadClientFrame & { requestId: string });

/** Messages in `(after, through]` that could not come over this connection and have to be fetched over HTTP. */
export interface FetchRange {
  kind: 'backlog' | 'message';
  after: number;
  through: number;
}

/** An `ack` plus how many `waiting` frames had arrived when it did. */
export interface AckResult {
  ack: AckFrame;
  waitingVersion: number;
}

interface PendingRequest {
  ackFor: AckableFrame['type'];
  requestId: string;
  resolve: (result: AckResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** How long to wait for the `waiting` frame the server sends right after `backlog_end` or a `wait_start` ack. */
const WAITING_FRAME_GRACE_MS = 1000;
const WAITING_HISTORY_SIZE = 32;
const MISSED_PONGS_BEFORE_TERMINATE = 2;

export class RoomSocket {
  readonly roomName: string;
  readonly agentName: string;
  /** `ready.epoch`: changes when the room is deleted and created again. */
  epoch = '';
  /** `ready.lastReadSeq`: the member's read position when the connection was made. */
  initialLastReadSeq = 0;
  /** Highest seq delivered on this connection. `read` frames must not go beyond it. */
  deliveredUpToSeq = 0;

  private buffer: ApiMessage[] = [];
  /** `ready.latestSeq`: the newest message when the connection was made, i.e. where the backlog ends. */
  private readyLatestSeq = 0;
  /** Live messages whose frame did not fit the frame limit (`error` PAYLOAD_TOO_LARGE with `details.seq`). */
  private undeliverable = new Set<number>();
  /**
   * The server stops sending the backlog at the first message that does not fit a frame; `backlog_end.upToSeq`
   * is the last one it sent (docs/api.yaml connectRoomSocket). Everything after it up to `ready.latestSeq`.
   */
  private backlogGap: { after: number; through: number } | undefined;
  private waiting: WaitingFrame | undefined;
  private waitingVersion = 0;
  private waitingHistory: Array<{ version: number; frame: WaitingFrame }> = [];
  private pending: PendingRequest[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly closeListeners = new Set<() => void>();
  private closedError: RoomSocketClosedError | undefined;
  private closing = false;
  private pingTimer: NodeJS.Timeout | undefined;
  private missedPongs = 0;
  private readonly maxBufferedMessages: number;

  private constructor(
    private readonly ws: WebSocket,
    options: RoomSocketOptions,
  ) {
    this.roomName = options.roomName;
    this.agentName = options.agentName;
    this.maxBufferedMessages = options.maxBufferedMessages ?? 10000;
  }

  /**
   * Connects and resolves once the backlog has been received (`backlog_end`, then the `waiting` frame).
   * Rejects with an AppError for definitive HTTP errors (400/401/403/404) and with
   * {@link RoomSocketUnavailableError} for everything that a fallback could get around.
   */
  static open(options: RoomSocketOptions): Promise<RoomSocket> {
    const connectTimeoutMs = options.connectTimeoutMs ?? 10000;
    const ws = new WebSocket(options.url, {
      headers: options.headers,
      handshakeTimeout: connectTimeoutMs,
      perMessageDeflate: false,
    });
    const socket = new RoomSocket(ws, options);

    return new Promise<RoomSocket>((resolve, reject) => {
      let settled = false;
      let backlogReceived = false;
      let graceTimer: NodeJS.Timeout | undefined;
      const overallTimer = setTimeout(
        () => fail(new RoomSocketUnavailableError(`no backlog within ${connectTimeoutMs}ms`)),
        connectTimeoutMs,
      );

      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(overallTimer);
        clearTimeout(graceTimer);
        socket.startKeepalive(options.pingIntervalMs ?? 30000);
        resolve(socket);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(overallTimer);
        clearTimeout(graceTimer);
        socket.terminate();
        reject(error);
      };

      // Idle connections are kept for the whole process lifetime; they must not keep it alive
      // after the MCP client goes away.
      ws.on('upgrade', (response: IncomingMessage) => response.socket.unref());

      ws.on('unexpected-response', (_request, response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', () => fail(new RoomSocketUnavailableError('upgrade response failed')));
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          const body = parseApiErrorBody(status, Buffer.concat(chunks).toString('utf8'));
          const definitive = status >= 400 && status < 500 && status !== 408 && status !== 429;
          fail(
            definitive
              ? toAppError(status, body, { roomName: options.roomName, agentName: options.agentName })
              : new RoomSocketUnavailableError(`HTTP ${status} ${body.code}: ${body.message}`),
          );
        });
      });

      ws.on('error', (error: Error) => fail(new RoomSocketUnavailableError(error.message)));

      ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
        const frame = socket.handleFrame(data, isBinary);
        if (settled || !frame) return;
        if (frame.type === 'backlog_end') {
          backlogReceived = true;
          graceTimer = setTimeout(finish, WAITING_FRAME_GRACE_MS);
        } else if (frame.type === 'waiting' && backlogReceived) {
          finish();
        }
      });

      ws.on('pong', () => {
        socket.missedPongs = 0;
      });

      ws.on('close', (code: number, reason: Buffer) => {
        socket.handleClose(code, reason.toString());
        fail(new RoomSocketUnavailableError(`closed before the backlog was received (${code})`));
      });
    });
  }

  isOpen(): boolean {
    return !this.closedError && !this.closing && this.ws.readyState === WebSocket.OPEN;
  }

  /** Called on every received frame and on close. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: () => void): void {
    if (this.closedError) listener();
    else this.closeListeners.add(listener);
  }

  /**
   * Sends a frame that the server acknowledges with an `ack` frame and waits for that ack. Without an answer in
   * `timeoutMs` the connection is treated as dead and terminated, unless `terminateOnTimeout` is false.
   */
  request(frame: AckableFrame, timeoutMs: number, terminateOnTimeout = true): Promise<AckResult> {
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise<AckResult>((resolve, reject) => {
      const entry: PendingRequest = {
        ackFor: frame.type,
        requestId: frame.requestId,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removePending(entry);
          reject(new RoomSocketClosedError(`no ack for ${frame.type} within ${timeoutMs}ms`));
          // An unanswered frame means the connection is unusable (e.g. a half-open TCP connection).
          if (terminateOnTimeout) this.terminate();
        }, timeoutMs),
      };
      this.pending.push(entry);
      const failed = (error: Error): void => {
        this.removePending(entry);
        clearTimeout(entry.timer);
        reject(new RoomSocketClosedError(error.message));
      };
      try {
        this.ws.send(JSON.stringify(frame), (error?: Error) => {
          if (error) failed(error);
        });
      } catch (error) {
        failed(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Unread messages: newer than `cursor`, written by someone other than the agent and `system`. */
  unreadMessages(agentName: string, cursor: number): ApiMessage[] {
    return this.buffer.filter(
      (message) => message.seq > cursor && message.agentName !== agentName && message.agentName !== SYSTEM_AGENT,
    );
  }

  highestBufferedSeq(): number {
    return this.buffer.length > 0 ? this.buffer[this.buffer.length - 1]!.seq : 0;
  }

  /** What has to be fetched over HTTP before the messages newer than `cursor` are complete. */
  pendingFetches(cursor: number): FetchRange[] {
    const ranges: FetchRange[] = [];
    if (this.backlogGap && this.backlogGap.through > cursor) {
      ranges.push({ kind: 'backlog', after: Math.max(this.backlogGap.after, cursor), through: this.backlogGap.through });
    }
    for (const seq of [...this.undeliverable].sort((a, b) => a - b)) {
      if (seq > cursor) ranges.push({ kind: 'message', after: seq - 1, through: seq });
    }
    return ranges;
  }

  /** A range from {@link pendingFetches} was fetched successfully. */
  resolveFetch(range: FetchRange): void {
    if (range.kind === 'message') this.undeliverable.delete(range.through);
    else if (this.backlogGap && this.backlogGap.through === range.through) this.backlogGap = undefined;
  }

  consumeThrough(seq: number): void {
    this.buffer = this.buffer.filter((message) => message.seq > seq);
    for (const pending of [...this.undeliverable]) {
      if (pending <= seq) this.undeliverable.delete(pending);
    }
    if (this.backlogGap && this.backlogGap.through <= seq) this.backlogGap = undefined;
    else if (this.backlogGap) this.backlogGap = { after: Math.max(this.backlogGap.after, seq), through: this.backlogGap.through };
  }

  /** The latest `waiting` frame (the server re-broadcasts it whenever anyone starts or stops waiting). */
  waitingSnapshot(): WaitingFrame | undefined {
    return this.waiting;
  }

  /**
   * The first `waiting` frame received after `version` (see {@link AckResult.waitingVersion}). The Room DO
   * broadcasts it in the same synchronous step as the `wait_start` ack, so it is the state when the wait began.
   * Falls back to the latest frame if none arrives within the grace period.
   */
  firstWaitingAfter(version: number): Promise<WaitingFrame | undefined> {
    const find = (): WaitingFrame | undefined => this.waitingHistory.find((entry) => entry.version > version)?.frame;
    const found = find();
    if (found) return Promise.resolve(found);
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        unsubscribe();
        resolve(find() ?? this.waiting);
      };
      const timer = setTimeout(done, WAITING_FRAME_GRACE_MS);
      const unsubscribe = this.subscribe(() => {
        if (find() || this.closedError) done();
      });
    });
  }

  /**
   * Resolves `'messages'` as soon as there is something to return, `'timeout'` at `deadline`.
   * Frames that arrive in the same turn are batched. Rejects with {@link RoomSocketClosedError}.
   */
  waitForUnread(agentName: string, cursor: number, deadline: number): Promise<'messages' | 'timeout'> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let batch: NodeJS.Immediate | undefined;
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (batch) clearImmediate(batch);
        unsubscribe();
        action();
      };
      const check = (): void => {
        if (this.closedError) {
          const error = this.closedError;
          settle(() => reject(error));
          return;
        }
        const ready = this.unreadMessages(agentName, cursor).length > 0 || this.pendingFetches(cursor).length > 0;
        if (ready && !batch) batch = setImmediate(() => settle(() => resolve('messages')));
      };
      const arm = (): void => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          settle(() => resolve('timeout'));
          return;
        }
        timer = setTimeout(arm, remaining);
      };
      const unsubscribe = this.subscribe(check);
      check();
      if (!settled) arm();
    });
  }

  /** Closes the connection gracefully (the server then drops the waits this connection declared). */
  close(code = 1000, reason = ''): void {
    if (this.closedError || this.closing) return;
    this.closing = true;
    clearInterval(this.pingTimer);
    try {
      if (this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate();
      else this.ws.close(code, reason);
    } catch {
      this.ws.terminate();
    }
  }

  /** {@link close} and wait for the close handshake, but no longer than `timeoutMs`. */
  closeAndWait(code: number, reason: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      this.onClose(done);
      this.close(code, reason);
    });
  }

  terminate(): void {
    clearInterval(this.pingTimer);
    this.closing = true;
    try {
      this.ws.terminate();
    } catch {
      // Already closed.
    }
  }

  /* ---------------------------------------------------------------------
   * internals
   * ------------------------------------------------------------------ */

  private startKeepalive(intervalMs: number): void {
    if (intervalMs <= 0) return;
    this.pingTimer = setInterval(() => {
      if (this.missedPongs >= MISSED_PONGS_BEFORE_TERMINATE) {
        this.terminate();
        return;
      }
      this.missedPongs += 1;
      try {
        this.ws.ping();
      } catch {
        // The close handler takes care of a dead connection.
      }
    }, intervalMs);
    this.pingTimer.unref();
  }

  private handleFrame(data: WebSocket.RawData, isBinary: boolean): ServerFrame | undefined {
    // Any frame proves the connection is alive.
    this.missedPongs = 0;
    if (isBinary) return undefined;
    let frame: ServerFrame;
    try {
      frame = JSON.parse(data.toString()) as ServerFrame;
    } catch {
      return undefined;
    }
    if (!frame || typeof frame !== 'object') return undefined;

    switch (frame.type) {
      case 'ready':
        this.epoch = frame.epoch;
        this.initialLastReadSeq = frame.lastReadSeq;
        this.readyLatestSeq = frame.latestSeq;
        break;
      case 'backlog_end':
        this.endBacklog(frame.upToSeq);
        break;
      case 'message':
        this.acceptMessage(frame.message);
        break;
      case 'waiting':
        this.waiting = frame;
        this.waitingVersion += 1;
        this.waitingHistory.push({ version: this.waitingVersion, frame });
        if (this.waitingHistory.length > WAITING_HISTORY_SIZE) this.waitingHistory.shift();
        break;
      case 'ack':
        this.settleAck(frame);
        break;
      case 'error':
        this.handleErrorFrame(frame.error);
        break;
      default:
        // `presence` carries nothing a waiting call needs.
        break;
    }
    this.notify();
    return frame;
  }

  /** A message that did not fit a frame during the backlog truncates it: the rest comes over HTTP. */
  private endBacklog(upToSeq: number): void {
    const cut = [...this.undeliverable].filter((seq) => seq > upToSeq && seq <= this.readyLatestSeq);
    if (cut.length === 0) return;
    this.backlogGap = { after: upToSeq, through: this.readyLatestSeq };
    for (const seq of cut) this.undeliverable.delete(seq);
  }

  private acceptMessage(message: ApiMessage | undefined): void {
    if (!message || typeof message.seq !== 'number' || message.seq <= this.deliveredUpToSeq) return;
    this.deliveredUpToSeq = message.seq;
    this.buffer.push(message);
    if (this.buffer.length > this.maxBufferedMessages) {
      this.buffer.splice(0, this.buffer.length - this.maxBufferedMessages);
    }
  }

  private settleAck(frame: AckFrame): void {
    const index = this.pending.findIndex(
      (entry) => entry.ackFor === frame.ackFor && (frame.requestId === undefined || entry.requestId === frame.requestId),
    );
    if (index < 0) return;
    const [entry] = this.pending.splice(index, 1);
    clearTimeout(entry!.timer);
    entry!.resolve({ ack: frame, waitingVersion: this.waitingVersion });
  }

  private handleErrorFrame(error: ApiErrorBody | undefined): void {
    if (!error) return;
    const seq = error.details?.seq;
    if (error.code === 'PAYLOAD_TOO_LARGE' && typeof seq === 'number') {
      // Not an answer to a client frame: a message did not fit the frame limit and has to be fetched over HTTP.
      this.undeliverable.add(seq);
      return;
    }

    // Errors about a specific wait carry `details.requestId`; the others answer the oldest pending frame
    // (the Durable Object processes the frames of one connection in order).
    const requestId = typeof error.details?.requestId === 'string' ? error.details.requestId : undefined;
    const index = requestId !== undefined ? this.pending.findIndex((entry) => entry.requestId === requestId) : 0;
    const entry = index >= 0 ? this.pending.splice(index, 1)[0] : undefined;

    if (error.code === 'ROOM_NOT_FOUND') {
      // The room was deleted or recreated under this connection: only a new connection can tell which.
      const closed = new RoomSocketClosedError(error.message);
      if (entry) {
        clearTimeout(entry.timer);
        entry.reject(closed);
      }
      this.terminate();
      return;
    }
    if (entry) {
      clearTimeout(entry.timer);
      entry.reject(new RoomSocketFrameError(error));
    }
  }

  private handleClose(code: number, reason: string): void {
    if (this.closedError) return;
    this.closedError = new RoomSocketClosedError(`code ${code}${reason ? ` (${reason})` : ''}`);
    this.closing = true;
    clearInterval(this.pingTimer);
    for (const entry of this.pending.splice(0)) {
      clearTimeout(entry.timer);
      entry.reject(this.closedError);
    }
    this.notify();
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
  }

  private removePending(entry: PendingRequest): void {
    const index = this.pending.indexOf(entry);
    if (index >= 0) this.pending.splice(index, 1);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** HTTP status the same error code has on the REST endpoints (error frames carry no status). */
const FRAME_ERROR_STATUS: Record<string, number> = {
  UNAUTHORIZED: 401,
  AGENT_NOT_IN_ROOM: 403,
  ROOM_NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  STORAGE_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

/** Maps the failure of a client frame to the AppError the tool call should surface. */
export function frameErrorToAppError(error: unknown, context: { roomName: string; agentName: string }): unknown {
  if (error instanceof RoomSocketFrameError) {
    return toAppError(FRAME_ERROR_STATUS[error.error.code] ?? 400, error.error, context);
  }
  return error;
}

export function isDefinitiveAppError(error: unknown): error is AppError {
  return (
    error instanceof AppError &&
    error.statusCode >= 400 &&
    error.statusCode < 500 &&
    error.statusCode !== 408 &&
    error.statusCode !== 429
  );
}
