// Agent Communication MCP Server - wait_for_messages in cloud mode
// docs/cloud-architecture.md §5.4 / D6: WebSocket is the default, long polling only a fallback.
//
// - One WebSocket per room x agent, kept for the lifetime of the process and reconnected lazily
//   by the next call after it drops.
// - Every call declares its wait with `wait_start` / `wait_end` and returns when a message from
//   another agent arrives (live, or buffered since the previous call), or when the timeout passes.
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
import { AgentNotInRoomError, AppError } from '../errors/index.js';
import { createLogger } from '../utils/logger.js';
import { CloudApiClient } from './CloudApiClient.js';
import { toWaitResult, type WaitForMessagesResult } from './mappers.js';
import {
  RoomSocket,
  type AckResult,
  type FetchRange,
  RoomSocketClosedError,
  RoomSocketUnavailableError,
  SYSTEM_AGENT,
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
}

export interface ReadCursor {
  seq: number;
  /** Epoch of the room the seq belongs to (seq restarts at 1 when a room is deleted and created again). */
  epoch: string;
}

/** docs/api.yaml `getMessages.wait`: at most 30 seconds (values above are a 400). */
const LONG_POLL_MAX_SECONDS = 30;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function socketKey(roomName: string, agentName: string): string {
  return `${roomName}\u0000${agentName}`;
}

/** The member's server-side read position with the epoch of the room it belongs to, or `undefined` for a non-member. */
function cursorFromMembers(list: ApiMemberList, agentName: string): ReadCursor | undefined {
  const member = list.members.find((candidate) => candidate.agentName === agentName);
  return typeof member?.lastReadSeq === 'number' ? { seq: member.lastReadSeq, epoch: list.epoch } : undefined;
}

