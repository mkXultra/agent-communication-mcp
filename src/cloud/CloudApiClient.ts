// Agent Communication MCP Server - HTTP client for the cloud API (docs/api.yaml)
// Uses the fetch built into Node 18+ (through cloudFetch, see http.ts). Every request carries `Authorization: Bearer <token>`.

import { randomUUID } from 'crypto';
import { AppError } from '../errors/index.js';
import type { CloudConfig } from './config.js';
import { CloudTransportError, parseApiErrorBody, toAppError, type ApiErrorContext } from './errors.js';
import { cloudFetch } from './http.js';
import type {
  ApiAgentProfile,
  ApiClearMessagesResult,
  ApiCreateRoomResult,
  ApiGetMessagesQuery,
  ApiJoinResult,
  ApiLeaveResult,
  ApiMemberList,
  ApiMessageList,
  ApiRoom,
  ApiRoomList,
  ApiSendMessageResult,
  ApiStatus,
} from './types.js';

type QueryValue = string | number | boolean | undefined;

export interface CloudRequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  context?: ApiErrorContext;
  /** The request may be sent again after a transient failure (idempotent or idempotency-keyed). */
  retry?: boolean;
  timeoutMs?: number;
  /** Abandons the request (and any retry) when it aborts. */
  signal?: AbortSignal;
}

/** Per-call overrides for requests made on behalf of a wait with a deadline. */
export interface CallOptions {
  timeoutMs?: number;
  /** `false` when the caller retries on its own (and must not overrun its deadline). */
  retry?: boolean;
  /** Abandons the request when it aborts (a wait that was cancelled). */
  signal?: AbortSignal;
}

