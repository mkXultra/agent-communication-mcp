// File attachments in cloud mode (docs/cloud-architecture.md §3.9, D13) against the real agora, whose R2 is emulated by
// wrangler dev: send_message checks and uploads local files before it sends, get_messages and wait_for_messages return
// the messages' `attachments`, and download_attachment streams one to a local file without replacing an existing file.
//
// A request body that a client abandons while agora is still reading it takes the whole local `wrangler dev` down (the
// R2 emulation), so no test here aborts an upload that has reached agora: uploads are only cut off while the proxy holds
// the request (it never reaches agora) or holds a response agora has already sent.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { randomBytes, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import {
  AgentNotInRoomError,
  AppError,
  AttachmentNotFoundError,
  AttachmentTooLargeError,
  FileAlreadyExistsError,
  FileNotFoundError,
  StorageError,
} from '../../src/errors/index.js';
import { CloudApiClient, CloudBackend, CloudTransportError, getCloudBackend } from '../../src/cloud/index.js';
import type { ApiRoomStatus } from '../../src/cloud/types.js';
import { ToolRegistry } from '../../src/server/ToolRegistry.js';
import { MemoryTransport } from '../helpers/MemoryTransport.js';
import { deleteAllRooms, issueToken } from './harness/agora.js';
import { createMcpClient, McpCallError, sleep, waitUntil, withEnv, type McpTestClient } from './harness/mcp.js';
import { AgoraProxy } from './harness/proxy.js';

const agoraUrl = process.env.AGENT_COMM_API_URL!;
const token = process.env.AGENT_COMM_TOKEN!;

const TEN_MB = 10 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface ToolAttachment {
  id: string;
  name: string;
  size: number;
  contentType: string;
}

interface ToolMessage {
  id: string;
  agentName: string;
  roomName: string;
  message: string;
  timestamp: string;
  mentions: string[];
  attachments?: ToolAttachment[];
}

interface WaitResult {
  messages: ToolMessage[];
  hasNewMessages: boolean;
  timedOut: boolean;
}

interface DownloadResult {
  path: string;
  name: string;
  size: number;
  contentType: string;
}

/** A failed tool call: its JSON-RPC code and its message without the "MCP error <code>: " prefix of the SDK. */
async function toolError(promise: Promise<unknown>): Promise<{ code: number; message: string }> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(McpCallError);
  const mcpError = error as McpCallError;
  return { code: mcpError.code, message: mcpError.message.replace(/^MCP error -?\d+: /, '') };
}

