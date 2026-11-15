// delete_attachments_through_post in cloud mode against the real agora: the optional non-mutating preview of an
// inclusive post boundary, the explicitly confirmed execution without a prior preview or generation value (including
// every attachment of the boundary post and files younger than 24 hours), resolution of the currently named room (also
// after recreation), preservation of messages and later attachments, range replay, and a 202 pending physical cleanup
// that a same-range replay finishes. File mode is covered by the attachments-file-mode test.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { CloudApiClient } from '../../src/cloud/index.js';
import type { ApiAttachmentPurgePreview, ApiAttachmentPurgeResult } from '../../src/cloud/types.js';
import { ToolRegistry } from '../../src/server/ToolRegistry.js';
import { MemoryTransport } from '../helpers/MemoryTransport.js';
import { deleteAllRooms, issueToken } from './harness/agora.js';
import { createMcpClient, McpCallError, withEnv, type McpTestClient } from './harness/mcp.js';
import { AgoraProxy } from './harness/proxy.js';

const agoraUrl = process.env.AGENT_COMM_API_URL!;
const token = process.env.AGENT_COMM_TOKEN!;
const TOOL = 'agent_communication_delete_attachments_through_post';

interface ToolMessage {
  id: string;
  seq: number;
  agentName: string;
  roomName: string;
  message: string;
  timestamp: string;
  mentions: string[];
  attachments?: Array<{ id: string; name: string; size: number; contentType: string }>;
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

/** tools/list of a server built the way src/index.ts builds it, in the current (cloud) environment. */
async function listedTools(): Promise<Array<{ name: string; description: string; inputSchema: any }>> {
  const server = new Server({ name: 'agent-communication', version: '1.0.0' }, { capabilities: { tools: {} } });
  const transport = new MemoryTransport();
  const registry = new ToolRegistry();
  await server.connect(transport);
  await registry.registerAll(server);
  try {
    expect(registry.mode).toBe('cloud');
    const response = await transport.simulateRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    return (response.result as { tools: Array<{ name: string; description: string; inputSchema: any }> }).tools;
  } finally {
    await transport.close();
    await registry.shutdown();
  }
}

describe('delete_attachments_through_post in cloud mode', () => {
  let client: McpTestClient;
  let workDir: string;
  const api = new CloudApiClient({ apiUrl: agoraUrl, token });

  async function localFile(name: string, content: string): Promise<string> {
    const file = path.join(workDir, name);
    await fs.writeFile(file, content);
    return file;
  }

  async function setupRoom(roomName: string): Promise<void> {
    await client.call('create_room', { roomName });
    await client.call('enter_room', { agentName: 'alice', roomName });
  }

  async function messagesOf(roomName: string): Promise<ToolMessage[]> {
    return (await client.call<{ messages: ToolMessage[] }>('get_messages', { roomName, limit: 100 })).messages;
  }

  async function sendWithFiles(roomName: string, message: string, files: Array<[string, string]>): Promise<void> {
    const paths: string[] = [];
    for (const [name, content] of files) paths.push(await localFile(name, content));
    await client.call('send_message', { roomName, message, attachments: paths });
  }

  function previewRange(roomName: string, throughSeq: number): Promise<ApiAttachmentPurgePreview> {
    return client.call<ApiAttachmentPurgePreview>('delete_attachments_through_post', { roomName, throughSeq });
  }

  function executeRange(roomName: string, throughSeq: number): Promise<ApiAttachmentPurgeResult> {
    return client.call<ApiAttachmentPurgeResult>('delete_attachments_through_post', {
      roomName,
      throughSeq,
      confirm: true,
    });
  }

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-comm-attachment-purge-'));
    client = await createMcpClient();
  });