/** Messages to return: newer than the cursor already, from others than the agent and `system`, one per seq. */
function mergeUnread(agentName: string, ...sources: ApiMessage[][]): ApiMessage[] {
  const bySeq = new Map<number, ApiMessage>();
  for (const source of sources) {
    for (const message of source) {
      if (message.agentName !== agentName && message.agentName !== SYSTEM_AGENT) bySeq.set(message.seq, message);
    }
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export class CloudWaitService {
  private readonly sockets = new Map<string, RoomSocket>();
  private readonly cursors = new Map<string, ReadCursor>();
  private readonly locks = new Map<string, Promise<void>>();
  private webSocketRetryAt = 0;
  private readonly connectTimeoutMs: number;
  private readonly ackTimeoutMs: number;
  private readonly pingIntervalMs: number;
  private readonly webSocketRetryCooldownMs: number;

  /** Counters for diagnostics and tests. */
  readonly stats = { webSocketConnects: 0, webSocketFallbacks: 0, longPollRequests: 0 };

  constructor(
    private readonly api: CloudApiClient,
    options: CloudWaitServiceOptions = {},
  ) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10000;
    this.ackTimeoutMs = options.ackTimeoutMs ?? 10000;
    this.pingIntervalMs = options.pingIntervalMs ?? 30000;
    this.webSocketRetryCooldownMs = options.webSocketRetryCooldownMs ?? 30000;
  }

  async waitForMessages(agentName: string, roomName: string, timeoutMs: number): Promise<WaitForMessagesResult> {
    const deadline = Date.now() + timeoutMs;
    const key = socketKey(roomName, agentName);
    // Calls for the same room x agent share one connection and one server-side waiter; run them one at a time.
    return this.withLock(key, async () => {
      for (let reconnects = 0; ; reconnects++) {
        const socket = await this.acquireSocket(key, roomName, agentName, deadline);
        if (!socket) return this.waitWithLongPoll(key, roomName, agentName, deadline);
        try {
          return await this.waitOnSocket(key, socket, roomName, agentName, timeoutMs, deadline);
        } catch (error) {
          if (!(error instanceof RoomSocketClosedError)) throw error;
          this.forget(key, socket);
          if (Date.now() >= deadline) {
            // No time left to reconnect. Nothing was consumed, so the next call still returns what is unread.
            logger.warn('Room WebSocket dropped at the end of a wait', { roomName, agentName, reason: error.message });
            return toWaitResult(agentName, [], true, undefined);
          }
          if (reconnects >= MAX_RECONNECTS_PER_CALL) {
            logger.warn('Room WebSocket keeps dropping; long polling for the rest of this wait', {
              roomName,
              agentName,
              reason: error.message,
            });
            return this.waitWithLongPoll(key, roomName, agentName, deadline);
          }
          logger.warn('Room WebSocket dropped during a wait; reconnecting', { roomName, agentName, reason: error.message });
        }
      }
    });
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

  private async waitOnSocket(
    key: string,
    socket: RoomSocket,
    roomName: string,
    agentName: string,
    timeoutMs: number,
    deadline: number,
  ): Promise<WaitForMessagesResult> {
    const context = { roomName, agentName };
    const requestId = randomUUID();
    let started: AckResult;
    try {
      started = await socket.request(
        // The tool timeout (ms) in whole seconds; the server clamps anything above 300.
        { type: 'wait_start', requestId, timeoutSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)) },
        this.boundedTimeout(this.ackTimeoutMs, deadline),
      );
    } catch (error) {
      throw frameErrorToAppError(error, context);
    }

    // Like the file mode, the deadlock warning describes the other agents waiting when this wait began.
    const waiting = await socket.firstWaitingAfter(started.waitingVersion);

    let cursor = this.cursors.get(key)?.seq;
    if (cursor === undefined) {
      // No cursor since clear_room_messages: adopt the server's read position.
      cursor = started.ack.lastReadSeq ?? 0;
      this.cursors.set(key, { seq: cursor, epoch: socket.epoch });
      socket.consumeThrough(cursor);
    }

    let messages: ApiMessage[] = [];
    let consumedThrough = cursor;
    let timedOut = false;
    try {
      for (;;) {
        const outcome = await socket.waitForUnread(agentName, cursor, deadline);
        // Take the buffer, its high-water mark and what needs HTTP in the same turn; later frames stay for the next call.
        const buffered = socket.unreadMessages(agentName, cursor);
        let through = Math.max(cursor, socket.highestBufferedSeq());
        const fetches = socket.pendingFetches(cursor);
        const fetched: ApiMessage[] = [];
        for (const range of fetches) {
          fetched.push(...(await this.fetchRange(roomName, range, deadline)));
          through = Math.max(through, range.through);
        }
        // Resolved only after every fetch succeeded: a failure leaves them all pending for the next call.
        for (const range of fetches) socket.resolveFetch(range);

        messages = mergeUnread(agentName, buffered, fetched);
        consumedThrough = Math.max(consumedThrough, through);
        if (messages.length > 0) break;
        if (outcome === 'timeout') {
          timedOut = true;
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof RoomSocketClosedError)) await this.finishWait(socket, requestId, roomName, agentName, 0);
      throw error;
    }

    socket.consumeThrough(consumedThrough);
    this.cursors.set(key, { seq: consumedThrough, epoch: socket.epoch });
    await this.finishWait(socket, requestId, roomName, agentName, messages.length > 0 ? consumedThrough : 0);
    return toWaitResult(agentName, messages, timedOut, waiting);
  }

  /**
   * `wait_end`, and when messages were returned the read position (§6: once per wait). `read` may not go past
   * what this connection delivered, so messages that came over HTTP are marked read over HTTP. Failures are only
   * logged: the result is already decided and the client cursor has moved on.
   */
  private async finishWait(
    socket: RoomSocket,
    requestId: string,
    roomName: string,
    agentName: string,
    readThrough: number,
  ): Promise<void> {
    const timeoutMs = Math.min(this.ackTimeoutMs, FINISH_TIMEOUT_MS);
    const logFailure = (error: unknown): void =>
      logger.warn('Could not store the read position', { roomName, agentName, reason: String(error) });
    const tasks: Array<Promise<unknown>> = [
      // An already expired or replaced wait answers wait_end with an error, which is fine here.
      socket.request({ type: 'wait_end', requestId }, timeoutMs, false).catch(() => undefined),
    ];
    const overSocket = Math.min(readThrough, socket.deliveredUpToSeq);
    if (overSocket > 0) {
      tasks.push(socket.request({ type: 'read', seq: overSocket, requestId: randomUUID() }, timeoutMs, false).catch(logFailure));
    }
    if (readThrough > socket.deliveredUpToSeq) {
      tasks.push(this.markReadOverHttp(roomName, agentName, readThrough, timeoutMs).catch(logFailure));
    }
    await Promise.all(tasks);
  }

  /**
   * Marks messages up to `seq` read with GET …/messages?before=seq+1&limit=1&markRead=true: the newest message at
   * or below `seq` is the one returned, and the server stores the position of what it returned, never beyond.
   */
  private async markReadOverHttp(roomName: string, agentName: string, seq: number, timeoutMs: number): Promise<void> {
    await this.api.getMessages(
      roomName,
      { agentName, before: seq + 1, limit: 1, markRead: true },
      { timeoutMs, retry: false, context: { roomName, agentName } },
    );
  }

  /** Messages in `(after, through]` that did not fit a WebSocket frame, fetched over HTTP as the server asks. */
  private async fetchRange(roomName: string, range: FetchRange, deadline: number): Promise<ApiMessage[]> {
    const found: ApiMessage[] = [];
    let since = range.after;
    while (since < range.through) {
      // No agentName: a plain read without side effects (the read position is stored once the result is known).
      const page = await this.api.getMessages(
        roomName,
        { since, limit: Math.min(PAGE_LIMIT, range.through - since) },
        { timeoutMs: this.boundedTimeout(HTTP_TIMEOUT_MS, deadline), retry: false },
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

  private async waitWithLongPoll(
    key: string,
    roomName: string,
    agentName: string,
    deadline: number,
  ): Promise<WaitForMessagesResult> {
    const context = { roomName, agentName };
    let waiting: { waitingAgents?: string[] } | undefined;
    let lastError: unknown;
    let epochChecked = false;

    // The first request always goes out, so messages that are already unread are returned even at the deadline.
    let attempts = 0;
    while (attempts === 0 || Date.now() < deadline) {
      attempts += 1;
      try {
        const cursor = await this.longPollCursor(key, roomName, agentName, deadline, !epochChecked);
        epochChecked = true;
        const remaining = deadline - Date.now();
        // Whole seconds up to 30, at least one while any time is left: the request declares the wait (and a `wait=0`
        // request answers at once, so the loop would spin). Past the deadline, one immediate check.
        const waitSeconds = remaining > 0 ? Math.min(LONG_POLL_MAX_SECONDS, Math.max(1, Math.ceil(remaining / 1000))) : 0;

        this.stats.longPollRequests += 1;
        const page = await this.api.getMessages(
          roomName,
          // An explicit `since` on every request: the long poll also moves the server read position, so a request
          // that started from the server-side position could not be repeated after a lost response.
          { agentName, since: cursor.seq, wait: waitSeconds, limit: PAGE_LIMIT, excludeSelf: true, markRead: true },
          // This loop retries until the deadline; one request never runs much past its own wait, nor past the hard stop.
          { timeoutMs: Math.min(waitSeconds * 1000 + LONG_POLL_GRACE_MS, this.untilHardStop(deadline)), retry: false, context },
        );
        lastError = undefined;

        if (page.epoch !== cursor.epoch) {
          // The room was deleted and created again since the cursor was taken. This request has already marked the
          // new room's messages read up to its `nextCursor`, so the member's read position no longer tells what was
          // returned. Start from the beginning of the new room: nothing is lost (messages from before the agent
          // entered it may come too, as they do on a first wait in file mode).
          this.cursors.set(key, { seq: 0, epoch: page.epoch ?? '' });
          attempts = 0;
          continue;
        }
        // The server reports the waiters at the end of each long poll; keep the first one, closest to the start.
        if (waitSeconds > 0) waiting ??= { waitingAgents: page.waitingAgents };

        const { messages, cursor: after } = await this.remainingPages(page, roomName, agentName, deadline);
        this.cursors.set(key, after);
        if (messages.length > 0) return toWaitResult(agentName, messages, false, waiting);
      } catch (error) {
        if (isDefinitiveAppError(error)) throw error;
        lastError = error;
        const remaining = deadline - Date.now();
        if (remaining > 0) await sleep(Math.min(500, remaining));
      }
    }

    if (lastError) {
      throw lastError instanceof AppError
        ? lastError
        : new AppError(`Waiting for messages failed: ${String(lastError)}`, 'SERVICE_UNAVAILABLE', 503);
    }
    return toWaitResult(agentName, [], true, waiting);
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
    deadline: number,
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
          { agentName, since: cursor.seq, limit: PAGE_LIMIT, excludeSelf: true, markRead: true },
          { timeoutMs: this.boundedTimeout(HTTP_TIMEOUT_MS, deadline), retry: false, context: { roomName, agentName } },
        );
      } catch (error) {
        logger.warn('Could not fetch the next page of unread messages; returning the ones received', {
          roomName,
          agentName,
          received: messages.length,
          reason: String(error),
        });
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
  ): Promise<ReadCursor> {
    const held = this.cursors.get(key);
    if (held && !checkEpoch) return held;
    const list = await this.api.listMembers(roomName, true, {
      timeoutMs: this.boundedTimeout(HTTP_TIMEOUT_MS, deadline),
      retry: false,
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

  private async withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.locks.set(key, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}
