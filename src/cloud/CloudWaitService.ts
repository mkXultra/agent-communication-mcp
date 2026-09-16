// Agent Communication MCP Server - wait_for_messages in cloud mode
// docs/cloud-architecture.md §5.4 / D6: WebSocket is the default, long polling only a fallback.
//
// - One WebSocket per room x agent, kept for the lifetime of the process and reconnected lazily
//   by the next call after it drops.
// - Every call declares its wait with `wait_start` / `wait_end` and returns when a message from
//   another agent arrives (live, or buffered since the previous call), or when the timeout passes. The server's notices
//   (agentName `system`, api 0.8.0, D18) count as such a message on every path, as they do for the API's `excludeSelf`.
// - `timeout: 0` waits until a message arrives (§5.4): the wait is declared again (same requestId) before the server
//   drops it, a dropped connection is made again, and a wait that has to long poll goes back to the WebSocket after
//   each cooldown. Failures another attempt may get past are retried; the others (4xx) end the wait.
// - A call ends without a result, consuming nothing, when its signal aborts (the MCP request was cancelled, the server
//   shuts down) or when a newer call for the same room x agent takes over from one without a time limit.
// - `mentionsOnly` returns only messages whose `mentions` (extracted by the server) name the agent, and the server's
//   notices, which the API's `mentionsOnly` never filters out either. The others are read as the wait passes over them,
//   the way a long poll with `mentionsOnly` moves `nextCursor` and the read position past
//   them: a long poll passes the parameter on; over the WebSocket, which delivers every message, the client consumes
//   them, moves its cursor and keeps waiting. A call that ends without a result still leaves unread what it would have
//   returned; what it passed over stays read. The server read position of what the WebSocket passed over belongs to the
//   call, not to the connection: it is stored when the call ends, however it ends and over whichever connection is left
//   (over HTTP when none can acknowledge it), unless a long poll of the same call has already stored it.
//   Over HTTP it can race a clear or a re-created room (markReadOverHttp, https://github.com/mkXultra/agora/issues/5).
// - The client keeps its own read cursor per room x agent, taken before the agent's first send: from the join
//   response, or from the member list when the agent joined in an earlier process. Before api 0.4.2 agora moved
//   `last_read_seq` when the agent *sent*, which hid messages that arrived before the agent's own message (the file
//   mode only moves the read position in wait_for_messages); the cursor keeps them unread with such a server too.
// - A cursor always carries the epoch of the room it belongs to (seq restarts at 1 when a room is deleted and
//   created again), taken from the same response as the read position (join, member list, `ready` frame, long
//   poll); a cursor from another epoch is never used as a starting point.
// - Every request made for a wait gets its timeout when it starts, from the time left: it may run a little past the
//   deadline, but nothing made for a wait runs past `deadline + MIN_ROUND_TRIP_MS` (the hard stop), and no request
//   is started after that.

import { randomUUID } from 'crypto';
import { AgentNotInRoomError, AppError, WaitCancelledError } from '../errors/index.js';
import { WAIT_CONSTANTS } from '../features/messaging/constants.js';
import { OpenEndedWaits } from '../features/messaging/OpenEndedWaits.js';
import { settledOrAborted, sleep } from '../utils/abort.js';
import { createLogger } from '../utils/logger.js';
import { CloudApiClient } from './CloudApiClient.js';
import { passesMentionsOnly, toWaitResult, type WaitForMessagesResult } from './mappers.js';
import {
  RoomSocket,
  type AckResult,
  type FetchRange,
  RoomSocketClosedError,
  RoomSocketUnavailableError,
  frameErrorToAppError,
  isDefinitiveAppError,
} from './RoomSocket.js';
import type { ApiMemberList, ApiMessage, ApiMessageList } from './types.js';

export interface CloudWaitServiceOptions {
  connectTimeoutMs?: number;
  ackTimeoutMs?: number;
  pingIntervalMs?: number;
  /** After the WebSocket could not be established, use long polling for this long before trying again. */
  webSocketRetryCooldownMs?: number;
  /**
   * How long the server keeps a declared wait (agora's WAIT_TIMEOUT_MAX_SECONDS; the API allows at most 300). A wait that
   * goes on longer is declared again shortly before this runs out. Only a server configured below 300 needs less.
   */
  serverWaitMaxSeconds?: number;
}

export interface ReadCursor {
  seq: number;
  /** Epoch of the room the seq belongs to (seq restarts at 1 when a room is deleted and created again). */
  epoch: string;
}