  afterEach(async () => {
    await client.close();
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('advertises one cloud-mode tool for preview and confirmed execution', async () => {
    const tools = await listedTools();
    const tool = tools.find((candidate) => candidate.name === TOOL);
    expect(tool).toBeDefined();
    expect(tool!.description).toMatch(/Preview or execute/);
    expect(tool!.description).toMatch(/irreversible/);
    expect(tool!.description).toMatch(/inclusive|including/);
    expect(tool!.inputSchema.required).toEqual(['roomName', 'throughSeq']);
    expect(tool!.inputSchema.additionalProperties).toBe(false);
    // Exactly the three public inputs: no epoch, token or other generation prerequisite.
    expect(Object.keys(tool!.inputSchema.properties)).toEqual(['roomName', 'throughSeq', 'confirm']);
    expect(tool!.inputSchema.properties).not.toHaveProperty('epoch');
    expect(tool!.inputSchema.properties.throughSeq).toMatchObject({ type: 'integer', minimum: 1 });
    expect(tool!.inputSchema.properties.confirm).toMatchObject({ type: 'boolean', default: false });
  });

  it('previews without mutating, then deletes the inclusive range and keeps bodies, IDs, order and later attachments', async () => {
    await setupRoom('purge-range');
    await sendWithFiles('purge-range', 'first', [
      ['a.txt', 'aaa'],
      ['b.txt', 'bbbb'],
    ]);
    await client.call('send_message', { roomName: 'purge-range', message: 'second (boundary without files)' });
    await sendWithFiles('purge-range', 'third (after the boundary)', [
      ['c.txt', 'ccccc'],
      ['d.txt', 'dddddd'],
    ]);

    const before = await messagesOf('purge-range');
    expect(before.map((message) => message.message)).toEqual([
      'third (after the boundary)',
      'second (boundary without files)',
      'first',
    ]);
    // cloud get_messages exposes the additive room position that the boundary uses.
    expect(before.map((message) => message.seq)).toEqual([3, 2, 1]);
    const boundary = before.find((message) => message.message.startsWith('second'))!;

    const preview = await previewRange('purge-range', boundary.seq);
    expect(preview).toMatchObject({
      dryRun: true,
      roomName: 'purge-range',
      throughSeq: boundary.seq,
      latestSeq: 3,
      boundaryMessageExists: true,
      boundaryMessageId: boundary.id,
      attachmentCount: 2,
      attachmentBytes: 7,
      messagesThroughBoundary: 2,
      unpostedAttachmentCount: 0,
      retainedDisplayMetadataCount: 0,
      afterBoundaryAttachmentCount: 2,
      afterBoundaryAttachmentBytes: 11,
    });
    expect(preview).not.toHaveProperty('epoch');
    expect(preview.firstAttachmentSeq).toBe(1);
    expect(preview.lastAttachmentSeq).toBe(1);

    // An explicit confirm:false preview is the same non-mutating call as the default.
    const explicitPreview = await client.call<ApiAttachmentPurgePreview>('delete_attachments_through_post', {
      roomName: 'purge-range',
      throughSeq: boundary.seq,
      confirm: false,
    });
    expect(explicitPreview).toMatchObject({ dryRun: true, roomName: 'purge-range', throughSeq: boundary.seq });
    expect(explicitPreview).not.toHaveProperty('epoch');

    // The preview changed nothing.
    expect((await messagesOf('purge-range')).map((message) => message.id)).toEqual(before.map((message) => message.id));

    const result = await executeRange('purge-range', preview.throughSeq);
    expect(result).toMatchObject({
      success: true,
      roomName: 'purge-range',
      throughSeq: boundary.seq,
      deletionStatus: 'complete',
      deletedAttachmentCount: 2,
      deletedAttachmentBytes: 7,
      pendingAttachments: 0,
    });
    expect(result).not.toHaveProperty('epoch');
    expect(result.retryAfterMs).toBeUndefined();

    const after = await messagesOf('purge-range');
    expect(after.map((message) => message.id)).toEqual(before.map((message) => message.id));
    expect(after.map((message) => message.message)).toEqual(before.map((message) => message.message));
    expect(after[2]!.attachments).toBeUndefined();
    expect(after[0]!.attachments).toHaveLength(2);
    expect(after[1]!.attachments).toBeUndefined();

    // Replaying the same range deletes nothing new and stays complete.
    const replay = await executeRange('purge-range', preview.throughSeq);
    expect(replay).toMatchObject({
      deletionStatus: 'complete',
      deletedAttachmentCount: 0,
      deletedAttachmentBytes: 0,
      pendingAttachments: 0,
    });

    // A later post is outside the fixed range, also on a replay.
    await sendWithFiles('purge-range', 'fourth', [['e.txt', 'eeeeeee']]);
    const newer = (await messagesOf('purge-range'))[0]!;
    expect(newer.message).toBe('fourth');
    const replayAgain = await executeRange('purge-range', preview.throughSeq);
    expect(replayAgain.deletedAttachmentCount).toBe(0);
    const kept = (await messagesOf('purge-range'))[0]!;
    expect(kept.id).toBe(newer.id);
    expect(kept.attachments).toHaveLength(1);
  });

  it('executes directly with confirm:true without a preview or generation value', async () => {
    await setupRoom('purge-direct');
    await sendWithFiles('purge-direct', 'only', [['only.txt', 'direct']]);
    const boundary = (await messagesOf('purge-direct'))[0]!;

    const result = await executeRange('purge-direct', boundary.seq);
    expect(result).toMatchObject({
      success: true,
      roomName: 'purge-direct',
      throughSeq: boundary.seq,
      deletionStatus: 'complete',
      deletedAttachmentCount: 1,
      deletedAttachmentBytes: 'direct'.length,
      pendingAttachments: 0,
    });
    expect(result).not.toHaveProperty('epoch');
    const after = (await messagesOf('purge-direct'))[0]!;
    expect(after.id).toBe(boundary.id);
    expect(after.attachments).toBeUndefined();
  });

  it('includes every attachment of the boundary post and files younger than 24 hours', async () => {
    await setupRoom('purge-boundary');
    await sendWithFiles('purge-boundary', 'one', [['one.txt', '1']]);
    await sendWithFiles('purge-boundary', 'boundary', [
      ['two.txt', '22'],
      ['three.txt', '333'],
    ]);
    await client.call('send_message', { roomName: 'purge-boundary', message: 'after' });

    const before = await messagesOf('purge-boundary');
    const boundary = before.find((message) => message.message === 'boundary')!;
    const fixed = await previewRange('purge-boundary', boundary.seq);
    expect(fixed).toMatchObject({ attachmentCount: 3, attachmentBytes: 6, lastAttachmentSeq: boundary.seq });

    const result = await executeRange('purge-boundary', fixed.throughSeq);
    expect(result).toMatchObject({ deletionStatus: 'complete', deletedAttachmentCount: 3, deletedAttachmentBytes: 6 });
    const after = await messagesOf('purge-boundary');
    expect(after.find((message) => message.message === 'boundary')!.attachments).toBeUndefined();
    expect(after.find((message) => message.message === 'one')!.attachments).toBeUndefined();
    expect(after.find((message) => message.message === 'after')!.message).toBe('after');
  });

  it('rejects invalid and future boundaries and resolves the currently named room after recreation', async () => {
    await setupRoom('purge-errors');
    await sendWithFiles('purge-errors', 'only', [['only.txt', 'x']]);
    const latest = (await messagesOf('purge-errors'))[0]!;

    expect(await toolError(previewRange('purge-errors', latest.seq + 1))).toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringMatching(/beyond the latest post/),
    });
    expect(await toolError(executeRange('purge-errors', latest.seq + 1))).toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringMatching(/beyond the latest post/),
    });
    for (const throughSeq of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await toolError(previewRange('purge-errors', throughSeq))).toMatchObject({
        code: ErrorCode.InvalidParams,
        message: expect.stringMatching(/Through post position|throughSeq/),
      });
      expect(await toolError(executeRange('purge-errors', throughSeq))).toMatchObject({
        code: ErrorCode.InvalidParams,
        message: expect.stringMatching(/Through post position|throughSeq/),
      });
    }
    expect(await toolError(previewRange('no-such-room', 1))).toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringMatching(/Room 'no-such-room' not found/),
    });

    // A confirmed execution needs no epoch or prior preview; after delete + same-name recreation it targets the room
    // that currently has the name, using that room's own throughSeq. The internal room generation still changes, but it
    // is not a public purge input or a cross-request fence.
    const originalEpoch = (await api.listRooms()).find((room) => room.name === 'purge-errors')!.epoch;
    await api.deleteRoom('purge-errors');
    const recreated = await api.createRoom('purge-errors');
    expect(recreated.epoch).not.toBe(originalEpoch);
    await client.call('enter_room', { agentName: 'alice', roomName: 'purge-errors' });
    await sendWithFiles('purge-errors', 'new generation one', [['new1.txt', 'new one']]);
    await sendWithFiles('purge-errors', 'new generation two', [['new2.txt', 'new two']]);

    const recreatedMessages = await messagesOf('purge-errors');
    expect(recreatedMessages.map((message) => message.seq)).toEqual([2, 1]);
    const result = await executeRange('purge-errors', 2);
    expect(result).toMatchObject({
      success: true,
      roomName: 'purge-errors',
      throughSeq: 2,
      deletionStatus: 'complete',
      deletedAttachmentCount: 2,
      deletedAttachmentBytes: 'new one'.length + 'new two'.length,
      pendingAttachments: 0,
    });
    expect(result).not.toHaveProperty('epoch');
    const stillThere = await messagesOf('purge-errors');
    expect(stillThere.map((message) => message.message)).toEqual(['new generation two', 'new generation one']);
    expect(stillThere.every((message) => message.attachments === undefined)).toBe(true);
  });

  // The agora with FAULT_INJECTION=1 started by globalSetup: an r2.delete fault leaves the physical cleanup pending.
  const faultAgoraUrl = inject('faultAgoraUrl');
  describe('pending physical cleanup', () => {
    let faultToken: string;
    let proxy: AgoraProxy;
    let faultClient: McpTestClient;
    const faultApi = () => new CloudApiClient({ apiUrl: faultAgoraUrl, token: faultToken });

    beforeAll(async () => {
      faultToken = await issueToken(faultAgoraUrl, `attachment purge faults ${Date.now()}`);
      proxy = await AgoraProxy.start(faultAgoraUrl);
    });

    afterAll(async () => {
      await proxy.close();
    });

    beforeEach(async () => {
      proxy.reset();
      await deleteAllRooms(faultAgoraUrl, faultToken);
      faultClient = await withEnv({ AGENT_COMM_API_URL: proxy.url, AGENT_COMM_TOKEN: faultToken }, () => createMcpClient());
    });

    afterEach(async () => {
      await faultClient.close();
      proxy.reset();
    });

    it('returns a pending result from the MCP tool and completes it on a same-scope replay', async () => {
      await faultClient.call('create_room', { roomName: 'purge-pending' });
      await faultClient.call('enter_room', { agentName: 'alice', roomName: 'purge-pending' });
      const file = await localFile('pending.txt', 'pending payload');
      await faultClient.call('send_message', { roomName: 'purge-pending', message: 'boundary', attachments: [file] });
      const message = (await faultClient.call<{ messages: ToolMessage[] }>('get_messages', { roomName: 'purge-pending' }))
        .messages[0]!;

      const fixed = await faultClient.call<ApiAttachmentPurgePreview>('delete_attachments_through_post', {
        roomName: 'purge-pending',
        throughSeq: message.seq,
      });
      proxy.extraHeaders = { 'x-agora-fault': 'r2.delete' };
      const pending = await faultClient.call<ApiAttachmentPurgeResult>('delete_attachments_through_post', {
        roomName: 'purge-pending',
        throughSeq: fixed.throughSeq,
        confirm: true,
      });
      expect(pending).toMatchObject({
        deletionStatus: 'pending',
        deletedAttachmentCount: 1,
        deletedAttachmentBytes: 'pending payload'.length,
        pendingAttachments: 1,
        retryAfterMs: 60000,
      });

      // Metadata is already gone, but that is not proof of physical deletion.
      const after = (await faultClient.call<{ messages: ToolMessage[] }>('get_messages', { roomName: 'purge-pending' }))
        .messages[0]!;
      expect(after.attachments).toBeUndefined();

      // A replay while cleanup still fails deletes no new rows but must stay pending (never a false complete).
      // This is also the shape of a conservative legacy-ledger retry whose post position cannot be proven.
      const stillPending = await faultClient.call<ApiAttachmentPurgeResult>('delete_attachments_through_post', {
        roomName: 'purge-pending',
        throughSeq: fixed.throughSeq,
        confirm: true,
      });
      expect(stillPending).toMatchObject({
        deletionStatus: 'pending',
        deletedAttachmentCount: 0,
        deletedAttachmentBytes: 0,
        pendingAttachments: 1,
        retryAfterMs: 60000,
      });

      proxy.reset();
      const replay = await faultClient.call<ApiAttachmentPurgeResult>('delete_attachments_through_post', {
        roomName: 'purge-pending',
        throughSeq: fixed.throughSeq,
        confirm: true,
      });
      expect(replay).toMatchObject({
        deletionStatus: 'complete',
        deletedAttachmentCount: 0,
        deletedAttachmentBytes: 0,
        pendingAttachments: 0,
      });
      expect(replay.retryAfterMs).toBeUndefined();
      expect((await faultApi().getStatus()).rooms.find((room) => room.roomName === 'purge-pending')?.attachmentCount).toBe(0);
    });
  });
});
