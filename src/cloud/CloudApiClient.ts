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
  ApiErrorBody,
  ApiGetMessagesQuery,
  ApiJoinResult,
  ApiLeaveResult,
  ApiMemberList,
  ApiMessageList,
  ApiRoom,
  ApiRoomList,
  ApiSendMessageResult,
  ApiStatus,
  ApiUploadedAttachment,
} from './types.js';

type QueryValue = string | number | boolean | undefined;

/** A file sent as the raw body of POST /rooms/{roomName}/attachments. */
export interface AttachmentUpload {
  /** The attachment's name, sent percent-encoded as `X-File-Name`. */
  name: string;
  contentType: string;
  /** Sent as `Content-Length`: `body` yields exactly this many bytes. */
  size: number;
  body: AsyncIterable<Uint8Array>;
}

/** The response of GET /rooms/{roomName}/attachments/{attachmentId} while its body is read. */
export interface AttachmentDownload {
  /** From `Content-Disposition: attachment; filename*=UTF-8''…`; undefined when the response names no file. */
  name: string | undefined;
  contentType: string;
  /** `Content-Length`, when the response has one. */
  size: number | undefined;
  /** The file's bytes; reading fails with CloudTransportError when the response breaks off or stalls. */
  body: AsyncIterable<Uint8Array>;
}

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

/** 502 / 504 come from the Cloudflare edge; 503 and `retryable` errors from agora itself. */
function isTransient(status: number, errorBody: ApiErrorBody): boolean {
  return status === 502 || status === 503 || status === 504 || (status >= 500 && errorBody.retryable === true);
}

function parseJson<T>(text: string, method: string, path: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError(`Cloud API returned invalid JSON for ${method} ${path}`, 'INTERNAL_ERROR', 502);
  }
}

/**
 * A response body as chunks. Each chunk counts as progress; a body that cannot be read, or that ends before
 * `Content-Length` bytes, is a transport failure. Stopping early cancels the body.
 */