/** docs/api.yaml `getMessages.wait`: at most 30 seconds (values above are a 400). */
const LONG_POLL_MAX_SECONDS = 30;
/** docs/api.yaml `WaitStartFrame.timeoutSeconds`: the server keeps a wait at most 300 seconds. */
const WAIT_START_MAX_SECONDS = 300;
/** A wait that goes on is declared again this long before the server drops it (at most a quarter of the declared time). */
const REDECLARE_MARGIN_MS = 10000;
/** A long-polling round of a wait without a time limit lasts at least this long, however soon the WebSocket may be tried. */
const MIN_LONG_POLL_ROUND_MS = 1000;
/** Pause before a wait without a time limit tries again after a failure; doubles with each failure in a row. */
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 30000;
const PAGE_LIMIT = 1000;
const MAX_RECONNECTS_PER_CALL = 1;
const CLOSE_GRACE_MS = 1000;
/** How far past the deadline a round trip that is already under way may take. */
const DEADLINE_GRACE_MS = 1000;
/** No round trip gets less than this before the deadline; nothing for a wait runs past `deadline + MIN_ROUND_TRIP_MS`. */
const MIN_ROUND_TRIP_MS = 3000;
/** A long poll request may take this much longer than its `wait` before it is abandoned. */
const LONG_POLL_GRACE_MS = 2000;
/** `wait_end` / `read` once the result is known: the answer does not depend on them. */
const FINISH_TIMEOUT_MS = 2000;
const HTTP_TIMEOUT_MS = 30000;

const logger = createLogger('agent-communication-mcp:cloud');

export function socketKey(roomName: string, agentName: string): string {
  return `${roomName}\u0000${agentName}`;
}

/** The member's server-side read position with the epoch of the room it belongs to, or `undefined` for a non-member. */
function cursorFromMembers(list: ApiMemberList, agentName: string): ReadCursor | undefined {
  const member = list.members.find((candidate) => candidate.agentName === agentName);
  return typeof member?.lastReadSeq === 'number' ? { seq: member.lastReadSeq, epoch: list.epoch } : undefined;
}

/** One wait_for_messages call, across the connections and long polls it uses. */
interface WaitCall {
  key: string;
  roomName: string;
  agentName: string;
  /** 0: no time limit. */
  timeoutMs: number;
  /** `Infinity` without a time limit. */
  deadline: number;
  /** Return only messages that mention the agent. */
  mentionsOnly: boolean;
  /**
   * mentionsOnly: the client cursor after the messages this call passed over on a WebSocket, with the epoch of their
   * room, while the server has not stored a read position that covers it. Kept across the connections and long polls
   * of the call; stored at the latest when the call ends (storePassedOver).
   */
  passedOver: ReadCursor | undefined;
  signal: AbortSignal;
  /** The other agents waiting when the wait began: what the first connection or long poll that told reported. */
  waiting: { waitingAgents?: string[] } | undefined;
  waitingKnown: boolean;
}

function noteWaiting(call: WaitCall, waiting: { waitingAgents?: string[] } | undefined): void {
  if (call.waitingKnown) return;
  call.waiting = waiting;
  call.waitingKnown = true;
}