/** A failed adapter call (the AppError that ToolRegistry turns into the JSON-RPC error, with its code). */
async function appError(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

async function setupRoom(client: McpTestClient, roomName: string, agents: string[]): Promise<void> {
  await client.call('create_room', { roomName });
  for (const agentName of agents) await client.call('enter_room', { agentName, roomName });
}

async function attachmentsOf(client: McpTestClient, roomName: string): Promise<ToolAttachment[]> {
  const { messages } = await client.call<{ messages: ToolMessage[] }>('get_messages', { roomName, limit: 1 });
  return messages[0]?.attachments ?? [];
}

async function roomStatus(api: CloudApiClient, roomName: string): Promise<ApiRoomStatus> {
  return api.request('GET', `/rooms/${roomName}/status`);
}

describe('file attachments in cloud mode', () => {
  let proxy: AgoraProxy;
  let client: McpTestClient;
  let workDir: string;
  const api = new CloudApiClient({ apiUrl: agoraUrl, token });
  const env = () => ({ AGENT_COMM_API_URL: proxy.url, AGENT_COMM_TOKEN: token });
  /** The backend the MCP client uses (the adapters' AppErrors come from it). */
  const backend = () => getCloudBackend(env())!;

  /** Writes a file to send in this test's directory. */
  async function localFile(name: string, content: Buffer | string): Promise<string> {
    const file = path.join(workDir, 'upload', name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    return file;
  }

  /** A file of `size` zero bytes that takes no disk space. */
  async function sparseFile(name: string, size: number): Promise<string> {
    const file = await localFile(name, '');
    await fs.truncate(file, size);
    return file;
  }

  async function saveDirectory(name: string): Promise<string> {
    const directory = path.join(workDir, name);
    await fs.mkdir(directory, { recursive: true });
    return directory;
  }

  beforeAll(async () => {
    proxy = await AgoraProxy.start(agoraUrl);
  });

  afterAll(async () => {
    await proxy.close();
  });

  beforeEach(async () => {
    proxy.reset();
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-comm-attachments-'));
    client = await withEnv(env(), () => createMcpClient());
  });

  afterEach(async () => {
    await client.close();
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('lists download_attachment and the attachments of send_message', async () => {
    const server = new Server({ name: 'agent-communication', version: '1.0.0' }, { capabilities: { tools: {} } });
    const transport = new MemoryTransport();
    const registry = new ToolRegistry();
    await server.connect(transport);
    await registry.registerAll(server);
    try {
      const response = await transport.simulateRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      const tools = (response.result as { tools: Array<{ name: string; inputSchema: any }> }).tools;
      expect(tools).toHaveLength(11);
      const download = tools.find((tool) => tool.name === 'agent_communication_download_attachment')!;
      expect(download.inputSchema.required).toEqual(['roomName', 'attachmentId', 'savePath']);
      const send = tools.find((tool) => tool.name === 'agent_communication_send_message')!;
      expect(send.inputSchema.properties.attachments).toMatchObject({ type: 'array', items: { type: 'string' }, maxItems: 10 });
      expect(send.inputSchema.required).toEqual(['agentName', 'roomName', 'message']);
    } finally {
      await transport.close();
      await registry.shutdown();
    }
  });

  it('sends two files with a message, returns them from get_messages and downloads them byte for byte', async () => {
    await setupRoom(client, 'files', ['alice', 'bob']);
    const binary = randomBytes(1024 * 1024);
    const binaryPath = await localFile('data.bin', binary);
    const text = Buffer.from('日本語のログ\n二行目\n');
    const textPath = await localFile('日本語のレポート.txt', text);

    const sent = await client.call('send_message', {
      agentName: 'alice',
      roomName: 'files',
      message: 'results for @bob',
      attachments: [binaryPath, textPath],
    });
    // The output of send_message does not change.
    expect(Object.keys(sent)).toEqual(['success', 'messageId', 'timestamp', 'roomName', 'mentions']);
    expect(sent).toMatchObject({ success: true, roomName: 'files', mentions: ['bob'] });

    const { messages } = await client.call<{ messages: ToolMessage[] }>('get_messages', { agentName: 'bob', roomName: 'files' });
    expect(messages).toEqual([
      {
        id: sent.messageId,
        agentName: 'alice',
        roomName: 'files',
        message: 'results for @bob',
        timestamp: sent.timestamp,
        mentions: ['bob'],
        attachments: [
          { id: expect.stringMatching(UUID), name: 'data.bin', size: binary.length, contentType: 'application/octet-stream' },
          { id: expect.stringMatching(UUID), name: '日本語のレポート.txt', size: text.length, contentType: 'text/plain' },
        ],
      },
    ]);
    const [binaryInfo, textInfo] = messages[0]!.attachments!;

    // savePath is a directory: the files keep their names there.
    const directory = await saveDirectory('into-directory');
    const binaryIntoDirectory = await client.call<DownloadResult>('download_attachment', {
      roomName: 'files',
      attachmentId: binaryInfo!.id,
      savePath: directory,
    });
    expect(Object.keys(binaryIntoDirectory)).toEqual(['path', 'name', 'size', 'contentType']);
    expect(binaryIntoDirectory).toEqual({
      path: path.join(directory, 'data.bin'),
      name: 'data.bin',
      size: binary.length,
      contentType: 'application/octet-stream',
    });
    expect((await fs.readFile(binaryIntoDirectory.path)).equals(binary)).toBe(true);

    const textIntoDirectory = await client.call<DownloadResult>('download_attachment', {
      roomName: 'files',
      attachmentId: textInfo!.id,
      savePath: directory,
    });
    expect(textIntoDirectory).toEqual({
      path: path.join(directory, '日本語のレポート.txt'),
      name: '日本語のレポート.txt',
      size: text.length,
      contentType: 'text/plain',
    });
    expect((await fs.readFile(textIntoDirectory.path)).equals(text)).toBe(true);
    // Nothing else was written (no temporary file is left).
    expect((await fs.readdir(directory)).sort()).toEqual(['data.bin', '日本語のレポート.txt'].sort());

    // savePath is the path of a new file: saved under that name, `name` is still the attachment's.
    const asFiles = await saveDirectory('as-files');
    const binaryFile = path.join(asFiles, 'copy of data.bin');
    expect(
      await client.call<DownloadResult>('download_attachment', { roomName: 'files', attachmentId: binaryInfo!.id, savePath: binaryFile }),
    ).toEqual({ path: binaryFile, name: 'data.bin', size: binary.length, contentType: 'application/octet-stream' });
    expect((await fs.readFile(binaryFile)).equals(binary)).toBe(true);

    const textFile = path.join(asFiles, 'ログ.txt');
    expect(
      await client.call<DownloadResult>('download_attachment', { roomName: 'files', attachmentId: textInfo!.id, savePath: textFile }),
    ).toEqual({ path: textFile, name: '日本語のレポート.txt', size: text.length, contentType: 'text/plain' });
    expect((await fs.readFile(textFile)).equals(text)).toBe(true);
    expect((await fs.readdir(asFiles)).sort()).toEqual(['copy of data.bin', 'ログ.txt'].sort());

    // The bytes went through the HTTP API as a stream, not through the MCP response.
    expect(proxy.countRequests('POST', '/rooms/files/attachments?agentName=alice')).toBe(2);
    expect(proxy.countRequests('GET', `/rooms/files/attachments/${binaryInfo!.id}`)).toBe(2);
  });

  it('leaves attachments out of messages that have none', async () => {
    await setupRoom(client, 'plain', ['alice']);
    await client.call('send_message', { agentName: 'alice', roomName: 'plain', message: 'no files', attachments: [] });
    const { messages } = await client.call<{ messages: ToolMessage[] }>('get_messages', { roomName: 'plain' });
    expect(Object.keys(messages[0]!)).toEqual(['id', 'agentName', 'roomName', 'message', 'timestamp', 'mentions']);
    expect(proxy.countRequests('POST', '/rooms/plain/attachments')).toBe(0);
  });

  it('accepts 10 files and a file of exactly 10 MB', async () => {
    await setupRoom(client, 'limits', ['alice']);
    const exact = await sparseFile('exactly-10mb.bin', TEN_MB);
    await client.call('send_message', { agentName: 'alice', roomName: 'limits', message: 'big', attachments: [exact] });
    expect(await attachmentsOf(client, 'limits')).toEqual([
      { id: expect.stringMatching(UUID), name: 'exactly-10mb.bin', size: TEN_MB, contentType: 'application/octet-stream' },
    ]);

    const ten = await Promise.all(Array.from({ length: 10 }, (_, i) => localFile(`part-${i}.json`, JSON.stringify({ part: i }))));
    await client.call('send_message', { agentName: 'alice', roomName: 'limits', message: 'many', attachments: ten });
    expect((await attachmentsOf(client, 'limits')).map((attachment) => [attachment.name, attachment.contentType])).toEqual(
      ten.map((_, i) => [`part-${i}.json`, 'application/json']),
    );
  });

  it('checks every file before uploading anything: a missing path, over 10 MB, 11 files, a directory, an empty file', async () => {
    await setupRoom(client, 'precheck', ['alice']);
    const ok = await localFile('ok.txt', 'fine');
    const missing = path.join(workDir, 'upload', 'missing.txt');
    const tooLarge = await sparseFile('too-large.bin', TEN_MB + 1);
    const directory = path.join(workDir, 'upload');
    const empty = await localFile('empty.txt', '');
    proxy.reset();

    const send = (attachments: string[]) =>
      client.call('send_message', { agentName: 'alice', roomName: 'precheck', message: 'x', attachments });
    const invalid = ErrorCode.InvalidParams;
    expect(await toolError(send([ok, missing]))).toEqual({ code: invalid, message: `File not found: ${missing}` });
    expect(await toolError(send([ok, tooLarge]))).toEqual({
      code: invalid,
      message: `Attachment '${tooLarge}' exceeds maximum size of 10485760 bytes`,
    });
    expect(await toolError(send(Array.from({ length: 11 }, () => ok)))).toEqual({
      code: invalid,
      message: "Validation failed for field 'attachments': At most 10 files can be attached to a message (got 11)",
    });
    expect(await toolError(send([directory]))).toEqual({
      code: invalid,
      message: `Validation failed for field 'attachments[0]': '${directory}' is not a regular file`,
    });
    expect(await toolError(send([ok, empty]))).toEqual({
      code: invalid,
      message: `Validation failed for field 'attachments[1]': '${empty}' is empty (an empty file cannot be attached)`,
    });

    // The codes behind those messages.
    const sendThroughAdapter = (attachments: string[]) =>
      backend().messaging.sendMessage({ agentName: 'alice', roomName: 'precheck', message: 'x', attachments });
    expect(await appError(sendThroughAdapter([missing]))).toBeInstanceOf(FileNotFoundError);
    const tooLargeError = await appError(sendThroughAdapter([tooLarge]));
    expect(tooLargeError).toBeInstanceOf(AttachmentTooLargeError);
    expect(tooLargeError).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', statusCode: 413 });
    expect(await appError(sendThroughAdapter(Array.from({ length: 11 }, () => ok)))).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await appError(sendThroughAdapter([directory]))).toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });

    // None of them called the API, and nothing was sent.
    expect(proxy.requests).toEqual([]);
    expect((await api.getMessages('precheck', { limit: 10 })).messages).toEqual([]);
    expect((await roomStatus(api, 'precheck')).attachmentCount).toBe(0);
  });

  it('never overwrites an existing file', async () => {
    await setupRoom(client, 'keep', ['alice']);
    const source = await localFile('notes.txt', 'from the room');
    await client.call('send_message', { agentName: 'alice', roomName: 'keep', message: 'notes', attachments: [source] });
    const [notes] = await attachmentsOf(client, 'keep');

    const directory = await saveDirectory('existing');
    const existing = path.join(directory, 'notes.txt');
    await fs.writeFile(existing, 'already here');
    const dangling = path.join(directory, 'dangling.txt');
    await fs.symlink(path.join(directory, 'nowhere.txt'), dangling);
    proxy.reset();

    const download = (savePath: string) => client.call('download_attachment', { roomName: 'keep', attachmentId: notes!.id, savePath });
    // savePath is an existing file, or a symbolic link (even one to nothing): refused before downloading.
    expect(await toolError(download(existing))).toEqual({ code: ErrorCode.InvalidParams, message: `File already exists: ${existing}` });
    expect(await toolError(download(dangling))).toEqual({ code: ErrorCode.InvalidParams, message: `File already exists: ${dangling}` });
    expect(proxy.countRequests('GET', '/rooms/keep/attachments/')).toBe(0);
    // savePath is a directory with a file of the attachment's name.
    expect(await toolError(download(directory))).toEqual({ code: ErrorCode.InvalidParams, message: `File already exists: ${existing}` });

    const refused = await appError(backend().messaging.downloadAttachment({ roomName: 'keep', attachmentId: notes!.id, savePath: existing }));
    expect(refused).toBeInstanceOf(FileAlreadyExistsError);
    expect(refused).toMatchObject({ code: 'FILE_ALREADY_EXISTS', statusCode: 409 });

    expect(await fs.readFile(existing, 'utf8')).toBe('already here');
    expect(await fs.readlink(dangling)).toBe(path.join(directory, 'nowhere.txt'));
    expect((await fs.readdir(directory)).sort()).toEqual(['dangling.txt', 'notes.txt']);

    // A file that appears while the download is on its way is not replaced either.
    const late = path.join(directory, 'late.txt');
    proxy.delayResponses((request) => request.method === 'GET' && request.path.startsWith('/rooms/keep/attachments/'), 1000);
    const racing = download(late);
    await sleep(300);
    await fs.writeFile(late, 'written meanwhile');
    expect(await toolError(racing)).toEqual({ code: ErrorCode.InvalidParams, message: `File already exists: ${late}` });
    expect(await fs.readFile(late, 'utf8')).toBe('written meanwhile');
    expect((await fs.readdir(directory)).sort()).toEqual(['dangling.txt', 'late.txt', 'notes.txt']);

    // A directory that does not exist is not created.
    const missingDirectory = path.join(directory, 'missing');
    expect(await toolError(download(`${missingDirectory}${path.sep}`))).toEqual({
      code: ErrorCode.InvalidParams,
      message: `Validation failed for field 'savePath': Directory not found: ${missingDirectory}`,
    });
    expect(await toolError(download(path.join(missingDirectory, 'notes.txt')))).toEqual({
      code: ErrorCode.InvalidParams,
      message: `Validation failed for field 'savePath': Directory not found: ${missingDirectory}`,
    });
    await expect(fs.access(missingDirectory)).rejects.toThrow();
  });

  it('delivers attachments to wait_for_messages over the WebSocket', async () => {
    await setupRoom(client, 'ws-files', ['alice', 'bob']);
    const report = await localFile('report.json', '{"ok":true}');

    const waiting = client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'ws-files', timeout: 15 });
    await waitUntil(
      async () => (await api.listMembers('ws-files')).members.find((m) => m.agentName === 'alice')?.waiting === true,
      10000,
      'alice waiting',
    );
    await client.call('send_message', { agentName: 'bob', roomName: 'ws-files', message: 'done @alice', attachments: [report] });
    const result = await waiting;
    expect(result).toMatchObject({ hasNewMessages: true, timedOut: false });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.attachments).toEqual([
      { id: expect.stringMatching(UUID), name: 'report.json', size: 11, contentType: 'application/json' },
    ]);

    // The message came over the WebSocket, not over long polling.
    expect(proxy.requests.filter((r) => r.method === 'UPGRADE').map((r) => r.path)).toEqual([
      expect.stringMatching(/^\/rooms\/ws-files\/ws\?agentName=alice/),
    ]);
    expect(proxy.requests.some((r) => r.method === 'GET' && /[?&]wait=/.test(r.path))).toBe(false);
    expect(backend().waits.hasOpenSocket('ws-files', 'alice')).toBe(true);

    // The ID from the WebSocket frame downloads the file.
    const directory = await saveDirectory('from-ws');
    const saved = await client.call<DownloadResult>('download_attachment', {
      roomName: 'ws-files',
      attachmentId: result.messages[0]!.attachments![0]!.id,
      savePath: directory,
    });
    expect(await fs.readFile(saved.path, 'utf8')).toBe('{"ok":true}');
  });

  it('delivers attachments to wait_for_messages over long polling when the WebSocket is refused', async () => {
    proxy.webSocketPolicy = 'reject';
    await setupRoom(client, 'lp-files', ['alice', 'bob']);
    const image = await localFile('chart.png', randomBytes(2048));

    setTimeout(
      () => void client.call('send_message', { agentName: 'bob', roomName: 'lp-files', message: 'chart @alice', attachments: [image] }),
      500,
    );
    const result = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'lp-files', timeout: 10 });
    expect(result.messages[0]!.attachments).toEqual([
      { id: expect.stringMatching(UUID), name: 'chart.png', size: 2048, contentType: 'image/png' },
    ]);
    expect(proxy.requests.some((r) => r.method === 'GET' && /[?&]wait=/.test(r.path))).toBe(true);
  });

  it('reports a missing attachment or room, a malformed ID and an agent outside the room', async () => {
    await setupRoom(client, 'lookup', ['alice']);
    const directory = await saveDirectory('lookup');
    const unknownId = randomUUID();

    expect(
      await toolError(client.call('download_attachment', { roomName: 'lookup', attachmentId: unknownId, savePath: directory })),
    ).toEqual({ code: ErrorCode.InvalidParams, message: `Attachment '${unknownId}' not found` });
    const notFound = await appError(
      backend().messaging.downloadAttachment({ roomName: 'lookup', attachmentId: unknownId, savePath: directory }),
    );
    expect(notFound).toBeInstanceOf(AttachmentNotFoundError);
    expect(notFound).toMatchObject({ code: 'ATTACHMENT_NOT_FOUND', statusCode: 404 });

    expect(
      await toolError(client.call('download_attachment', { roomName: 'no-such-room', attachmentId: unknownId, savePath: directory })),
    ).toEqual({ code: ErrorCode.InvalidParams, message: "Room 'no-such-room' not found" });

    proxy.reset();
    expect(
      await toolError(client.call('download_attachment', { roomName: 'lookup', attachmentId: 'not-a-uuid', savePath: directory })),
    ).toEqual({ code: ErrorCode.InvalidParams, message: "Validation failed for field 'attachmentId': Attachment ID must be a UUID" });
    expect(proxy.requests).toEqual([]);
    expect(await fs.readdir(directory)).toEqual([]);

    // Sending an ID that was never uploaded by this agent: ATTACHMENT_NOT_FOUND with the 400 of sendMessage.
    const refused = await appError(
      api.sendMessage('lookup', { agentName: 'alice', message: 'x', clientMessageId: randomUUID(), attachments: [unknownId] }),
    );
    expect(refused).toBeInstanceOf(AttachmentNotFoundError);
    expect(refused).toMatchObject({ code: 'ATTACHMENT_NOT_FOUND', statusCode: 400, message: `Attachment '${unknownId}' not found` });

    // Only members upload: the send fails with the error of the upload, and nothing is sent.
    const file = await localFile('outsider.txt', 'not mine to share');
    expect(
      await toolError(client.call('send_message', { agentName: 'outsider', roomName: 'lookup', message: 'x', attachments: [file] })),
    ).toEqual({ code: ErrorCode.InvalidParams, message: "Agent 'outsider' is not in room 'lookup'" });
    expect(
      await appError(backend().messaging.sendMessage({ agentName: 'outsider', roomName: 'lookup', message: 'x', attachments: [file] })),
    ).toBeInstanceOf(AgentNotInRoomError);
    expect(proxy.countRequests('POST', '/rooms/lookup/messages')).toBe(0);
  });

  it('stops uploading and does not send when the tool call is cancelled', async () => {
    await setupRoom(client, 'cancel', ['alice']);
    const first = await localFile('first.txt', 'first');
    const second = await localFile('second.txt', 'second');
    // agora answers the first upload; the proxy holds that answer back while the call is cancelled.
    proxy.delayResponses((request) => request.method === 'POST' && request.path.startsWith('/rooms/cancel/attachments'), 1500);

    const pending = client.start('send_message', { agentName: 'alice', roomName: 'cancel', message: 'x', attachments: [first, second] });
    let answered = false;
    pending.result.then(
      () => (answered = true),
      (error: unknown) => {
        if (error instanceof McpCallError) answered = true;
      },
    );
    await waitUntil(async () => (await roomStatus(api, 'cancel')).attachmentCount === 1, 10000, 'first upload stored');
    pending.cancel('tool call timed out');

    await sleep(2500);
    expect(proxy.countRequests('POST', '/rooms/cancel/attachments')).toBe(1);
    expect(proxy.countRequests('POST', '/rooms/cancel/messages')).toBe(0);
    expect((await api.getMessages('cancel', { limit: 10 })).messages).toEqual([]);
    // No response is sent for a cancelled call.
    expect(answered).toBe(false);
  });

  it('gives up on a download or an upload that receives nothing for the request timeout', async () => {
    await setupRoom(client, 'stalled', ['alice']);
    const file = await localFile('stalled.txt', 'waiting');
    await client.call('send_message', { agentName: 'alice', roomName: 'stalled', message: 'x', attachments: [file] });
    const [attachment] = await attachmentsOf(client, 'stalled');
    const directory = await saveDirectory('stalled');

    const impatient = new CloudBackend({ apiUrl: proxy.url, token }, { api: { requestTimeoutMs: 500, retryBaseDelayMs: 50 } });
    try {
      // Held requests never reach agora.
      proxy.reset();
      proxy.holdRequests((request) => request.method === 'GET' && request.path.startsWith('/rooms/stalled/attachments/'));
      const download = await appError(
        impatient.messaging.downloadAttachment({ roomName: 'stalled', attachmentId: attachment!.id, savePath: directory }),
      );
      expect(download).toBeInstanceOf(CloudTransportError);
      expect(download.message).toBe(`Cloud API request GET /rooms/stalled/attachments/${attachment!.id} failed: no data for 500ms`);
      // A download is resent (twice) before it fails; nothing is left in the directory.
      expect(proxy.countRequests('GET', '/rooms/stalled/attachments/')).toBe(3);
      expect(await fs.readdir(directory)).toEqual([]);

      proxy.reset();
      proxy.holdRequests((request) => request.method === 'POST' && request.path.startsWith('/rooms/stalled/attachments'));
      const upload = await appError(
        impatient.messaging.sendMessage({ agentName: 'alice', roomName: 'stalled', message: 'y', attachments: [file] }),
      );
      expect(upload).toBeInstanceOf(CloudTransportError);
      expect(upload.message).toBe('Cloud API request POST /rooms/stalled/attachments failed: no data for 500ms');
      // An upload is never resent, and the message is not sent.
      expect(proxy.countRequests('POST', '/rooms/stalled/attachments')).toBe(1);
      expect(proxy.countRequests('POST', '/rooms/stalled/messages')).toBe(0);
    } finally {
      proxy.reset();
      await impatient.close();
    }
  });
});