async function* readBody(
  response: Response,
  expectedLength: number | undefined,
  progress: () => void,
  failed: (error: unknown) => Error,
): AsyncGenerator<Uint8Array> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let received = 0;
  let done = false;
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        done = true;
        throw failed(error);
      }
      if (chunk.done) {
        done = true;
        if (expectedLength !== undefined && received !== expectedLength) {
          throw failed(new Error(`the response ended after ${received} of ${expectedLength} bytes`));
        }
        return;
      }
      received += chunk.value.byteLength;
      progress();
      yield chunk.value;
    }
  } finally {
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function readText(body: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** The file name of `Content-Disposition: attachment; filename*=UTF-8''<percent-encoded>` (RFC 5987 / 6266). */
function fileNameFromContentDisposition(header: string | null): string | undefined {
  const encoded = header ? /(?:^|;)\s*filename\*\s*=\s*UTF-8'[^']*'([^;\s]+)/i.exec(header)?.[1] : undefined;
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
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

  /**
   * POST /rooms/{roomName}/messages. `clientMessageId` makes resending safe (D8), with attachments too: agora answers
   * a resend from its record before it looks at the attachments.
   */
  sendMessage(
    roomName: string,
    body: {
      agentName: string;
      message: string;
      clientMessageId: string;
      metadata?: Record<string, unknown>;
      attachments?: string[];
    },
    options: { signal?: AbortSignal } = {},
  ): Promise<ApiSendMessageResult> {
    return this.request<ApiSendMessageResult>('POST', `${this.roomPath(roomName)}/messages`, {
      body,
      context: { roomName, agentName: body.agentName },
      retry: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  /* ---------------------------------------------------------------------
   * attachments (D13)
   * ------------------------------------------------------------------ */

  /**
   * POST /rooms/{roomName}/attachments with the file as the raw body, streamed. Never resent: the body can be read only
   * once, and an upload is not idempotent (one that is never attached is deleted by agora after an hour).
   */
  uploadAttachment(
    roomName: string,
    agentName: string,
    upload: AttachmentUpload,
    options: { signal?: AbortSignal; context?: ApiErrorContext } = {},
  ): Promise<ApiUploadedAttachment> {
    const url = this.url(`${this.roomPath(roomName)}/attachments`, { agentName });
    const headers = {
      ...this.requestHeaders(),
      accept: 'application/json',
      'content-type': upload.contentType,
      'content-length': String(upload.size),
      'x-file-name': encodeURIComponent(upload.name),
    };
    const context = options.context ?? { roomName, agentName };
    return this.transfer('POST', url, headers, upload.body, options.signal, async (response, body) => {
      const text = await readText(body);
      if (response.ok) return parseJson<ApiUploadedAttachment>(text, 'POST', url.pathname);
      throw toAppError(response.status, parseApiErrorBody(response.status, text), context);
    });
  }

  /**
   * GET /rooms/{roomName}/attachments/{attachmentId}; `save` reads the body while the download is guarded (it is
   * abandoned when no bytes arrive for the request timeout). Resent after a transient failure until `save` starts.
   */
  async downloadAttachment<T>(
    roomName: string,
    attachmentId: string,
    save: (download: AttachmentDownload) => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const url = this.url(`${this.roomPath(roomName)}/attachments/${encodeURIComponent(attachmentId)}`);
    const headers = { ...this.requestHeaders(), accept: '*/*' };
    const context = { roomName, attachmentId };

    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < this.maxRetries;
      let saving = false;
      let retryAfter: string | null = null;
      try {
        const saved = await this.transfer('GET', url, headers, undefined, options.signal, async (response, body) => {
          if (!response.ok) {
            const text = await readText(body);
            const errorBody = parseApiErrorBody(response.status, text);
            if (!canRetry || !isTransient(response.status, errorBody)) throw toAppError(response.status, errorBody, context);
            retryAfter = response.headers.get('retry-after');
            return undefined;
          }
          saving = true;
          const length = Number(response.headers.get('content-length') ?? NaN);
          return {
            value: await save({
              name: fileNameFromContentDisposition(response.headers.get('content-disposition')),
              contentType: response.headers.get('content-type') || 'application/octet-stream',
              size: Number.isSafeInteger(length) && length >= 0 ? length : undefined,
              body,
            }),
          };
        });
        if (saved) return saved.value;
      } catch (error) {
        if (!(error instanceof CloudTransportError) || saving || !canRetry || options.signal?.aborted) throw error;
      }
      if (options.signal?.aborted) throw new CloudTransportError(`Cloud API request GET ${url.pathname} failed: cancelled`);
      await sleep(this.backoff(attempt, retryAfter));
    }
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

  private url(path: string, query: Record<string, QueryValue> = {}): URL {
    const url = new URL(`${this.apiUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  async request<T>(method: string, path: string, options: CloudRequestOptions = {}): Promise<T> {
    const url = this.url(path, options.query);
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
        return parseJson<T>(text, method, path);
      }

      const errorBody = parseApiErrorBody(status, text);
      if (isTransient(status, errorBody) && canRetry) {
        await sleep(this.backoff(attempt, retryAfter));
        continue;
      }
      throw toAppError(status, errorBody, options.context);
    }
  }

  /**
   * One request whose body or response body may take longer than a request timeout: it is abandoned only when no bytes
   * move for `requestTimeoutMs`, or when `signal` aborts. `read` gets the response while that guard is in place; the
   * response body is released when `read` returns. Transport failures, reading the response body included, become
   * CloudTransportError; errors thrown by the source of the request body and by `read` itself are passed on.
   */
  private async transfer<T>(
    method: string,
    url: URL,
    headers: Record<string, string>,
    body: AsyncIterable<Uint8Array> | undefined,
    signal: AbortSignal | undefined,
    read: (response: Response, body: AsyncIterable<Uint8Array>) => Promise<T>,
  ): Promise<T> {
    const idleTimeoutMs = this.requestTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), idleTimeoutMs);
    const progress = (): void => void timer.refresh();
    const cancel = (): void => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', cancel, { once: true });

    const failed = (error: unknown): CloudTransportError => {
      const reason = signal?.aborted
        ? 'cancelled'
        : controller.signal.aborted
          ? `no data for ${idleTimeoutMs}ms`
          : error instanceof Error
            ? (error.cause instanceof Error ? error.cause.message : error.message)
            : String(error);
      return new CloudTransportError(`Cloud API request ${method} ${url.pathname} failed: ${reason}`);
    };

    // An error of the body's source (e.g. the local file could not be read) is reported instead of "fetch failed".
    let sourceError: unknown;
    const requestBody = body
      ? (async function* () {
          try {
            for await (const chunk of body) {
              progress();
              yield chunk;
            }
          } catch (error) {
            if (!controller.signal.aborted) sourceError = error;
            throw error;
          }
        })()
      : undefined;

    try {
      let response: Response;
      try {
        response = await cloudFetch(url, { method, headers, body: requestBody, duplex: 'half', signal: controller.signal });
      } catch (error) {
        throw sourceError ?? failed(error);
      }
      progress();
      const length = Number(response.headers.get('content-length') ?? NaN);
      return await read(response, readBody(response, Number.isSafeInteger(length) ? length : undefined, progress, failed));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      // Releases a response body that `read` did not consume (nothing happens to one that was read to the end).
      controller.abort();
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