/** Messages to return: newer than the cursor already, from others than the agent (server notices included), one per seq. */
function mergeUnread(agentName: string, ...sources: ApiMessage[][]): ApiMessage[] {
  const bySeq = new Map<number, ApiMessage>();
  for (const source of sources) {
    for (const message of source) {
      if (message.agentName !== agentName) bySeq.set(message.seq, message);
    }
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export class CloudWaitService {
  private readonly sockets = new Map<string, RoomSocket>();
  private readonly cursors = new Map<string, ReadCursor>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly openEndedWaits = new OpenEndedWaits();
  private webSocketRetryAt = 0;
  private readonly connectTimeoutMs: number;
  private readonly ackTimeoutMs: number;
  private readonly pingIntervalMs: number;
  private readonly webSocketRetryCooldownMs: number;
  private readonly serverWaitMaxSeconds: number;

  /** Counters for diagnostics and tests. */
  readonly stats = { webSocketConnects: 0, webSocketFallbacks: 0, longPollRequests: 0, waitRedeclarations: 0 };

  constructor(
    private readonly api: CloudApiClient,
    options: CloudWaitServiceOptions = {},
  ) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10000;
    this.ackTimeoutMs = options.ackTimeoutMs ?? 10000;
    this.pingIntervalMs = options.pingIntervalMs ?? 30000;
    this.webSocketRetryCooldownMs = options.webSocketRetryCooldownMs ?? 30000;
    this.serverWaitMaxSeconds = Math.max(1, Math.min(WAIT_START_MAX_SECONDS, options.serverWaitMaxSeconds ?? WAIT_START_MAX_SECONDS));
  }

  /**
   * Waits up to `timeoutMs` (0: until a message arrives); with `mentionsOnly`, for a message that mentions the agent or a
   * server notice, reading the others as it passes over them. Rejects with WaitCancelledError, consuming nothing it
   * would have returned, when `signal` aborts or a newer call for the same room x agent takes over from a wait without a
   * time limit.
   */
  async waitForMessages(
    agentName: string,
    roomName: string,
    timeoutMs: number,
    mentionsOnly: boolean,
    signal?: AbortSignal,
  ): Promise<WaitForMessagesResult> {
    const key = socketKey(roomName, agentName);
    const noTimeLimit = timeoutMs === WAIT_CONSTANTS.NO_TIMEOUT;
    const turn = this.openEndedWaits.start(key, noTimeLimit, signal);
    const call: WaitCall = {
      key,
      roomName,
      agentName,
      timeoutMs,
      deadline: noTimeLimit ? Infinity : Date.now() + timeoutMs,
      mentionsOnly,
      passedOver: undefined,
      signal: turn.signal,
      waiting: undefined,
      waitingKnown: false,
    };
    try {
      // Calls for the same room x agent share one connection and one server-side waiter; run them one at a time.
      return await this.withLock(key, call.signal, async () => {
        try {
          return await (noTimeLimit ? this.waitWithoutTimeLimit(call) : this.waitWithTimeLimit(call));
        } finally {
          await this.storePassedOver(call);
        }
      });
    } finally {
      turn.end();
    }
  }

  /**
   * enter_room: the join response carries the member's read position and the epoch of the room (api 0.5.1). It
   * replaces a cursor of another epoch, and a cursor of a member row that did not exist before; a cursor of the same
   * epoch is more precise and stays.
   */
  noteJoined(roomName: string, agentName: string, lastReadSeq: number | undefined, alreadyMember: boolean, epoch: string | undefined): void {
    if (typeof lastReadSeq !== 'number' || typeof epoch !== 'string') return;
    const key = socketKey(roomName, agentName);
    const existing = this.cursors.get(key);
    if (!existing || !alreadyMember || existing.epoch !== epoch) this.cursors.set(key, { seq: lastReadSeq, epoch });
  }

  /**
   * send_message: take the cursor before the agent's first send from this process (a server before api 0.4.2 moves
   * the read position past everything older when the agent sends). Costs one GET /members, and only when there is no
   * cursor yet. Throws when it cannot be read: sending then could hide the unread messages.
   */
  async ensureCursor(roomName: string, agentName: string): Promise<void> {
    const key = socketKey(roomName, agentName);
    if (this.cursors.has(key)) return;
    const cursor = cursorFromMembers(await this.api.listMembers(roomName, true), agentName);
    if (cursor && !this.cursors.has(key)) this.cursors.set(key, cursor);
  }

  /** Whether a WebSocket for the room x agent is currently held (diagnostics and tests). */
  hasOpenSocket(roomName: string, agentName: string): boolean {
    return this.sockets.get(socketKey(roomName, agentName))?.isOpen() ?? false;
  }

  /**
   * After clear_room_messages: the server moved every read position to the last cleared seq. Only the cursors are
   * dropped; the next wait adopts the server position and discards buffered messages up to it, while messages sent
   * after the clear (possibly already buffered before this call returned) stay unread.
   */
  invalidateRoom(roomName: string): void {
    const prefix = `${roomName}\u0000`;
    for (const key of [...this.cursors.keys()]) {
      if (key.startsWith(prefix)) this.cursors.delete(key);
    }
  }

  /** After leave_room: an offline member has nothing to wait for, so the connection is released. */
  disconnect(roomName: string, agentName: string): void {
    const key = socketKey(roomName, agentName);
    const socket = this.sockets.get(key);
    if (socket) {
      this.sockets.delete(key);
      socket.close(1000, 'left room');
    }
  }

  /** Closes every held connection; resolves once they are closed (at most `CLOSE_GRACE_MS`). */
  async close(): Promise<void> {
    const sockets = [...this.sockets.values()];
    this.sockets.clear();
    await Promise.all(sockets.map((socket) => socket.closeAndWait(1000, 'shutdown', CLOSE_GRACE_MS)));
  }

  /* ---------------------------------------------------------------------
   * The two kinds of wait
   * ------------------------------------------------------------------ */

  private async waitWithTimeLimit(call: WaitCall): Promise<WaitForMessagesResult> {
    const { key, roomName, agentName, deadline, signal } = call;
    for (let reconnects = 0; ; reconnects++) {
      const socket = await this.acquireSocket(key, roomName, agentName, deadline);
      if (!socket) return this.waitWithLongPoll(call, deadline);
      try {
        return await this.waitOnSocket(call, socket);
      } catch (error) {
        if (signal.aborted) throw WaitCancelledError.fromSignal(signal);
        if (!(error instanceof RoomSocketClosedError)) throw error;
        this.forget(key, socket);
        if (Date.now() >= deadline) {
          // No time left to reconnect. Nothing was returned, so the next call still returns what is unread (the read
          // position of what a mentionsOnly call passed over is stored as the call ends).
          logger.warn('Room WebSocket dropped at the end of a wait', { roomName, agentName, reason: error.message });
          return toWaitResult(agentName, [], true, call.waiting);
        }
        if (reconnects >= MAX_RECONNECTS_PER_CALL) {
          logger.warn('Room WebSocket keeps dropping; long polling for the rest of this wait', {
            roomName,
            agentName,
            reason: error.message,
          });
          return this.waitWithLongPoll(call, deadline);
        }
        logger.warn('Room WebSocket dropped during a wait; reconnecting', { roomName, agentName, reason: error.message });
      }
    }
  }

  /**
   * `timeout: 0`. Over the WebSocket the wait is declared again before the server drops it (waitOnSocket). A dropped
   * connection is made again at once, unless it did not last the cooldown: then, as when the WebSocket cannot be
   * established, long polling (each request declares the wait) until the cooldown is over. Failures that another
   * attempt may get past (network, 5xx, 429) are retried after a pause that grows while they keep coming.
   */
  private async waitWithoutTimeLimit(call: WaitCall): Promise<WaitForMessagesResult> {
    const { key, roomName, agentName, signal } = call;
    let failures = 0;
    let lastFailureAt = 0;
    for (;;) {
      if (signal.aborted) throw WaitCancelledError.fromSignal(signal);
      let socket: RoomSocket | null = null;
      try {
        socket = await this.acquireSocket(key, roomName, agentName, call.deadline);
        if (socket) return await this.waitOnSocket(call, socket);
        const result = await this.waitWithLongPoll(call, Math.max(this.webSocketRetryAt, Date.now() + MIN_LONG_POLL_ROUND_MS));
        if (result.hasNewMessages) return result;
        failures = 0;
      } catch (error) {
        if (signal.aborted) throw WaitCancelledError.fromSignal(signal);
        if (error instanceof RoomSocketClosedError && socket) {
          this.forget(key, socket);
          if (Date.now() - socket.connectedAt < this.webSocketRetryCooldownMs) {
            this.webSocketRetryAt = Date.now() + this.webSocketRetryCooldownMs;
          }
          logger.warn('Room WebSocket dropped during a wait without a time limit; reconnecting', {
            roomName,
            agentName,
            reason: error.message,
          });
          continue;
        }
        if (isDefinitiveAppError(error)) throw error;
        // Failures in a row make the pause grow; after a quiet spell it starts small again.
        failures = Date.now() - lastFailureAt > RETRY_MAX_DELAY_MS * 2 ? 1 : failures + 1;
        lastFailureAt = Date.now();
        const retryInMs = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (failures - 1));
        logger.warn('Waiting for messages failed; trying again', { roomName, agentName, retryInMs, reason: String(error) });
        await sleep(retryInMs, signal);
      }
    }
  }

  /* ---------------------------------------------------------------------
   * WebSocket
   * ------------------------------------------------------------------ */

  private async acquireSocket(key: string, roomName: string, agentName: string, deadline: number): Promise<RoomSocket | null> {
    const existing = this.sockets.get(key);
    const held = this.cursors.get(key);
    // A connection to an earlier room of this name (the cursor was taken in a newer one) is of no use.
    if (existing?.isOpen() && (!held || held.epoch === existing.epoch)) return existing;
    if (existing) this.forget(key, existing);
    if (Date.now() < this.webSocketRetryAt) return null;

    try {
      let cursor = this.cursors.get(key);
      let socket = await this.openSocket(roomName, agentName, cursor?.seq, deadline);
      if (cursor && socket.epoch !== cursor.epoch) {
        // The cursor belongs to an earlier room of this name: start from the member's read position in this one
        // (connecting does not move it).
        socket.close(1000, 'room recreated');
        this.cursors.delete(key);
        cursor = undefined;
        socket = await this.openSocket(roomName, agentName, undefined, deadline);
      }
      this.cursors.set(key, { seq: cursor?.seq ?? socket.initialLastReadSeq, epoch: socket.epoch });
      this.sockets.set(key, socket);
      socket.onClose(() => {
        if (this.sockets.get(key) === socket) this.sockets.delete(key);
      });
      return socket;
    } catch (error) {
      if (!(error instanceof RoomSocketUnavailableError)) throw error;
      this.webSocketRetryAt = Date.now() + this.webSocketRetryCooldownMs;
      this.stats.webSocketFallbacks += 1;
      logger.warn('Room WebSocket unavailable; falling back to long polling', {
        roomName,
        agentName,
        reason: error.message,
      });
      return null;
    }
  }

  private async openSocket(
    roomName: string,
    agentName: string,
    since: number | undefined,
    deadline: number,
  ): Promise<RoomSocket> {
    const socket = await RoomSocket.open({
      url: this.api.webSocketUrl(roomName, agentName, since),
      headers: this.api.requestHeaders(),
      roomName,
      agentName,
      connectTimeoutMs: this.boundedTimeout(this.connectTimeoutMs, deadline),
      pingIntervalMs: this.pingIntervalMs,
    });
    this.stats.webSocketConnects += 1;
    return socket;
  }

  private async waitOnSocket(call: WaitCall, socket: RoomSocket): Promise<WaitForMessagesResult> {
    const { key, roomName, agentName, deadline, signal } = call;
    if (signal.aborted) throw WaitCancelledError.fromSignal(signal);
    const context = { roomName, agentName };
    const requestId = randomUUID();
    // The tool timeout (ms) in whole seconds, no longer than the server keeps a wait; without a time limit, that long.
    const timeoutSeconds =
      call.timeoutMs > 0
        ? Math.min(this.serverWaitMaxSeconds, Math.max(1, Math.ceil(call.timeoutMs / 1000)))
        : this.serverWaitMaxSeconds;
    let declaredUntil = 0;
    // `wait_start` again with the same requestId replaces the server's waiter: the wait lasts `timeoutSeconds` from then.
    const declare = async (): Promise<AckResult> => {
      const sentAt = Date.now();
      try {
        const started = await socket.request(
          { type: 'wait_start', requestId, timeoutSeconds },
          this.boundedTimeout(this.ackTimeoutMs, deadline),
        );
        declaredUntil = sentAt + timeoutSeconds * 1000;
        return started;
      } catch (error) {
        throw frameErrorToAppError(error, context);
      }
    };
    const redeclareMarginMs = Math.min(REDECLARE_MARGIN_MS, (timeoutSeconds * 1000) / 4);

    const started = await declare();
    if (!call.waitingKnown) {
      // Like the file mode, the deadlock warning describes the other agents waiting when this wait began.
      noteWaiting(call, await socket.firstWaitingAfter(started.waitingVersion));
    }

    let cursor = this.cursors.get(key)?.seq;
    if (cursor === undefined) {
      // No cursor since clear_room_messages: adopt the server's read position.
      cursor = started.ack.lastReadSeq ?? 0;
      this.cursors.set(key, { seq: cursor, epoch: socket.epoch });
      socket.consumeThrough(cursor);
    }

    // Passed over in a room that has been deleted and created again since: nothing of it is left to mark read.
    if (call.passedOver && call.passedOver.epoch !== socket.epoch) call.passedOver = undefined;

    let messages: ApiMessage[] = [];
    let consumedThrough = cursor;
    let timedOut = false;
    try {
      for (;;) {
        // A wait that lasts longer than the server keeps it is declared again shortly before the server would drop it.
        const redeclareAt = deadline > declaredUntil ? declaredUntil - redeclareMarginMs : Infinity;
        const outcome = await socket.waitForUnread(agentName, cursor, Math.min(deadline, redeclareAt), signal);
        if (outcome === 'cancelled') throw WaitCancelledError.fromSignal(signal);
        // Take the buffer, its high-water mark and what needs HTTP in the same turn; later frames stay for the next call.
        const buffered = socket.unreadMessages(agentName, cursor);
        let through = Math.max(cursor, socket.highestBufferedSeq());
        const fetches = socket.pendingFetches(cursor);
        const fetched: ApiMessage[] = [];
        for (const range of fetches) {
          fetched.push(...(await this.fetchRange(roomName, range, deadline, signal)));
          through = Math.max(through, range.through);
        }
        // A cancelled wait consumes nothing: what it fetched stays pending for the next call.
        if (signal.aborted) throw WaitCancelledError.fromSignal(signal);
        // Resolved only after every fetch succeeded: a failure leaves them all pending for the next call.
        for (const range of fetches) socket.resolveFetch(range);

        const unread = mergeUnread(agentName, buffered, fetched);
        messages = call.mentionsOnly ? unread.filter((message) => passesMentionsOnly(message, agentName)) : unread;
        consumedThrough = Math.max(consumedThrough, through);
        if (messages.length > 0) break;
        if (unread.length > 0) {
          // mentionsOnly: what mentions only others is read as the wait passes over it (a long poll moves `nextCursor`
          // past it too), and the wait goes on after it. The call owes the server read position until it is stored.
          socket.consumeThrough(consumedThrough);
          this.cursors.set(key, { seq: consumedThrough, epoch: socket.epoch });
          call.passedOver = { seq: consumedThrough, epoch: socket.epoch };
          cursor = consumedThrough;
        }
        if (outcome === 'timeout' && Date.now() >= deadline) {
          timedOut = true;
          break;
        }
        if (outcome === 'timeout' && Date.now() >= redeclareAt) {
          await declare();
          this.stats.waitRedeclarations += 1;
        }
      }
    } catch (error) {
      // A connection that is gone stores nothing: what the call passed over stays owed, to the connection or long poll
      // that follows or to the end of the call.
      if (!(error instanceof RoomSocketClosedError)) await this.finishWait(call, socket, requestId, false, cursor);
      throw error;
    }

    socket.consumeThrough(consumedThrough);
    this.cursors.set(key, { seq: consumedThrough, epoch: socket.epoch });
    await this.finishWait(call, socket, requestId, messages.length > 0, consumedThrough);
    return toWaitResult(agentName, messages, timedOut, call.waiting);
  }

  /**
   * `wait_end`, and the read position through `through` (§6: once per wait) when this wait returned messages or the
   * call owes one for messages it passed over (mentionsOnly), on this connection or an earlier one. `read` may not go
   * past what this connection delivered, so the rest is marked read over HTTP. Failures are only logged: the result is
   * already decided and the client cursor has moved on. A read position owed for messages passed over that could not
   * be stored stays owed, up to `through`, for storePassedOver.
   */
  private async finishWait(call: WaitCall, socket: RoomSocket, requestId: string, returned: boolean, through: number): Promise<void> {
    const { roomName, agentName } = call;
    const owed = call.passedOver !== undefined;
    const readThrough = returned || owed ? through : 0;
    const timeoutMs = Math.min(this.ackTimeoutMs, FINISH_TIMEOUT_MS);
    const stored = (task: Promise<unknown>): Promise<boolean> =>
      task.then(
        () => true,
        (error: unknown) => {
          logger.warn('Could not store the read position', { roomName, agentName, reason: String(error) });
          return false;
        },
      );
    // An already expired or replaced wait answers wait_end with an error, which is fine here.
    const ended = socket.request({ type: 'wait_end', requestId }, timeoutMs, false).catch(() => undefined);
    const reads: Array<Promise<boolean>> = [];
    const overSocket = Math.min(readThrough, socket.deliveredUpToSeq);
    if (overSocket > 0) {
      reads.push(stored(socket.request({ type: 'read', seq: overSocket, requestId: randomUUID() }, timeoutMs, false)));
    }
    if (readThrough > socket.deliveredUpToSeq) {
      reads.push(stored(this.markReadOverHttp(roomName, agentName, { seq: readThrough, epoch: socket.epoch }, timeoutMs)));
    }
    const [, ...results] = await Promise.all([ended, ...reads]);
    if (owed) call.passedOver = results.every(Boolean) ? undefined : { seq: readThrough, epoch: socket.epoch };
  }

  /**
   * mentionsOnly: as the call ends, however it ends, stores the read position it still owes for messages it passed
   * over: on a connection that was lost before the call ended, or whose read position could not be stored. No
   * connection of the call is left to acknowledge it, so over HTTP. Failures are only logged.
   */
  private async storePassedOver(call: WaitCall): Promise<void> {
    const through = call.passedOver;
    if (!through) return;
    call.passedOver = undefined;
    const { roomName, agentName } = call;
    await this.markReadOverHttp(roomName, agentName, through, FINISH_TIMEOUT_MS).catch((error: unknown) =>
      logger.warn('Could not store the read position', { roomName, agentName, reason: String(error) }),
    );
  }

  /**
   * Marks messages up to `through.seq` read over HTTP. GET …/messages?before=seq+1&limit=1 first checks, without side
   * effects, that the room is still the one of `through.epoch` and that a message at or below the seq is still stored:
   * a markRead request that finds none (the messages were cleared) stores the room's latest seq instead, past messages
   * sent since. The same request with agentName and markRead=true then stores the position of the message it returns.
   * Both requests together take at most `timeoutMs`.
   *
   * The check and the markRead are separate requests, and the HTTP API has no atomic precondition on the epoch and the
   * seq. A clear, or the room deleted, created again and rejoined, plus a new message, landing between the two can still
   * mark that message read without it being returned. A WebSocket `read`, used whenever the connection delivered the
   * seq, has no such window. Follow-up in agora (markRead must never store past the delivered seq, and must fail on an
   * epoch mismatch): https://github.com/mkXultra/agora/issues/5
   */
  private async markReadOverHttp(roomName: string, agentName: string, through: ReadCursor, timeoutMs: number): Promise<void> {
    const until = Date.now() + timeoutMs;
    const context = { roomName, agentName };
    const newest = await this.api.getMessages(roomName, { before: through.seq + 1, limit: 1 }, { timeoutMs, retry: false, context });
    if (newest.messages.length === 0 || (newest.epoch !== undefined && newest.epoch !== through.epoch)) return;
    await this.api.getMessages(
      roomName,
      { agentName, before: through.seq + 1, limit: 1, markRead: true },
      { timeoutMs: Math.max(1, until - Date.now()), retry: false, context },
    );
  }

  /** Messages in `(after, through]` that did not fit a WebSocket frame, fetched over HTTP as the server asks. */
  private async fetchRange(roomName: string, range: FetchRange, deadline: number, signal: AbortSignal): Promise<ApiMessage[]> {
    const found: ApiMessage[] = [];
    let since = range.after;
    while (since < range.through) {
      // No agentName: a plain read without side effects (the read position is stored once the result is known).
      const page = await this.api.getMessages(
        roomName,
        { since, limit: Math.min(PAGE_LIMIT, range.through - since) },
        { timeoutMs: this.boundedTimeout(HTTP_TIMEOUT_MS, deadline), retry: false, signal },
      );
      for (const message of page.messages) {
        if (message.seq <= range.through) found.push(message);
      }
      const last = page.messages[page.messages.length - 1]?.seq;
      if (!page.hasMore || last === undefined || last >= range.through) break;
      since = last;
    }
    return found;
  }

  private forget(key: string, socket: RoomSocket): void {
    if (this.sockets.get(key) === socket) this.sockets.delete(key);
    socket.terminate();
  }

  /* ---------------------------------------------------------------------
   * Long polling (fallback only)
   * ------------------------------------------------------------------ */

  /**
   * Long polls until `deadline`: the wait's own, or for a wait without a time limit the end of one round (when the
   * WebSocket may be tried again).
   */
  private async waitWithLongPoll(call: WaitCall, deadline: number): Promise<WaitForMessagesResult> {
    const { key, roomName, agentName, mentionsOnly, signal } = call;
    const context = { roomName, agentName };
    let lastError: unknown;
    let epochChecked = false;

    // The first request always goes out, so messages that are already unread are returned even at the deadline.
    let attempts = 0;
    while (attempts === 0 || Date.now() < deadline) {
      if (signal.aborted) throw WaitCancelledError.fromSignal(signal);
      attempts += 1;
      try {
        const cursor = await this.longPollCursor(key, roomName, agentName, deadline, !epochChecked, signal);
        epochChecked = true;
        // Passed over in a room that has been deleted and created again since: nothing of it is left to mark read.
        if (call.passedOver && call.passedOver.epoch !== cursor.epoch) call.passedOver = undefined;
        const remaining = deadline - Date.now();
        // Whole seconds up to 30, at least one while any time is left: the request declares the wait (and a `wait=0`
        // request answers at once, so the loop would spin). Past the deadline, one immediate check.
        const waitSeconds = remaining > 0 ? Math.min(LONG_POLL_MAX_SECONDS, Math.max(1, Math.ceil(remaining / 1000))) : 0;

        this.stats.longPollRequests += 1;
        const page = await this.api.getMessages(
          roomName,
          // An explicit `since` on every request: the long poll also moves the server read position, so a request
          // that started from the server-side position could not be repeated after a lost response. With
          // `mentionsOnly` the server waits for a message that mentions the agent, and `nextCursor` and the read
          // position move past the ones it passes over.
          {
            agentName,
            since: cursor.seq,
            wait: waitSeconds,
            limit: PAGE_LIMIT,
            excludeSelf: true,
            markRead: true,
            ...(mentionsOnly ? { mentionsOnly } : {}),
          },
          // This loop retries until the deadline; one request never runs much past its own wait, nor past the hard stop.
          { timeoutMs: Math.min(waitSeconds * 1000 + LONG_POLL_GRACE_MS, this.untilHardStop(deadline)), retry: false, context, signal },
        );
        lastError = undefined;
        // A cancelled wait keeps its cursor: what this request marked read comes again with the next call.
        if (signal.aborted) throw WaitCancelledError.fromSignal(signal);

        if (page.epoch !== cursor.epoch) {
          // The room was deleted and created again since the cursor was taken. This request has already marked the
          // new room's messages read up to its `nextCursor`, so the member's read position no longer tells what was
          // returned. Start from the beginning of the new room: nothing is lost (messages from before the agent
          // entered it may come too, as they do on a first wait in file mode).
          this.cursors.set(key, { seq: 0, epoch: page.epoch ?? '' });
          attempts = 0;
          continue;
        }
        // The request stored a read position from its `since` on, past what the call passed over on a WebSocket.
        if (call.passedOver?.epoch === page.epoch) call.passedOver = undefined;
        // The server reports the waiters at the end of each long poll; keep the first one, closest to the start.
        if (waitSeconds > 0) noteWaiting(call, { waitingAgents: page.waitingAgents });

        const { messages, cursor: after } = await this.remainingPages(page, roomName, agentName, mentionsOnly, deadline, signal);
        if (signal.aborted) throw WaitCancelledError.fromSignal(signal);
        this.cursors.set(key, after);
        if (messages.length > 0) return toWaitResult(agentName, messages, false, call.waiting);
      } catch (error) {
        if (signal.aborted) throw WaitCancelledError.fromSignal(signal);
        if (isDefinitiveAppError(error)) throw error;
        lastError = error;
        const remaining = deadline - Date.now();
        if (remaining > 0) await sleep(Math.min(500, remaining), signal);
      }
    }

    if (lastError) {
      throw lastError instanceof AppError
        ? lastError
        : new AppError(`Waiting for messages failed: ${String(lastError)}`, 'SERVICE_UNAVAILABLE', 503);
    }
    return toWaitResult(agentName, [], true, call.waiting);
  }

  /**
   * The pages after the first long-poll response (more than PAGE_LIMIT unread). Each is one request without automatic
   * resending, and none is started after the deadline. When a page cannot be had, what was received so far is
   * returned with the cursor after it; the rest comes with the next call.
   */
  private async remainingPages(
    first: ApiMessageList,
    roomName: string,
    agentName: string,
    mentionsOnly: boolean,
    deadline: number,
    signal: AbortSignal,
  ): Promise<{ messages: ApiMessage[]; cursor: ReadCursor }> {
    const epoch = first.epoch ?? '';
    let messages = first.messages;
    let cursor: ReadCursor = { seq: first.nextCursor, epoch };
    let more = first.hasMore && first.messages.length > 0;
    while (more && Date.now() < deadline) {
      let page: ApiMessageList;
      try {
        page = await this.api.getMessages(
          roomName,
          { agentName, since: cursor.seq, limit: PAGE_LIMIT, excludeSelf: true, markRead: true, ...(mentionsOnly ? { mentionsOnly } : {}) },
          { timeoutMs: this.boundedTimeout(HTTP_TIMEOUT_MS, deadline), retry: false, context: { roomName, agentName }, signal },
        );
      } catch (error) {
        if (!signal.aborted) {
          logger.warn('Could not fetch the next page of unread messages; returning the ones received', {
            roomName,
            agentName,
            received: messages.length,
            reason: String(error),
          });
        }
        break;
      }
      if (page.epoch !== first.epoch) {
        // Created again between two pages: this request marked the new room's messages read, so the next call
        // starts at its beginning (see waitWithLongPoll).
        return { messages, cursor: { seq: 0, epoch: page.epoch ?? '' } };
      }
      messages = messages.concat(page.messages);
      cursor = { seq: page.nextCursor, epoch };
      more = page.hasMore && page.messages.length > 0;
    }
    return { messages, cursor };
  }

  /**
   * The cursor the long poll reads from, established without side effects with one GET /members: its epoch checks a
   * cursor this process holds (a cursor from a room that was deleted and created again would hold the long poll for
   * seqs that do not exist yet and then mark the new room's messages read), and the member's read position in the same
   * response replaces a missing or outdated cursor. Never taken from a `markRead` request that has no `since`.
   */
  private async longPollCursor(
    key: string,
    roomName: string,
    agentName: string,
    deadline: number,
    checkEpoch: boolean,
    signal: AbortSignal,
  ): Promise<ReadCursor> {
    const held = this.cursors.get(key);
    if (held && !checkEpoch) return held;
    const list = await this.api.listMembers(roomName, true, {
      timeoutMs: this.boundedTimeout(HTTP_TIMEOUT_MS, deadline),
      retry: false,
      signal,
    });
    // A cursor of the current room is more precise than the server's read position. (A server before api 0.5.1 does
    // not report the epoch here; the long poll's own response still does, and catches a room created again.)
    if (held && (typeof list.epoch !== 'string' || held.epoch === list.epoch)) return held;
    const cursor = cursorFromMembers(list, agentName);
    if (!cursor) throw new AgentNotInRoomError(agentName, roomName);
    this.cursors.set(key, cursor);
    return cursor;
  }

  /**
   * The timeout of one round trip made for a wait, computed when the round trip starts: until shortly after the
   * deadline, at least MIN_ROUND_TRIP_MS before it (so that a short wait can still connect), and never past the hard
   * stop. Throws instead of starting a round trip once the hard stop has passed.
   */
  private boundedTimeout(configured: number, deadline: number): number {
    const untilHardStop = this.untilHardStop(deadline);
    return Math.min(configured, Math.max(MIN_ROUND_TRIP_MS, deadline - Date.now() + DEADLINE_GRACE_MS), untilHardStop);
  }

  /** Milliseconds left until the hard stop of a wait (`deadline + MIN_ROUND_TRIP_MS`); throws when none are left. */
  private untilHardStop(deadline: number): number {
    const left = deadline + MIN_ROUND_TRIP_MS - Date.now();
    if (left <= 0) {
      throw new AppError('Waiting for messages ran out of time before the cloud API answered', 'SERVICE_UNAVAILABLE', 503);
    }
    return left;
  }

  private async withLock<T>(key: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.locks.set(key, tail);
    try {
      // A call cancelled while it waits for its turn gives the turn up.
      await settledOrAborted(previous, signal);
      if (signal.aborted) throw WaitCancelledError.fromSignal(signal);
      return await task();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}
