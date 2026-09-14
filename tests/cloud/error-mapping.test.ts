// API `Error.code` -> existing AppError subclasses (docs/api.yaml components.schemas.Error).
// The table is checked against the enum in docs/api.yaml, then the errors are produced by the real agora
// and observed at the adapters (AppError class, code, status) and through the MCP tools (JSON-RPC code, message).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import {
  AppError,
  AgentNotInRoomError,
  ConfirmationRequiredError,
  InvalidAgentNameError,
  InvalidMessageFormatError,
  InvalidRoomNameError,
  MessageTooLongError,
  RoomAlreadyExistsError,
  RoomCapacityExceededError,
  RoomNotFoundError,
  StorageError,
  ValidationError,
} from '../../src/errors/index.js';
import { CloudApiClient, CloudBackend, parseApiErrorBody, toAppError } from '../../src/cloud/index.js';
import { issueToken } from './harness/agora.js';
import { createMcpClient, McpCallError, withEnv, type McpTestClient } from './harness/mcp.js';
import { AgoraProxy } from './harness/proxy.js';

const agoraUrl = process.env.AGENT_COMM_API_URL!;
const token = process.env.AGENT_COMM_TOKEN!;

/** `components.schemas.Error.properties.code.enum` of docs/api.yaml. */
function apiErrorCodes(): string[] {
  const yaml = readFileSync(path.resolve(__dirname, '../../docs/api.yaml'), 'utf8');
  const errorSchema = yaml.slice(yaml.indexOf('\n    Error:\n'));
  const enumBlock = /\n\s+enum:\n((?:\s+- [A-Z_]+\n)+)/.exec(errorSchema);
  if (!enumBlock) throw new Error('Error.code enum not found in docs/api.yaml');
  return enumBlock[1]!.trim().split('\n').map((line) => line.replace(/^\s*-\s*/, '').trim());
}

const STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  ROOM_NOT_FOUND: 404,
  ROOM_ALREADY_EXISTS: 409,
  ROOM_CAPACITY_EXCEEDED: 429,
  MEMBER_CAPACITY_EXCEEDED: 429,
  DELETE_CONFLICT: 409,
  TOKEN_NOT_FOUND: 404,
  AGENT_NOT_IN_ROOM: 403,
  MESSAGE_TOO_LONG: 400,
  VALIDATION_ERROR: 400,
  INVALID_ROOM_NAME: 400,
  INVALID_AGENT_NAME: 400,
  INVALID_MESSAGE_FORMAT: 400,
  CONFIRMATION_REQUIRED: 400,
  UNAUTHORIZED: 401,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  SIGNUP_DISABLED: 503,
  STORAGE_ERROR: 500,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

const SUBCLASS: Record<string, new (...args: any[]) => AppError> = {
  ROOM_NOT_FOUND: RoomNotFoundError,
  ROOM_ALREADY_EXISTS: RoomAlreadyExistsError,
  ROOM_CAPACITY_EXCEEDED: RoomCapacityExceededError,
  AGENT_NOT_IN_ROOM: AgentNotInRoomError,
  MESSAGE_TOO_LONG: MessageTooLongError,
  VALIDATION_ERROR: ValidationError,
  INVALID_ROOM_NAME: InvalidRoomNameError,
  INVALID_AGENT_NAME: InvalidAgentNameError,
  INVALID_MESSAGE_FORMAT: InvalidMessageFormatError,
  CONFIRMATION_REQUIRED: ConfirmationRequiredError,
  STORAGE_ERROR: StorageError,
};