export interface CloudApiClientOptions {
  requestTimeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

const USER_AGENT = 'agent-communication-mcp';
const ROOM_LIST_PAGE_SIZE = 200;
const MAX_RETRY_AFTER_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CloudApiClient {
  readonly apiUrl: string;
  private readonly token: string;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(config: CloudConfig, options: CloudApiClientOptions = {}) {
    this.apiUrl = config.apiUrl;
    this.token = config.token;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 250;
  }

  /* ---------------------------------------------------------------------
   * rooms
   * ------------------------------------------------------------------ */

  /** GET /rooms, following `nextCursor` until every room of the user is listed. */
  async listRooms(): Promise<ApiRoom[]> {
    const rooms: ApiRoom[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.request<ApiRoomList>('GET', '/rooms', {
        query: { limit: ROOM_LIST_PAGE_SIZE, cursor },
        retry: true,
      });
      rooms.push(...page.rooms);
      cursor = page.nextCursor;
    } while (cursor);
    return rooms;
  }

  /** POST /rooms. The `operationId` makes a resend after an ambiguous failure idempotent. */
  createRoom(roomName: string, description?: string, operationId: string = randomUUID()): Promise<ApiCreateRoomResult> {
    return this.request<ApiCreateRoomResult>('POST', '/rooms', {
      body: { roomName, ...(description !== undefined ? { description } : {}), operationId },
      context: { roomName },
      retry: true,
    });
  }

  /** DELETE /rooms/{roomName}?confirm=true. Not exposed as an MCP tool; never resent (a resend would be a 404). */
  async deleteRoom(roomName: string): Promise<void> {
    await this.request<unknown>('DELETE', `/rooms/${encodeURIComponent(roomName)}`, {
      query: { confirm: true },
      context: { roomName },
    });
  }

  joinRoom(roomName: string, agentName: string, profile?: ApiAgentProfile): Promise<ApiJoinResult> {
    return this.request<ApiJoinResult>('POST', `${this.roomPath(roomName)}/join`, {
      body: { agentName, ...(profile !== undefined ? { profile } : {}) },
      context: { roomName, agentName },
      retry: true,
    });
  }

  /** POST /leave is not idempotent (a second call is 403), so it is never resent automatically. */
  leaveRoom(roomName: string, agentName: string): Promise<ApiLeaveResult> {
    return this.request<ApiLeaveResult>('POST', `${this.roomPath(roomName)}/leave`, {
      body: { agentName },
      context: { roomName, agentName },
    });
  }

  listMembers(roomName: string, includeOffline = true, options: CallOptions = {}): Promise<ApiMemberList> {
    return this.request<ApiMemberList>('GET', `${this.roomPath(roomName)}/members`, {
      query: { includeOffline },
      context: { roomName },
      retry: options.retry ?? true,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  /* ---------------------------------------------------------------------
   * messages
   * ------------------------------------------------------------------ */

  /** POST /rooms/{roomName}/messages. `clientMessageId` makes resending safe (D8). */
  sendMessage(
    roomName: string,
    body: { agentName: string; message: string; clientMessageId: string; metadata?: Record<string, unknown> },
  ): Promise<ApiSendMessageResult> {
    return this.request<ApiSendMessageResult>('POST', `${this.roomPath(roomName)}/messages`, {
      body,
      context: { roomName, agentName: body.agentName },
      retry: true,
    });
  }

  getMessages(
    roomName: string,
    query: ApiGetMessagesQuery,
    options: CallOptions & { context?: ApiErrorContext } = {},
  ): Promise<ApiMessageList> {
    return this.request<ApiMessageList>('GET', `${this.roomPath(roomName)}/messages`, {
      query: { ...query },
      context: options.context ?? { roomName, agentName: query.agentName },
      retry: options.retry ?? true,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  /**
   * DELETE /rooms/{roomName}/messages; `confirm=true` is only sent when the caller confirmed.
   * Never resent: a second clear would also delete messages sent in between and report a wrong count.
   */
  clearRoomMessages(roomName: string, confirm: boolean): Promise<ApiClearMessagesResult> {
    return this.request<ApiClearMessagesResult>('DELETE', `${this.roomPath(roomName)}/messages`, {
      query: { confirm: confirm ? true : undefined },
      context: { roomName, action: 'clearing room messages' },
    });
  }

  /* ---------------------------------------------------------------------
   * management
   * ------------------------------------------------------------------ */

  getStatus(): Promise<ApiStatus> {
    return this.request<ApiStatus>('GET', '/status', { retry: true });
  }

  /* ---------------------------------------------------------------------
   * WebSocket helpers
   * ------------------------------------------------------------------ */

  /** `ws(s)://…/rooms/{roomName}/ws?agentName=…[&since=…]` */
  webSocketUrl(roomName: string, agentName: string, since?: number): string {
    const url = new URL(`${this.apiUrl}${this.roomPath(roomName)}/ws`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('agentName', agentName);
    if (since !== undefined) url.searchParams.set('since', String(since));
    return url.toString();
  }

  requestHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, 'user-agent': USER_AGENT };
  }

  /* ---------------------------------------------------------------------
   * core
   * ------------------------------------------------------------------ */

  private roomPath(roomName: string): string {
    return `/rooms/${encodeURIComponent(roomName)}`;
  }

  async request<T>(method: string, path: string, options: CloudRequestOptions = {}): Promise<T> {
    const url = new URL(`${this.apiUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { ...this.requestHeaders(), accept: 'application/json' };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    for (let attempt = 0; ; attempt++) {
      const canRetry = options.retry === true && attempt < this.maxRetries && !options.signal?.aborted;
      let status: number;
      let text: string;
      let retryAfter: string | null;
      try {
        ({ status, text, retryAfter } = await this.send(url, method, headers, body, options.timeoutMs, options.signal));
      } catch (error) {
        if (!canRetry || options.signal?.aborted) throw error;
        await sleep(this.backoff(attempt));
        continue;
      }

      if (status >= 200 && status < 300) {
        if (!text) return {} as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new AppError(`Cloud API returned invalid JSON for ${method} ${path}`, 'INTERNAL_ERROR', 502);
        }
      }

      const errorBody = parseApiErrorBody(status, text);
      // 502 / 504 come from the Cloudflare edge; 503 and `retryable` errors from agora itself.
      const transient = status === 502 || status === 503 || status === 504 || (status >= 500 && errorBody.retryable === true);
      if (transient && canRetry) {
        await sleep(this.backoff(attempt, retryAfter));
        continue;
      }
      throw toAppError(status, errorBody, options.context);
    }
  }

  private async send(
    url: URL,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    requestTimeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ status: number; text: string; retryAfter: string | null }> {
    const controller = new AbortController();
    const timeoutMs = requestTimeoutMs ?? this.requestTimeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const cancel = (): void => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', cancel, { once: true });

    try {
      const response = await cloudFetch(url, { method, headers, body, signal: controller.signal });
      const text = await response.text();
      return { status: response.status, text, retryAfter: response.headers.get('retry-after') };
    } catch (error) {
      const reason = signal?.aborted
        ? 'cancelled'
        : controller.signal.aborted
          ? `timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? (error.cause instanceof Error ? error.cause.message : error.message)
            : String(error);
      throw new CloudTransportError(`Cloud API request ${method} ${url.pathname} failed: ${reason}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }

  private backoff(attempt: number, retryAfter?: string | null): number {
    const seconds = retryAfter ? Number(retryAfter) : NaN;
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    return Math.min(this.retryBaseDelayMs * 2 ** attempt, 2000);
  }
}
