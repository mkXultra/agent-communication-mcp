// The MCP server as MCP clients run it (stdio, JSON-RPC), in cloud mode against the real agora.
// Two server processes share one room: a wait in one process is released by a message sent from the other.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { CloudApiClient } from '../../src/cloud/index.js';
import { waitUntil } from './harness/mcp.js';

const REPO_ROOT = path.resolve(__dirname, '../..');
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const agoraUrl = process.env.AGENT_COMM_API_URL!;
const token = process.env.AGENT_COMM_TOKEN!;

class StdioServer {
  stderr = '';
  private stdout = '';
  private nextId = 1;
  private readonly pending = new Map<number, (message: any) => void>();
  private readonly exited: Promise<number | null>;

  constructor(readonly process: ChildProcess) {
    process.stdout!.setEncoding('utf8');
    process.stdout!.on('data', (chunk: string) => {
      this.stdout += chunk;
      let newline: number;
      while ((newline = this.stdout.indexOf('\n')) >= 0) {
        const line = this.stdout.slice(0, newline).trim();
        this.stdout = this.stdout.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      }
    });
    process.stderr!.setEncoding('utf8');
    process.stderr!.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
    this.exited = new Promise((resolve) => process.once('exit', (code) => resolve(code)));
  }

  static async start(env: Record<string, string | undefined>): Promise<StdioServer> {
    const child = spawn(TSX, ['src/index.ts'], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    const server = new StdioServer(child);
    await waitUntil(() => server.stderr.includes('Agent Communication MCP Server started on stdio'), 20000, 'server start');
    await server.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'cloud-stdio-test', version: '1.0.0' },
    });
    server.notify('notifications/initialized');
    return server;
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 20000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.process.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    this.process.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  async tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const response = await this.request('tools/call', { name: `agent_communication_${name}`, arguments: args });
    if (response.error) throw new Error(`${name}: ${response.error.message}`);
    return JSON.parse(response.result.content[0].text);
  }

  /** Closes stdin like an MCP client that goes away and resolves with the exit code. */
  async closeStdin(): Promise<number | null> {
    this.process.stdin!.end();
    return this.waitForExit();
  }

  waitForExit(timeoutMs = 10000): Promise<number | null> {
    return Promise.race([
      this.exited,
      new Promise<number | null>((_, reject) => setTimeout(() => reject(new Error('server did not exit')), timeoutMs)),
    ]);
  }
}

