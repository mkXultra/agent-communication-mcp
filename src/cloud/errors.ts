// Agent Communication MCP Server - Cloud API error mapping
// docs/api.yaml `Error.code` uses the same code system as the existing AppError classes, so an API
// error is turned back into the AppError subclass the file mode would have thrown. The subclass
// constructors rebuild the existing messages (e.g. "Room 'x' not found") from the call context.

import {
  AppError,
  RoomNotFoundError,
  RoomAlreadyExistsError,
  RoomCapacityExceededError,
  AgentNotInRoomError,
  MessageTooLongError,
  ValidationError,
  ConfirmationRequiredError,
  InvalidRoomNameError,
  InvalidAgentNameError,
  InvalidMessageFormatError,
  StorageError,
} from '../errors/index.js';
import type { ApiErrorBody } from './types.js';

/** What the caller was doing; used to rebuild the file-mode error messages. */
export interface ApiErrorContext {
  roomName?: string;
  agentName?: string;
  /** Wording for ConfirmationRequiredError, e.g. "clearing room messages". */
  action?: string;
  /** Operation name for StorageError. */
  operation?: string;
}

const DEFAULT_ROOM_LIMIT = 50;
const DEFAULT_MESSAGE_LENGTH = 2000;

function detailString(details: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = details?.[key];
  return typeof value === 'string' ? value : undefined;
}

function detailNumber(details: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = details?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Error code for a response whose body is not the API's JSON `Error` (e.g. a Cloudflare platform page). */
export function codeForStatus(status: number): string {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 413) return 'PAYLOAD_TOO_LARGE';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503 || status === 502 || status === 504) return 'SERVICE_UNAVAILABLE';
  if (status >= 500) return 'INTERNAL_ERROR';
  return 'VALIDATION_ERROR';
}

export function parseApiErrorBody(status: number, text: string): ApiErrorBody {
  try {
    const parsed = JSON.parse(text) as Partial<ApiErrorBody> | null;
    if (parsed && typeof parsed.code === 'string' && typeof parsed.message === 'string') {
      return {
        code: parsed.code,
        message: parsed.message,
        ...(typeof parsed.retryable === 'boolean' ? { retryable: parsed.retryable } : {}),
        ...(parsed.details && typeof parsed.details === 'object' ? { details: parsed.details } : {}),
      };
    }
  } catch {
    // Not JSON: fall through to a status-based error.
  }
  return { code: codeForStatus(status), message: `Cloud API responded with HTTP ${status}` };
}

/** Converts an API error into the matching AppError subclass (unknown codes keep their code on AppError). */
export function toAppError(status: number, body: ApiErrorBody, context: ApiErrorContext = {}): AppError {
  const details = body.details;
  const roomName = context.roomName ?? detailString(details, 'roomName') ?? '';
  const agentName = context.agentName ?? detailString(details, 'agentName') ?? '';

  switch (body.code) {
    case 'ROOM_NOT_FOUND':
      return new RoomNotFoundError(roomName);
    case 'ROOM_ALREADY_EXISTS':
      return new RoomAlreadyExistsError(roomName);
    case 'ROOM_CAPACITY_EXCEEDED':
      return new RoomCapacityExceededError(detailNumber(details, 'limit') ?? DEFAULT_ROOM_LIMIT);
    case 'AGENT_NOT_IN_ROOM':
      return new AgentNotInRoomError(agentName, roomName);
    case 'MESSAGE_TOO_LONG':
      return new MessageTooLongError(detailNumber(details, 'limit') ?? DEFAULT_MESSAGE_LENGTH);
    case 'VALIDATION_ERROR':
      return new ValidationError(detailString(details, 'field') ?? 'request', body.message);
    case 'CONFIRMATION_REQUIRED':
      return new ConfirmationRequiredError(context.action ?? 'this operation');
    case 'INVALID_ROOM_NAME':
      return new InvalidRoomNameError(detailString(details, 'roomName') ?? roomName);
    case 'INVALID_AGENT_NAME':
      return new InvalidAgentNameError(detailString(details, 'agentName') ?? agentName);
    case 'INVALID_MESSAGE_FORMAT':
      return new InvalidMessageFormatError(body.message);
    case 'STORAGE_ERROR':
      return new StorageError(context.operation ?? 'cloud', body.message);
    default:
      return new AppError(body.message, body.code, status);
  }
}

/** The request never produced an HTTP response (DNS, connection refused, timeout, ...). */
export class CloudTransportError extends AppError {
  constructor(message: string) {
    super(message, 'SERVICE_UNAVAILABLE', 503);
  }
}
