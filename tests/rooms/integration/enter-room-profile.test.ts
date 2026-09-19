// `profile` on enter_room in file mode (0.7.0): the tool declares it, the handler forwards it to the presence
// storage, and list_room_users returns it. The update semantics follow agora's join
// (`profile = COALESCE(excluded.profile, members.profile)`, docs/api.yaml): a new profile replaces the old one and
// an omitted profile keeps it, so both modes behave the same.

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../../src/server/ToolRegistry.js';
import { MemoryTransport } from '../../helpers/MemoryTransport.js';

const REVIEWER = { role: 'reviewer', description: 'claude-opus / mac-mini, reviews PRs' };

describe('enter_room profile in file mode', () => {
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

  /** The single user of the room, as list_room_users returns it. */
  async function user(agentName: string): Promise<any> {
    const result = await call('list_room_users', { roomName: 'profiles' });
    return result.users.find((u: { name: string }) => u.name === agentName);
  }

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-comm-enter-profile-'));
    process.env.AGENT_COMM_DATA_DIR = dataDir;
    const server = new Server({ name: 'agent-communication', version: '1.0.0' }, { capabilities: { tools: {} } });
    transport = new MemoryTransport();
    registry = new ToolRegistry(dataDir);
    await server.connect(transport);
    await registry.registerAll(server);
    expect(registry.mode).toBe('file');

    await call('create_room', { roomName: 'profiles' });
  });

  afterEach(async () => {
    await transport.close();
    await registry.shutdown();
    delete process.env.AGENT_COMM_DATA_DIR;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('declares profile on enter_room with the limits of agora AgentProfile', async () => {
    const response = await request('tools/list', {});
    const tools = response.result.tools as Array<{ name: string; description: string; inputSchema: any }>;

    const enter = tools.find((tool) => tool.name === 'agent_communication_enter_room')!;
    expect(Object.keys(enter.inputSchema.properties)).toEqual(['agentName', 'roomName', 'profile']);
    expect(enter.inputSchema.required).toEqual(['agentName', 'roomName']);
    expect(enter.inputSchema.additionalProperties).toBe(false);
    expect(enter.inputSchema.properties.profile).toEqual({
      type: 'object',
      description:
        'Optional self-introduction shown to other agents and in the Web UI: role (short role name) and ' +
        'description (e.g. model name, host, duties). Re-entering with the same agentName updates it; ' +
        're-entering without profile keeps the previous one.',
      properties: {
        role: { type: 'string', description: 'Short role name, e.g. "reviewer"', maxLength: 100 },
        description: {
          type: 'string',
          description: 'Free text, e.g. "claude-opus / mac-mini, reviews PRs"',
          maxLength: 500,
        },
        capabilities: {
          type: 'array',
          description: 'What the agent can do, one short label per entry',
          items: { type: 'string', maxLength: 100 },
          maxItems: 50,
        },
        metadata: { type: 'object', description: 'Any other JSON object' },
      },
      additionalProperties: false,
    });

    const list = tools.find((tool) => tool.name === 'agent_communication_list_room_users')!;
    expect(list.description).toBe(
      'List users in a room. Each user may carry the profile given to enter_room (role, description, capabilities).',
    );
  });

  it('stores the profile and returns it from list_room_users', async () => {
    const profile = { ...REVIEWER, capabilities: ['review', 'typescript'], metadata: { host: 'mac-mini' } };
    expect(await call('enter_room', { agentName: 'alice', roomName: 'profiles', profile })).toEqual({ success: true });

    expect(await user('alice')).toEqual({ name: 'alice', status: 'online', messageCount: 0, profile });
    // The profile reaches presence.json, not only the response.
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'rooms', 'profiles', 'presence.json'), 'utf-8'));
    expect(stored.users.alice.profile).toEqual(profile);
  });

  it('leaves out profile for an agent that entered without one', async () => {
    await call('enter_room', { agentName: 'bob', roomName: 'profiles' });
    expect(await user('bob')).toEqual({ name: 'bob', status: 'online', messageCount: 0 });
  });

  it('replaces the profile when re-entering with a new one', async () => {
    await call('enter_room', { agentName: 'alice', roomName: 'profiles', profile: REVIEWER });
    await call('enter_room', {
      agentName: 'alice',
      roomName: 'profiles',
      profile: { role: 'builder', capabilities: ['build'] },
    });

    expect((await user('alice')).profile).toEqual({ role: 'builder', capabilities: ['build'] });
  });

  it('keeps the previous profile when re-entering without one, online or after leaving', async () => {
    await call('enter_room', { agentName: 'alice', roomName: 'profiles', profile: REVIEWER });

    // Re-entering while online.
    await call('enter_room', { agentName: 'alice', roomName: 'profiles' });
    expect((await user('alice')).profile).toEqual(REVIEWER);

    // Re-entering after leaving (the member row is kept as offline).
    await call('leave_room', { agentName: 'alice', roomName: 'profiles' });
    expect((await user('alice')).profile).toEqual(REVIEWER);
    await call('enter_room', { agentName: 'alice', roomName: 'profiles' });
    expect(await user('alice')).toEqual({ name: 'alice', status: 'online', messageCount: 0, profile: REVIEWER });
  });

  it('accepts a profile at the limits of agora AgentProfile', async () => {
    const profile = {
      role: 'r'.repeat(100),
      description: 'd'.repeat(500),
      capabilities: Array.from({ length: 50 }, () => 'c'.repeat(100)),
      metadata: { nested: { team: 'frontend' } },
    };
    expect(await call('enter_room', { agentName: 'alice', roomName: 'profiles', profile })).toEqual({ success: true });
    expect((await user('alice')).profile).toEqual(profile);
  });

  it('measures the limits in code points, as agora does', async () => {
    const emoji = String.fromCodePoint(0x1f600);
    // 60 emoji are 60 code points but 120 UTF-16 code units, and agora accepts them.
    const profile = { role: emoji.repeat(60), description: emoji.repeat(300), capabilities: [emoji.repeat(100)] };
    expect(await call('enter_room', { agentName: 'alice', roomName: 'profiles', profile })).toEqual({ success: true });
    expect((await user('alice')).profile).toEqual(profile);

    const result = await call('enter_room', { agentName: 'alice', roomName: 'profiles', profile: { role: emoji.repeat(101) } });
    expect(result.error.message).toContain('Profile role cannot exceed 100 characters');
  });

  it('rejects a profile over the limits, or with an unknown key, without entering the room', async () => {
    const rejected: Array<[unknown, string]> = [
      [{ role: 'r'.repeat(101) }, 'Profile role cannot exceed 100 characters'],
      [{ description: 'd'.repeat(501) }, 'Profile description cannot exceed 500 characters'],
      [{ capabilities: Array.from({ length: 51 }, () => 'c') }, 'Profile capabilities cannot exceed 50 items'],
      [{ capabilities: ['c'.repeat(101)] }, 'Each capability cannot exceed 100 characters'],
      // `additionalProperties: false` on the tool schema: the zod schema reports the unknown key as well.
      [{ role: 'reviewer', nickname: 'al' }, "Unrecognized key(s) in object: 'nickname'"],
    ];
    for (const [profile, message] of rejected) {
      const result = await call('enter_room', { agentName: 'alice', roomName: 'profiles', profile });
      expect(result.error?.code, message).toBe(-32602);
      expect(result.error.message).toContain('Validation error:');
      expect(result.error.message).toContain(message);
    }

    expect((await call('list_room_users', { roomName: 'profiles' })).users).toEqual([]);
  });
});
