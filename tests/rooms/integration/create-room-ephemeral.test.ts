// Cloud-only advertisement of create_room `ephemeral` (agora docs/api.yaml 0.11.0, D22), following the attachments
// precedent: file mode's tools/list omits the input, while the shared runtime validation still rejects `true` and
// accepts false/omitted. This suite runs in the file project only (tests/rooms/** is not part of cloud-compat).

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../../src/server/ToolRegistry.js';
import { MemoryTransport } from '../../helpers/MemoryTransport.js';

describe('create_room ephemeral in file mode', () => {
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
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-comm-create-ephemeral-'));
    process.env.AGENT_COMM_DATA_DIR = dataDir;
    const server = new Server({ name: 'agent-communication', version: '1.0.0' }, { capabilities: { tools: {} } });
    transport = new MemoryTransport();
    registry = new ToolRegistry(dataDir);
    await server.connect(transport);
    await registry.registerAll(server);
    expect(registry.mode).toBe('file');
  });

  afterEach(async () => {
    await transport.close();
    await registry.shutdown();
    delete process.env.AGENT_COMM_DATA_DIR;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('advertises create_room without the cloud-only ephemeral input', async () => {
    const response = await request('tools/list', {});
    const tools = response.result.tools as Array<{ name: string; description: string; inputSchema: any }>;
    const create = tools.find((tool) => tool.name === 'agent_communication_create_room')!;

    expect(create.description).toBe('Create a new room');
    expect(Object.keys(create.inputSchema.properties)).toEqual(['roomName', 'description']);
    expect(create.inputSchema.required).toEqual(['roomName']);
    expect(create.inputSchema.additionalProperties).toBe(false);
    expect(create.inputSchema.properties.roomName).toEqual({ type: 'string', description: 'Name of the room to create' });
    expect(create.inputSchema.properties.description).toEqual({
      type: 'string',
      description: 'Optional description for the room',
    });
  });

  it('rejects ephemeral: true at runtime and leaves false/omitted creating a normal room', async () => {
    const rejected = await call('create_room', { roomName: 'scratch', ephemeral: true });
    expect(rejected.error.code).toBe(ErrorCode.InvalidParams);
    expect(rejected.error.message).toContain(
      "Validation failed for field 'ephemeral': ephemeral rooms are only available in cloud mode",
    );

    expect(await call('create_room', { roomName: 'with-false', ephemeral: false })).toEqual({ success: true, roomName: 'with-false' });
    expect(await call('create_room', { roomName: 'without' })).toEqual({ success: true, roomName: 'without' });

    const list = await call('list_rooms', {});
    expect(list.rooms.map((room: { name: string }) => room.name)).toEqual(['with-false', 'without']);
    // File mode does not gain the cloud-only field in list_rooms.
    for (const room of list.rooms) expect(room).not.toHaveProperty('ephemeral');
  });
});