describe('stdio MCP server in cloud mode', () => {
  const started: StdioServer[] = [];
  const api = new CloudApiClient({ apiUrl: agoraUrl, token });
  const cloudEnv = { AGENT_COMM_API_URL: agoraUrl, AGENT_COMM_TOKEN: token, AGENT_COMM_DATA_DIR: undefined };

  async function start(env: Record<string, string | undefined> = cloudEnv): Promise<StdioServer> {
    const server = await StdioServer.start(env);
    started.push(server);
    return server;
  }

  afterEach(() => {
    for (const server of started.splice(0)) {
      if (server.process.exitCode === null) server.process.kill('SIGKILL');
    }
  });

  it('serves all tools over JSON-RPC and releases a wait with a message sent by another process', async () => {
    const alice = await start();
    const bob = await start();
    expect(alice.stderr).toContain(`Cloud mode: ${agoraUrl}`);

    const listed = await alice.request('tools/list');
    expect(listed.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(
      [
        'agent_communication_clear_room_messages',
        'agent_communication_create_room',
        'agent_communication_enter_room',
        'agent_communication_get_messages',
        'agent_communication_get_status',
        'agent_communication_leave_room',
        'agent_communication_list_room_users',
        'agent_communication_list_rooms',
        'agent_communication_send_message',
        'agent_communication_wait_for_messages',
      ].sort(),
    );

    expect(await alice.tool('create_room', { roomName: 'stdio-room', description: 'over stdio' })).toEqual({
      success: true,
      roomName: 'stdio-room',
    });
    expect(await alice.tool('enter_room', { agentName: 'alice', roomName: 'stdio-room' })).toEqual({ success: true });
    expect(await bob.tool('enter_room', { agentName: 'bob', roomName: 'stdio-room' })).toEqual({ success: true });

    const waiting = alice.tool('wait_for_messages', { agentName: 'alice', roomName: 'stdio-room', timeout: 15 });
    await waitUntil(
      async () => (await api.listMembers('stdio-room')).members.find((m) => m.agentName === 'alice')?.waiting === true,
      10000,
      'alice waiting in the other process',
    );
    const sent = await bob.tool('send_message', { agentName: 'bob', roomName: 'stdio-room', message: 'hello from another process @alice' });
    const released = await waiting;
    expect(released.hasNewMessages).toBe(true);
    expect(released.timedOut).toBe(false);
    expect(released.messages).toEqual([
      {
        id: sent.messageId,
        agentName: 'bob',
        roomName: 'stdio-room',
        message: 'hello from another process @alice',
        timestamp: sent.timestamp,
        mentions: ['alice'],
      },
    ]);

    expect((await alice.tool('get_messages', { agentName: 'alice', roomName: 'stdio-room' })).count).toBe(1);
    expect((await bob.tool('list_rooms')).rooms.map((room: { name: string }) => room.name)).toEqual(['stdio-room']);
    expect((await alice.tool('list_room_users', { roomName: 'stdio-room' })).users.map((u: { name: string }) => u.name)).toEqual([
      'alice',
      'bob',
    ]);
    const status = await bob.tool('get_status');
    expect(status).toMatchObject({ totalRooms: 1, totalMessages: 1, totalOnlineUsers: 2 });
    expect(await bob.tool('leave_room', { agentName: 'bob', roomName: 'stdio-room' })).toEqual({ success: true });
    expect(await alice.tool('clear_room_messages', { roomName: 'stdio-room', confirm: true })).toEqual({
      success: true,
      roomName: 'stdio-room',
      clearedCount: 1,
    });

    const invalid = await alice.request('tools/call', {
      name: 'agent_communication_enter_room',
      arguments: { agentName: 'alice', roomName: 'no-such-room' },
    });
    expect(invalid.error.message).toContain("Room 'no-such-room' not found");

    // Closing stdin ends the process even though a WebSocket is held, and the connection is released.
    expect((await api.listMembers('stdio-room')).members.find((m) => m.agentName === 'alice')!.connected).toBe(true);
    expect(await alice.closeStdin()).toBe(0);
    expect(await bob.closeStdin()).toBe(0);
    await waitUntil(
      async () => (await api.listMembers('stdio-room')).members.find((m) => m.agentName === 'alice')!.connected === false,
      10000,
      'alice disconnected',
    );
  }, 90000);

  it('shuts down on SIGTERM while holding a WebSocket', async () => {
    const server = await start();
    await server.tool('create_room', { roomName: 'sigterm-room' });
    await server.tool('enter_room', { agentName: 'alice', roomName: 'sigterm-room' });
    await server.tool('wait_for_messages', { agentName: 'alice', roomName: 'sigterm-room', timeout: 1 });
    expect((await api.listMembers('sigterm-room')).members[0]!.connected).toBe(true);

    server.process.kill('SIGTERM');
    expect(await server.waitForExit()).toBe(0);
    await waitUntil(async () => (await api.listMembers('sigterm-room')).members[0]!.connected === false, 10000, 'disconnected');
  }, 60000);

  it('refuses to start with an API URL that is not http(s)', async () => {
    const child = spawn(TSX, ['src/index.ts'], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AGENT_COMM_API_URL: 'ftp://agora.example', AGENT_COMM_TOKEN: 'x' },
    });
    const server = new StdioServer(child);
    expect(await server.waitForExit(20000)).toBe(1);
    expect(server.stderr).toContain('AGENT_COMM_API_URL must use http or https');
  }, 30000);
});
