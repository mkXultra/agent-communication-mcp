// File attachments are a cloud mode feature (docs/cloud-architecture.md §3.9). In file mode send_message refuses
// `attachments` (an empty list attaches nothing) and download_attachment is refused, both with VALIDATION_ERROR,
// and tools/list keeps the ten tools, without either (and without the server notices cloud mode describes).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { MessagingAdapter } from '../../../src/adapters/MessagingAdapter.js';
import { AppError } from '../../../src/errors/index.js';
import { ToolRegistry } from '../../../src/server/ToolRegistry.js';
import { LockService } from '../../../src/services/LockService.js';
import { MemoryTransport } from '../../helpers/MemoryTransport.js';

const CLOUD_ONLY = 'Attachments are only available in cloud mode (AGENT_COMM_TOKEN is not set)';

describe('attachments in file mode', () => {
  let dataDir: string;
  let transport: MemoryTransport;
  let registry: ToolRegistry;
  let nextId = 1;

  async function request(method: string, params: Record<string, unknown>): Promise<any> {
    return transport.simulateRequest({ jsonrpc: '2.0', id: nextId++, method, params });
  }

  async function call(name: string, args: Record<string, unknown>): Promise<any> {
    const response = await request('tools/call', { name: `agent_communication_${name}`, arguments: args });
    if (response.error) return { error: response.error };
    return JSON.parse(response.result.content[0].text);
  }

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-comm-file-attachments-'));
    process.env.AGENT_COMM_DATA_DIR = dataDir;
    const server = new Server({ name: 'agent-communication', version: '1.0.0' }, { capabilities: { tools: {} } });
    transport = new MemoryTransport();
    registry = new ToolRegistry(dataDir);
    await server.connect(transport);
    await registry.registerAll(server);
    expect(registry.mode).toBe('file');

    await call('create_room', { roomName: 'files' });
    await call('enter_room', { agentName: 'alice', roomName: 'files' });
  });

  afterEach(async () => {
    await transport.close();
    await registry.shutdown();
    delete process.env.AGENT_COMM_DATA_DIR;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('lists the ten tools without download_attachment or the attachments of send_message', async () => {
    const response = await request('tools/list', {});
    const tools = response.result.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
    expect(tools).toHaveLength(10);
    expect(tools.map((tool) => tool.name)).not.toContain('agent_communication_download_attachment');
    const send = tools.find((tool) => tool.name === 'agent_communication_send_message')!;
    expect(Object.keys(send.inputSchema.properties)).toEqual(['agentName', 'roomName', 'message']);
  });

  it('describes get_messages and wait_for_messages without the server notices of cloud mode', async () => {
    // File mode has no server notices, and wait_for_messages never returns the `system` messages its waits write.
    const response = await request('tools/list', {});
    const descriptions = Object.fromEntries(
      (response.result.tools as Array<{ name: string; description: string }>).map((tool) => [tool.name, tool.description])
    );
    expect(descriptions.agent_communication_get_messages).toBe('Get messages from a room');
    expect(descriptions.agent_communication_wait_for_messages).toBe(
      'Wait for new messages in a room using long-polling. This tool will block until new messages are available or the timeout is reached. Returns immediately if new messages are already available since the last check.'
    );
  });

  it('refuses send_message with attachments and sends nothing', async () => {
    const file = path.join(dataDir, 'report.txt');
    await fs.writeFile(file, 'report');

    const { error } = await call('send_message', { agentName: 'alice', roomName: 'files', message: 'see file', attachments: [file] });
    expect(error.code).toBe(ErrorCode.InvalidParams);
    expect(error.message).toBe(`MCP error ${ErrorCode.InvalidParams}: Validation failed for field 'attachments': ${CLOUD_ONLY}`);

    const adapter = new MessagingAdapter(new LockService(dataDir));
    const refused = await adapter.sendMessage({ agentName: 'alice', roomName: 'files', message: 'see file', attachments: [file] }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AppError);
    expect(refused).toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });

    expect((await call('get_messages', { roomName: 'files' })).messages).toEqual([]);
  });

  it('sends a message with an empty attachment list as a message without attachments', async () => {
    const sent = await call('send_message', { agentName: 'alice', roomName: 'files', message: 'no files', attachments: [] });
    expect(sent).toMatchObject({ success: true, roomName: 'files' });
    const { messages } = await call('get_messages', { roomName: 'files' });
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toHaveProperty('attachments');
    expect(messages[0].message).toBe('no files');
  });

  it('refuses download_attachment and writes nothing', async () => {
    const saveDir = path.join(dataDir, 'downloads');
    await fs.mkdir(saveDir);
    const args = { roomName: 'files', attachmentId: '7d444840-9dc0-11d1-b245-5ffdce74fad2', savePath: saveDir };

    const { error } = await call('download_attachment', args);
    expect(error.code).toBe(ErrorCode.InvalidParams);
    expect(error.message).toBe(`MCP error ${ErrorCode.InvalidParams}: Validation failed for field 'attachmentId': ${CLOUD_ONLY}`);

    const adapter = new MessagingAdapter(new LockService(dataDir));
    const refused = await adapter.downloadAttachment(args).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AppError);
    expect(refused).toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });

    expect(await fs.readdir(saveDir)).toEqual([]);
  });
});