describe('API error code mapping', () => {
  it('covers every code of docs/api.yaml Error.code', () => {
    const codes = apiErrorCodes();
    expect(codes.length).toBeGreaterThanOrEqual(21);
    for (const code of codes) {
      expect(STATUS[code], `status for ${code}`).toBeDefined();
      const error = toAppError(STATUS[code]!, { code, message: `server says ${code}` }, { roomName: 'r', agentName: 'a' });
      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe(code);
      const subclass = SUBCLASS[code];
      if (subclass) {
        expect(error, code).toBeInstanceOf(subclass);
      } else {
        // No AppError subclass for this code: a plain AppError that keeps the code and the HTTP status.
        expect(error.constructor, code).toBe(AppError);
        expect(error.statusCode).toBe(STATUS[code]);
        expect(error.message).toBe(`server says ${code}`);
      }
    }
  });

  it('rebuilds the file-mode messages from the call context', () => {
    expect(toAppError(404, { code: 'ROOM_NOT_FOUND', message: 'Room not found' }, { roomName: 'lobby' }).message).toBe(
      "Room 'lobby' not found",
    );
    expect(
      toAppError(403, { code: 'AGENT_NOT_IN_ROOM', message: 'Agent is not in the room: bob' }, { roomName: 'lobby', agentName: 'bob' })
        .message,
    ).toBe("Agent 'bob' is not in room 'lobby'");
    expect(toAppError(409, { code: 'ROOM_ALREADY_EXISTS', message: 'x', details: { roomName: 'dup' } }).message).toBe(
      "Room 'dup' already exists",
    );
    expect(toAppError(429, { code: 'ROOM_CAPACITY_EXCEEDED', message: 'x', details: { limit: 7 } }).message).toBe(
      'Maximum number of rooms (7) exceeded',
    );
    expect(toAppError(400, { code: 'CONFIRMATION_REQUIRED', message: 'x' }, { action: 'clearing room messages' }).message).toBe(
      'Confirmation required for clearing room messages',
    );
  });

  it('turns responses without the JSON Error body into a status-based code', () => {
    expect(parseApiErrorBody(502, '<html>Bad gateway</html>')).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(parseApiErrorBody(500, '')).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(parseApiErrorBody(401, 'nope')).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(parseApiErrorBody(404, '{"code":"ROOM_NOT_FOUND","message":"Room not found"}')).toEqual({
      code: 'ROOM_NOT_FOUND',
      message: 'Room not found',
    });
  });
});

/** The MCP SDK sends JSON-RPC `code` and `message` (McpError prefixes "MCP error <code>: "), not `data`. */
async function expectToolError(
  promise: Promise<unknown>,
  expected: { message: string | RegExp; jsonRpcCode?: number },
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(McpCallError);
  const mcpError = error as McpCallError;
  expect(mcpError.code).toBe(expected.jsonRpcCode ?? ErrorCode.InvalidParams);
  const text = mcpError.message.replace(/^MCP error -?\d+: /, '');
  if (typeof expected.message === 'string') expect(text).toBe(expected.message);
  else expect(text).toMatch(expected.message);
}