describe('attachment failures reported by agora (FAULT_INJECTION=1)', () => {
  // The agora with FAULT_INJECTION=1 started by the globalSetup: test vars shrink its limits, fault headers break R2.
  const faultAgoraUrl = inject('faultAgoraUrl');
  let faultToken: string;
  let proxy: AgoraProxy;
  let client: McpTestClient;
  let api: CloudApiClient;
  let workDir: string;
  const env = () => ({ AGENT_COMM_API_URL: proxy.url, AGENT_COMM_TOKEN: faultToken });
  const backend = () => getCloudBackend(env())!;

  async function localFile(name: string, content: Buffer | string): Promise<string> {
    const file = path.join(workDir, name);
    await fs.writeFile(file, content);
    return file;
  }

  beforeAll(async () => {
    faultToken = await issueToken(faultAgoraUrl, 'attachment faults');
    proxy = await AgoraProxy.start(faultAgoraUrl);
    api = new CloudApiClient({ apiUrl: faultAgoraUrl, token: faultToken });
    client = await withEnv(env(), () => createMcpClient());
  });

  afterAll(async () => {
    await client?.close();
    await proxy?.close();
  });

  beforeEach(async () => {
    proxy.reset();
    await deleteAllRooms(faultAgoraUrl, faultToken);
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-comm-attachment-faults-'));
  });

  afterEach(async () => {
    proxy.reset();
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('ATTACHMENT_CAPACITY_EXCEEDED keeps its code, and the message is not sent', async () => {
    await setupRoom(client, 'capacity', ['alice']);
    const first = await localFile('first.txt', 'first');
    const second = await localFile('second.txt', 'second');
    proxy.extraHeaders = { 'x-agora-test-vars': JSON.stringify({ MAX_ATTACHMENTS_PER_ROOM: '1' }) };

    const toolCall = await toolError(
      client.call('send_message', { agentName: 'alice', roomName: 'capacity', message: 'x', attachments: [first, second] }),
    );
    const error = await appError(
      backend().messaging.sendMessage({ agentName: 'alice', roomName: 'capacity', message: 'x', attachments: [first] }),
    );
    // A plain AppError with the code, the status and the message of the API (which names the limit).
    expect(error.constructor).toBe(AppError);
    expect(error).toMatchObject({ code: 'ATTACHMENT_CAPACITY_EXCEEDED', statusCode: 429 });
    expect(error.message).toMatch(/\b1\b/);
    expect(toolCall).toEqual({ code: ErrorCode.InvalidParams, message: error.message });

    expect(proxy.countRequests('POST', '/rooms/capacity/attachments')).toBe(3);
    expect(proxy.countRequests('POST', '/rooms/capacity/messages')).toBe(0);
    expect((await api.getMessages('capacity', { limit: 10 })).messages).toEqual([]);
    // The first upload stays unattached (agora deletes it after an hour).
    expect((await roomStatus(api, 'capacity')).attachmentCount).toBe(1);
  });

  it('PAYLOAD_TOO_LARGE from agora names the file', async () => {
    await setupRoom(client, 'too-large', ['alice']);
    const file = await localFile('large.bin', randomBytes(2000));
    proxy.extraHeaders = { 'x-agora-test-vars': JSON.stringify({ MAX_ATTACHMENT_BYTES: '1000' }) };

    expect(
      await toolError(client.call('send_message', { agentName: 'alice', roomName: 'too-large', message: 'x', attachments: [file] })),
    ).toEqual({ code: ErrorCode.InvalidParams, message: `Attachment '${file}' exceeds maximum size of 1000 bytes` });
    const error = await appError(
      backend().messaging.sendMessage({ agentName: 'alice', roomName: 'too-large', message: 'x', attachments: [file] }),
    );
    expect(error).toBeInstanceOf(AttachmentTooLargeError);
    expect(error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', statusCode: 413 });
    expect(proxy.countRequests('POST', '/rooms/too-large/messages')).toBe(0);
  });

  it('a failed upload after a successful one sends nothing and is not resent', async () => {
    await setupRoom(client, 'r2-put', ['alice']);
    const first = await localFile('first.txt', 'first');
    const second = await localFile('second.txt', 'second');
    let uploads = 0;
    proxy.headersFor = (request) =>
      request.method === 'POST' && request.path.startsWith('/rooms/r2-put/attachments') && ++uploads === 2
        ? { 'x-agora-fault': 'r2.put' }
        : undefined;

    const error = await appError(
      backend().messaging.sendMessage({ agentName: 'alice', roomName: 'r2-put', message: 'x', attachments: [first, second] }),
    );
    expect(error).toBeInstanceOf(StorageError);
    expect(error.message).toBe("Storage operation 'upload attachment' failed: Storage error");
    expect(proxy.countRequests('POST', '/rooms/r2-put/attachments')).toBe(2);
    expect(proxy.countRequests('POST', '/rooms/r2-put/messages')).toBe(0);
    expect((await api.getMessages('r2-put', { limit: 10 })).messages).toEqual([]);
  });

  it('a download is resent after a transient failure, and a failing one leaves no file behind', async () => {
    await setupRoom(client, 'r2-get', ['alice']);
    const content = randomBytes(300 * 1024);
    const file = await localFile('payload.bin', content);
    await client.call('send_message', { agentName: 'alice', roomName: 'r2-get', message: 'x', attachments: [file] });
    const { messages } = await client.call<{ messages: ToolMessage[] }>('get_messages', { roomName: 'r2-get' });
    const attachmentId = messages[0]!.attachments![0]!.id;
    const directory = path.join(workDir, 'downloads');
    await fs.mkdir(directory);

    let downloads = 0;
    proxy.headersFor = (request) =>
      request.method === 'GET' && request.path.startsWith('/rooms/r2-get/attachments/') && ++downloads === 1
        ? { 'x-agora-fault': 'worker.unavailable' }
        : undefined;
    const saved = await client.call<DownloadResult>('download_attachment', { roomName: 'r2-get', attachmentId, savePath: directory });
    expect(saved).toEqual({ path: path.join(directory, 'payload.bin'), name: 'payload.bin', size: content.length, contentType: 'application/octet-stream' });
    expect((await fs.readFile(saved.path)).equals(content)).toBe(true);
    expect(downloads).toBe(2);

    proxy.reset();
    proxy.extraHeaders = { 'x-agora-fault': 'r2.get' };
    const target = path.join(directory, 'never.bin');
    const error = await appError(backend().messaging.downloadAttachment({ roomName: 'r2-get', attachmentId, savePath: target }));
    expect(error).toBeInstanceOf(StorageError);
    expect(proxy.countRequests('GET', '/rooms/r2-get/attachments/')).toBe(3);
    expect(await fs.readdir(directory)).toEqual(['payload.bin']);
  });
});