/** What the adapters throw (and ToolRegistry turns into the JSON-RPC error). */
async function expectAppError(
  promise: Promise<unknown>,
  expected: { code: string; status: number; type?: new (...args: any[]) => AppError; message?: string | RegExp },
): Promise<AppError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected ${expected.code}`).toBeInstanceOf(expected.type ?? AppError);
  const appError = error as AppError;
  expect(appError.code).toBe(expected.code);
  expect(appError.statusCode).toBe(expected.status);
  if (typeof expected.message === 'string') expect(appError.message).toBe(expected.message);
  else if (expected.message) expect(appError.message).toMatch(expected.message);
  return appError;
}

describe('errors returned by agora', () => {
  let client: McpTestClient;
  let backend: CloudBackend;

  beforeEach(async () => {
    client = await createMcpClient();
    backend = new CloudBackend({ apiUrl: agoraUrl, token });
  });

  afterEach(async () => {
    await backend.close();
    await client.close();
  });

  it('ROOM_NOT_FOUND -> RoomNotFoundError for every room tool', async () => {
    const notFound = { code: 'ROOM_NOT_FOUND', status: 404, type: RoomNotFoundError, message: "Room 'missing-room' not found" };
    await expectAppError(backend.rooms.enterRoom({ agentName: 'alice', roomName: 'missing-room' }), notFound);
    await expectAppError(backend.rooms.leaveRoom({ agentName: 'alice', roomName: 'missing-room' }), notFound);
    await expectAppError(backend.rooms.listRoomUsers({ roomName: 'missing-room' }), notFound);
    await expectAppError(backend.messaging.sendMessage({ agentName: 'alice', roomName: 'missing-room', message: 'x' }), notFound);
    await expectAppError(backend.messaging.getMessages({ agentName: 'alice', roomName: 'missing-room' }), notFound);
    await expectAppError(backend.messaging.getMessages({ roomName: 'missing-room' }), notFound);
    await expectAppError(backend.messaging.waitForMessages({ agentName: 'alice', roomName: 'missing-room', timeout: 1000 }), notFound);
    await expectAppError(backend.management.clearRoomMessages({ roomName: 'missing-room', confirm: true }), notFound);

    const message = "Room 'missing-room' not found";
    await expectToolError(client.call('enter_room', { agentName: 'alice', roomName: 'missing-room' }), { message });
    await expectToolError(client.call('list_room_users', { roomName: 'missing-room' }), { message });
    await expectToolError(client.call('send_message', { agentName: 'alice', roomName: 'missing-room', message: 'x' }), { message });
    await expectToolError(client.call('get_messages', { agentName: 'alice', roomName: 'missing-room' }), { message });
    await expectToolError(client.call('wait_for_messages', { agentName: 'alice', roomName: 'missing-room', timeout: 1 }), { message });
    await expectToolError(client.call('clear_room_messages', { roomName: 'missing-room', confirm: true }), { message });
  });

  it('ROOM_ALREADY_EXISTS, AGENT_NOT_IN_ROOM and CONFIRMATION_REQUIRED', async () => {
    await client.call('create_room', { roomName: 'errors' });
    await expectAppError(backend.rooms.createRoom({ roomName: 'errors' }), {
      code: 'ROOM_ALREADY_EXISTS',
      status: 409,
      type: RoomAlreadyExistsError,
      message: "Room 'errors' already exists",
    });
    await expectToolError(client.call('create_room', { roomName: 'errors' }), { message: "Room 'errors' already exists" });

    const notInRoom = {
      code: 'AGENT_NOT_IN_ROOM',
      status: 403,
      type: AgentNotInRoomError,
      message: "Agent 'outsider' is not in room 'errors'",
    };
    await expectAppError(backend.messaging.sendMessage({ agentName: 'outsider', roomName: 'errors', message: 'x' }), notInRoom);
    await expectAppError(backend.messaging.getMessages({ agentName: 'outsider', roomName: 'errors' }), notInRoom);
    await expectAppError(backend.messaging.waitForMessages({ agentName: 'outsider', roomName: 'errors', timeout: 1000 }), notInRoom);
    await expectAppError(backend.rooms.leaveRoom({ agentName: 'outsider', roomName: 'errors' }), notInRoom);
    await expectToolError(client.call('wait_for_messages', { agentName: 'outsider', roomName: 'errors', timeout: 1 }), {
      message: notInRoom.message,
    });

    await expectAppError(backend.management.clearRoomMessages({ roomName: 'errors', confirm: false }), {
      code: 'CONFIRMATION_REQUIRED',
      status: 400,
      type: ConfirmationRequiredError,
      message: 'Confirmation required for clearing room messages',
    });
    await expectToolError(client.call('clear_room_messages', { roomName: 'errors', confirm: false }), {
      message: 'Confirmation required for clearing room messages',
    });
  });

  it('INVALID_MESSAGE_FORMAT, PAYLOAD_TOO_LARGE and VALIDATION_ERROR', async () => {
    await client.call('create_room', { roomName: 'limits' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'limits' });

    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 10; i++) deep = { nested: deep };
    await expectAppError(backend.messaging.sendMessage({ agentName: 'alice', roomName: 'limits', message: 'x', metadata: deep }), {
      code: 'INVALID_MESSAGE_FORMAT',
      status: 400,
      type: InvalidMessageFormatError,
      message: /^Invalid message format: /,
    });
    await expectToolError(client.call('send_message', { agentName: 'alice', roomName: 'limits', message: 'x', metadata: deep }), {
      message: /^Invalid message format: /,
    });

    const big = { blob: 'x'.repeat(70000) };
    await expectAppError(backend.messaging.sendMessage({ agentName: 'alice', roomName: 'limits', message: 'x', metadata: big }), {
      code: 'PAYLOAD_TOO_LARGE',
      status: 413,
    });

    await expectAppError(new CloudApiClient({ apiUrl: agoraUrl, token }).getMessages('limits', { limit: 5000 }), {
      code: 'VALIDATION_ERROR',
      status: 400,
      type: ValidationError,
    });
  });

  it('ROOM_CAPACITY_EXCEEDED -> RoomCapacityExceededError after 50 rooms', async () => {
    for (let i = 0; i < 50; i += 10) {
      await Promise.all(Array.from({ length: 10 }, (_, j) => client.call('create_room', { roomName: `quota-${i + j}` })));
    }
    await expectAppError(backend.rooms.createRoom({ roomName: 'quota-50' }), {
      code: 'ROOM_CAPACITY_EXCEEDED',
      status: 429,
      type: RoomCapacityExceededError,
      message: 'Maximum number of rooms (50) exceeded',
    });
    await expectToolError(client.call('create_room', { roomName: 'quota-51' }), { message: 'Maximum number of rooms (50) exceeded' });
  });

  it('MEMBER_CAPACITY_EXCEEDED keeps its code on AppError', async () => {
    await client.call('create_room', { roomName: 'crowded' });
    for (let i = 0; i < 100; i += 20) {
      await Promise.all(
        Array.from({ length: 20 }, (_, j) => client.call('enter_room', { agentName: `agent-${i + j}`, roomName: 'crowded' })),
      );
    }
    const error = await expectAppError(backend.rooms.enterRoom({ agentName: 'one-too-many', roomName: 'crowded' }), {
      code: 'MEMBER_CAPACITY_EXCEEDED',
      status: 429,
    });
    expect(error.constructor).toBe(AppError);
    await expectToolError(client.call('enter_room', { agentName: 'one-too-many', roomName: 'crowded' }), { message: error.message });
  });

  it('UNAUTHORIZED for a token the API does not know', async () => {
    const stranger = new CloudBackend({ apiUrl: agoraUrl, token: 'agora_not_a_real_token' });
    try {
      await expectAppError(stranger.rooms.listRooms(), { code: 'UNAUTHORIZED', status: 401 });
      // The WebSocket upgrade is refused with the same JSON error.
      await expectAppError(stranger.messaging.waitForMessages({ agentName: 'alice', roomName: 'anything', timeout: 1000 }), {
        code: 'UNAUTHORIZED',
        status: 401,
      });
    } finally {
      await stranger.close();
    }
    const unknown = await withEnv({ AGENT_COMM_TOKEN: 'agora_not_a_real_token' }, () => createMcpClient());
    try {
      await expectToolError(unknown.call('list_rooms'), { message: /token/i });
    } finally {
      await unknown.close();
    }
  });
});

describe('server-side failures injected into agora (FAULT_INJECTION=1)', () => {
  // The agora with FAULT_INJECTION=1 started by the globalSetup.
  const faultAgoraUrl = inject('faultAgoraUrl');
  let proxy: AgoraProxy;
  let client: McpTestClient;
  let backend: CloudBackend;

  beforeAll(async () => {
    const faultToken = await issueToken(faultAgoraUrl, 'fault injection');
    proxy = await AgoraProxy.start(faultAgoraUrl);
    client = await withEnv({ AGENT_COMM_API_URL: proxy.url, AGENT_COMM_TOKEN: faultToken }, () => createMcpClient());
    backend = new CloudBackend({ apiUrl: proxy.url, token: faultToken });
    await client.call('create_room', { roomName: 'faults' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'faults' });
  });

  afterAll(async () => {
    await backend?.close();
    await client?.close();
    await proxy?.close();
  });

  beforeEach(() => {
    proxy.reset();
  });

  it('SERVICE_UNAVAILABLE (retryable) is retried, then reported as an internal MCP error', async () => {
    proxy.extraHeaders = { 'x-agora-fault': 'room.unavailable' };
    await expectAppError(backend.rooms.listRoomUsers({ roomName: 'faults' }), { code: 'SERVICE_UNAVAILABLE', status: 503 });
    expect(proxy.countRequests('GET', '/rooms/faults/members')).toBe(3);

    await expectToolError(client.call('list_room_users', { roomName: 'faults' }), {
      jsonRpcCode: ErrorCode.InternalError,
      message: /unavailable/i,
    });
  });

  it('INTERNAL_ERROR (not retryable) is reported after one request', async () => {
    proxy.extraHeaders = { 'x-agora-fault': 'room.internal' };
    await expectAppError(backend.rooms.listRoomUsers({ roomName: 'faults' }), { code: 'INTERNAL_ERROR', status: 500 });
    expect(proxy.countRequests('GET', '/rooms/faults/members')).toBe(1);
    await expectToolError(client.call('list_room_users', { roomName: 'faults' }), {
      jsonRpcCode: ErrorCode.InternalError,
      message: /Injected fault/,
    });
  });

  it('RATE_LIMITED keeps its code and is not resent', async () => {
    proxy.extraHeaders = { 'x-agora-test-vars': JSON.stringify({ RATE_LIMIT_SEND_PER_MIN: '1' }) };
    await backend.messaging.sendMessage({ agentName: 'alice', roomName: 'faults', message: 'first' });
    await expectAppError(backend.messaging.sendMessage({ agentName: 'alice', roomName: 'faults', message: 'second' }), {
      code: 'RATE_LIMITED',
      status: 429,
    });
    expect(proxy.countRequests('POST', '/rooms/faults/messages')).toBe(2);
  });
});
