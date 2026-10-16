// Room identity in file mode: enter_room selects the acting agent name for this MCP server instance and room, and
// send_message / wait_for_messages act as it without taking agentName. Exercised through the real ToolRegistry over
// JSON-RPC (tools/list and tools/call), not through helper functions.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { ToolRegistry } from '../../../src/server/ToolRegistry.js';
import { MemoryTransport } from '../../helpers/MemoryTransport.js';

interface Client {
  registry: ToolRegistry;
  request(method: string, params: Record<string, unknown>): Promise<any>;
  call(name: string, args?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

async function createClient(dataDir?: string): Promise<Client> {
  const server = new Server({ name: 'agent-communication', version: '1.0.0' }, { capabilities: { tools: {} } });
  const transport = new MemoryTransport();
  const registry = new ToolRegistry(dataDir);
  await server.connect(transport);
  await registry.registerAll(server);
  let nextId = 1;
  const request = (method: string, params: Record<string, unknown>) =>
    transport.simulateRequest({ jsonrpc: '2.0', id: nextId++, method, params });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await request('tools/call', { name: `agent_communication_${name}`, arguments: args });
    if (response.error) return { error: response.error };
    return JSON.parse(response.result.content[0].text);
  };
  return {
    registry,
    request,
    call,
    async close() {
      await transport.close();
      await registry.shutdown();
    },
  };
}

function invalidParams(response: any): boolean {
  return response.error?.code === ErrorCode.InvalidParams;
}

function waitCancelled(response: any): boolean {
  return response.error?.message?.includes('Waiting for messages ended without a result');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The users of a room, keyed by name, as the public list_room_users tool reports them. */
async function usersByName(client: Client, roomName: string): Promise<Record<string, string>> {
  const { users } = await client.call('list_room_users', { roomName });
  return Object.fromEntries(users.map((user: { name: string; status: string }) => [user.name, user.status]));
}

describe('room identity in file mode', () => {
  let dataDir: string;
  let client: Client;
  const extras: Client[] = [];

  async function extraClient(): Promise<Client> {
    const extra = await createClient(dataDir);
    extras.push(extra);
    return extra;
  }

  /** Starts a wait without waiting for it; the caller asserts on the eventual result. */
  function startWait(roomName: string, args: Record<string, unknown> = {}): Promise<any> {
    return client.call('wait_for_messages', { roomName, timeout: 0, ...args });
  }

  /** Polls until the file-mode wait registered `agentName` in the room's waiting_agents.json. */
  async function waitUntilWaiting(roomName: string, agentName: string): Promise<void> {
    const file = path.join(dataDir, 'rooms', roomName, 'waiting_agents.json');
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        const waiting = JSON.parse(await fs.readFile(file, 'utf8')) as Array<{ agentName: string }>;
        if (waiting.some((entry) => entry.agentName === agentName)) return;
      } catch {
        // Not written yet.
      }
      if (Date.now() > deadline) throw new Error(`wait of '${agentName}' did not register in '${roomName}'`);
      await sleep(20);
    }
  }

  /** The read cursors of a room, as the file backend stores them (agentName -> last read). */
  async function readStatus(roomName: string): Promise<Record<string, { lastReadMessageId?: string }>> {
    try {
      return JSON.parse(await fs.readFile(path.join(dataDir, 'rooms', roomName, 'read_status.json'), 'utf8'));
    } catch {
      return {};
    }
  }

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-comm-identity-'));
    process.env.AGENT_COMM_DATA_DIR = dataDir;
    client = await createClient(dataDir);
    expect(client.registry.mode).toBe('file');
  });

  afterEach(async () => {
    await Promise.all(extras.splice(0).map((extra) => extra.close()));
    await client.close();
    delete process.env.AGENT_COMM_DATA_DIR;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('publishes send_message and wait_for_messages without agentName and keeps their other inputs', async () => {
    const response = await client.request('tools/list', {});
    const tools = response.result.tools as Array<{ name: string; inputSchema: any }>;
    const send = tools.find((tool) => tool.name === 'agent_communication_send_message')!;
    expect(Object.keys(send.inputSchema.properties)).toEqual(['roomName', 'message']);
    expect(send.inputSchema.required).toEqual(['roomName', 'message']);
    expect(send.inputSchema.additionalProperties).toBe(false);

    const wait = tools.find((tool) => tool.name === 'agent_communication_wait_for_messages')!;
    expect(Object.keys(wait.inputSchema.properties)).toEqual(['roomName', 'timeout', 'mentionsOnly']);
    expect(wait.inputSchema.required).toEqual(['roomName']);
    expect(wait.inputSchema.additionalProperties).toBe(false);
  });

  it('rejects an explicit agentName on send_message and wait_for_messages, even when it matches the selected name', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });

    for (const agentName of ['alice', 'bob']) {
      const send = await client.call('send_message', { agentName, roomName: 'room', message: 'hi' });
      expect(invalidParams(send)).toBe(true);
      expect(send.error.message).toMatch(/'agentName' is not an input of agent_communication_send_message/);

      const wait = await client.call('wait_for_messages', { agentName, roomName: 'room', timeout: 1 });
      expect(invalidParams(wait)).toBe(true);
      expect(wait.error.message).toMatch(/'agentName' is not an input of agent_communication_wait_for_messages/);
    }
    expect((await client.call('get_messages', { roomName: 'room' })).messages).toEqual([]);
  });

  it('sends as the entered name, preserving message, metadata and mentions', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });

    const sent = await client.call('send_message', {
      roomName: 'room',
      message: 'hello @bob',
      metadata: { priority: 'high' },
    });
    expect(sent).toMatchObject({ success: true, roomName: 'room', mentions: ['bob'] });

    const { messages } = await client.call('get_messages', { roomName: 'room' });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ agentName: 'alice', message: 'hello @bob', metadata: { priority: 'high' } });
  });

  it('requires a successful enter_room on this connection before send_message and wait_for_messages', async () => {
    await client.call('create_room', { roomName: 'room' });

    for (const tool of ['send_message', 'wait_for_messages'] as const) {
      const before = await client.call(tool, { roomName: 'room', message: 'too early', timeout: 1 });
      expect(invalidParams(before)).toBe(true);
      expect(before.error.message).toMatch(/has not entered room 'room'/);
      expect(before.error.message).toMatch(/agent_communication_enter_room/);
    }
    expect((await client.call('get_messages', { roomName: 'room' })).messages).toEqual([]);

    const entered = await client.call('enter_room', { agentName: 'alice', roomName: 'room' });
    expect(entered).toEqual({ success: true });
    expect((await client.call('send_message', { roomName: 'room', message: 'now' })).success).toBe(true);
  });

  it('creates no binding when the initial entry fails', async () => {
    const failed = await client.call('enter_room', { agentName: 'alice', roomName: 'missing' });
    expect(failed.error).toBeDefined();

    await client.call('create_room', { roomName: 'room' });
    const send = await client.call('send_message', { roomName: 'room', message: 'x' });
    expect(invalidParams(send)).toBe(true);
    expect(send.error.message).toMatch(/has not entered room 'room'/);
  });

  it('keeps the binding on a same-name re-entry (idempotent entry and profile)', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room', profile: { role: 'reviewer' } });
    await client.call('send_message', { roomName: 'room', message: 'first' });

    expect(await client.call('enter_room', { agentName: 'alice', roomName: 'room' })).toEqual({ success: true });
    expect((await client.call('list_room_users', { roomName: 'room' })).users[0].profile).toEqual({ role: 'reviewer' });
    expect((await client.call('send_message', { roomName: 'room', message: 'second' })).success).toBe(true);

    const { messages } = await client.call('get_messages', { roomName: 'room' });
    expect(messages.map((m: { message: string }) => m.message)).toEqual(['second', 'first']);
  });

  it('keeps one binding per room, so one instance can act as a different name in each room', async () => {
    await client.call('create_room', { roomName: 'a' });
    await client.call('create_room', { roomName: 'b' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'a' });
    await client.call('enter_room', { agentName: 'bob', roomName: 'b' });

    await client.call('send_message', { roomName: 'a', message: 'from a' });
    await client.call('send_message', { roomName: 'b', message: 'from b' });

    expect((await client.call('get_messages', { roomName: 'a' })).messages[0].agentName).toBe('alice');
    expect((await client.call('get_messages', { roomName: 'b' })).messages[0].agentName).toBe('bob');
  });

  it('does not carry a binding into a fresh instance of the same data directory', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });
    await client.call('send_message', { roomName: 'room', message: 'from alice' });

    const restarted = await createClient(dataDir);
    try {
      // alice is still a member row on disk, but this instance has not entered the room.
      expect((await restarted.call('list_room_users', { roomName: 'room' })).users.map((u: { name: string }) => u.name)).toEqual(['alice']);
      const send = await restarted.call('send_message', { roomName: 'room', message: 'unknown' });
      expect(invalidParams(send)).toBe(true);
      expect(send.error.message).toMatch(/has not entered room 'room'/);
    } finally {
      await restarted.close();
    }
  });

  it('keeps two instances using the same storage and room on their own names', async () => {
    await client.call('create_room', { roomName: 'room' });
    const other = await createClient(dataDir);
    try {
      await client.call('enter_room', { agentName: 'alice', roomName: 'room' });
      await other.call('enter_room', { agentName: 'bob', roomName: 'room' });

      await client.call('send_message', { roomName: 'room', message: 'from alice' });
      await other.call('send_message', { roomName: 'room', message: 'from bob' });

      const byMessage = Object.fromEntries(
        (await client.call('get_messages', { roomName: 'room' })).messages.map((m: { message: string; agentName: string }) => [
          m.message,
          m.agentName,
        ]),
      );
      expect(byMessage).toEqual({ 'from alice': 'alice', 'from bob': 'bob' });
      // Each instance still answers for its own name.
      expect((await other.call('send_message', { roomName: 'room', message: 'from bob again' })).success).toBe(true);
    } finally {
      await other.close();
    }
  });

  it('returns unread messages through wait_for_messages without agentName', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });
    const sender = await extraClient();
    await sender.call('enter_room', { agentName: 'sender', roomName: 'room' });
    await sender.call('send_message', { roomName: 'room', message: 'for alice' });

    const result = await client.call('wait_for_messages', { roomName: 'room', timeout: 5 });
    expect(result.messages.map((m: { message: string }) => m.message)).toEqual(['for alice']);
    expect(result).toMatchObject({ hasNewMessages: true, timedOut: false });

    // The wait respects mentionsOnly and timeout: 0 too.
    await sender.call('send_message', { roomName: 'room', message: 'for anyone' });
    const timeout = await client.call('wait_for_messages', { roomName: 'room', timeout: 1, mentionsOnly: true });
    expect(timeout).toEqual({ messages: [], hasNewMessages: false, timedOut: true });
  });

  it('switches a room to a different name: old name offline, new name usable, old waits canceled', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });
    const sender = await extraClient();
    await sender.call('enter_room', { agentName: 'sender', roomName: 'room' });

    // A pending indefinite wait for the old name.
    const oldWait = startWait('room');
    await waitUntilWaiting('room', 'alice');

    const started = Date.now();
    expect(await client.call('enter_room', { agentName: 'bob', roomName: 'room' })).toEqual({ success: true });
    // The long wait did not keep the switch from running.
    expect(Date.now() - started).toBeLessThan(2000);

    const canceled = await oldWait;
    expect(waitCancelled(canceled)).toBe(true);
    expect(await usersByName(client, 'room')).toMatchObject({ alice: 'offline', bob: 'online', sender: 'online' });

    // The new binding acts as bob and the canceled wait did not take a message meant for the next call.
    await sender.call('send_message', { roomName: 'room', message: 'after the switch' });
    const got = await client.call('wait_for_messages', { roomName: 'room', timeout: 3 });
    expect(got.messages.map((m: { message: string }) => m.message)).toEqual(['after the switch']);
    await client.call('send_message', { roomName: 'room', message: 'from bob' });
    expect(
      (await client.call('get_messages', { roomName: 'room' })).messages
        .filter((m: { agentName: string }) => m.agentName !== 'system')
        .map((m: { agentName: string }) => m.agentName),
    ).toEqual(['bob', 'sender']);
  });

  it('switches a room while a finite old-name wait is pending and cancels it', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });

    const finiteWait = client.call('wait_for_messages', { roomName: 'room', timeout: 30 });
    await waitUntilWaiting('room', 'alice');

    const started = Date.now();
    expect(await client.call('enter_room', { agentName: 'bob', roomName: 'room' })).toEqual({ success: true });
    expect(Date.now() - started).toBeLessThan(2000);

    const canceled = await finiteWait;
    expect(waitCancelled(canceled)).toBe(true);
    expect((await client.call('send_message', { roomName: 'room', message: 'from bob' })).success).toBe(true);
  });

  it('same-name re-entry keeps a pending wait and the unread cursor', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });
    const sender = await extraClient();
    await sender.call('enter_room', { agentName: 'sender', roomName: 'room' });

    const pending = startWait('room');
    await waitUntilWaiting('room', 'alice');

    expect(await client.call('enter_room', { agentName: 'alice', roomName: 'room' })).toEqual({ success: true });
    await sender.call('send_message', { roomName: 'room', message: 'kept for the same name' });

    const result = await pending;
    expect(result.messages.map((m: { message: string }) => m.message)).toEqual(['kept for the same name']);
  });

  it('fixes the acting name of an invocation that has already resolved it, even if the room switches while it runs', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });

    const messaging = (client.registry as any).messagingAdapter;
    const realSend = messaging.sendMessage.bind(messaging);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let capturedName: string | undefined;
    messaging.sendMessage = async (params: { agentName: string; roomName: string }) => {
      capturedName = params.agentName;
      await blocked;
      return { success: true, messageId: 'm', roomName: params.roomName, timestamp: new Date().toISOString(), mentions: [] };
    };
    try {
      const send = client.call('send_message', { roomName: 'room', message: 'from alice' });
      const deadline = Date.now() + 2000;
      while (capturedName === undefined) {
        if (Date.now() > deadline) throw new Error('send did not reach the adapter');
        await sleep(5);
      }
      // The invocation resolved alice before the switch; the switch to bob must not change it.
      expect(await client.call('enter_room', { agentName: 'bob', roomName: 'room' })).toEqual({ success: true });
      release();
      expect(await send).toMatchObject({ success: true });
      expect(capturedName).toBe('alice');
    } finally {
      release();
      messaging.sendMessage = realSend;
    }
  });

  it('successful leave of the selected name clears the binding and cancels its waits', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });
    const sender = await extraClient();
    await sender.call('enter_room', { agentName: 'sender', roomName: 'room' });

    const pending = startWait('room');
    await waitUntilWaiting('room', 'alice');

    expect(await client.call('leave_room', { agentName: 'alice', roomName: 'room' })).toEqual({ success: true });
    expect(waitCancelled(await pending)).toBe(true);

    // The binding is gone: this connection must enter the room again explicitly.
    const send = await client.call('send_message', { roomName: 'room', message: 'after leaving' });
    expect(invalidParams(send)).toBe(true);
    expect(send.error.message).toMatch(/has not entered room 'room'/);
    expect((await usersByName(client, 'room')).alice).toBe('offline');

    expect(await client.call('enter_room', { agentName: 'alice', roomName: 'room' })).toEqual({ success: true });
    expect((await client.call('send_message', { roomName: 'room', message: 'after re-entry' })).success).toBe(true);
  });

  it('leaving another name does not clear the selected binding or its waits', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });
    const sender = await extraClient();
    await sender.call('enter_room', { agentName: 'sender', roomName: 'room' });

    const pending = startWait('room');
    await waitUntilWaiting('room', 'alice');

    // `sender` is a member, so the leave succeeds, but it is not this connection's selected name.
    expect(await client.call('leave_room', { agentName: 'sender', roomName: 'room' })).toEqual({ success: true });
    expect((await client.call('send_message', { roomName: 'room', message: 'still alice' })).success).toBe(true);
    await sender.call('send_message', { roomName: 'room', message: 'not stolen' });
    expect((await pending).messages.map((m: { message: string }) => m.message)).toEqual(['not stolen']);
  });

  it('serializes overlapping different-name entries deterministically (the last one wins)', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });

    const [bob, carol] = await Promise.all([
      client.call('enter_room', { agentName: 'bob', roomName: 'room' }),
      client.call('enter_room', { agentName: 'carol', roomName: 'room' }),
    ]);
    expect(bob).toEqual({ success: true });
    expect(carol).toEqual({ success: true });

    expect((await client.call('send_message', { roomName: 'room', message: 'from the winner' })).success).toBe(true);
    expect((await client.call('get_messages', { roomName: 'room' })).messages[0].agentName).toBe('carol');
    expect(await usersByName(client, 'room')).toMatchObject({ alice: 'offline', bob: 'offline', carol: 'online' });
  });

  it('clears the binding when the replacement entry fails after the old name has left', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });

    const rooms = (client.registry as any).roomsAdapter;
    const realEnter = rooms.enterRoom.bind(rooms);
    rooms.enterRoom = async (params: { agentName: string; roomName: string }) => {
      if (params.agentName === 'bob') throw new Error('injected entry failure');
      return realEnter(params);
    };
    try {
      const failed = await client.call('enter_room', { agentName: 'bob', roomName: 'room' });
      expect(failed.error.message).toMatch(/injected entry failure/);

      // The old name left and the replacement never committed: this connection must re-enter explicitly.
      const send = await client.call('send_message', { roomName: 'room', message: 'x' });
      expect(invalidParams(send)).toBe(true);
      expect(send.error.message).toMatch(/has not entered room 'room'/);
      expect(await usersByName(client, 'room')).toMatchObject({ alice: 'offline' });
    } finally {
      rooms.enterRoom = realEnter;
    }
  });

  it('preserves the old binding when the old name cannot be left and is still usable', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });

    const rooms = (client.registry as any).roomsAdapter;
    const realLeave = rooms.leaveRoom.bind(rooms);
    rooms.leaveRoom = async (params: { agentName: string; roomName: string }) => {
      if (params.agentName === 'alice') throw new Error('injected leave failure');
      return realLeave(params);
    };
    try {
      const failed = await client.call('enter_room', { agentName: 'bob', roomName: 'room' });
      expect(failed.error.message).toMatch(/injected leave failure/);

      // alice is still a member, so the old binding is usable and bob was never joined.
      expect((await client.call('send_message', { roomName: 'room', message: 'still alice' })).success).toBe(true);
      expect((await client.call('get_messages', { roomName: 'room' })).messages[0].agentName).toBe('alice');
      expect(await usersByName(client, 'room')).toEqual({ alice: 'online' });
    } finally {
      rooms.leaveRoom = realLeave;
    }
  });

  it('clears the binding when a failed leave actually removed the old name', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });

    const rooms = (client.registry as any).roomsAdapter;
    const realLeave = rooms.leaveRoom.bind(rooms);
    rooms.leaveRoom = async (params: { agentName: string; roomName: string }) => {
      if (params.agentName === 'alice') {
        await realLeave(params);
        throw new Error('injected leave failure after the leave');
      }
      return realLeave(params);
    };
    try {
      const failed = await client.call('enter_room', { agentName: 'bob', roomName: 'room' });
      expect(failed.error.message).toMatch(/injected leave failure after the leave/);

      // The old name is no longer usable, so its binding must be gone.
      const send = await client.call('send_message', { roomName: 'room', message: 'x' });
      expect(invalidParams(send)).toBe(true);
      expect(send.error.message).toMatch(/has not entered room 'room'/);
      expect((await usersByName(client, 'room')).alice).toBe('offline');
    } finally {
      rooms.leaveRoom = realLeave;
    }
  });

  it('best-effort cleans up a replacement that joined before the entry failed, and surfaces a failed cleanup', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });

    const rooms = (client.registry as any).roomsAdapter;
    const realEnter = rooms.enterRoom.bind(rooms);
    const realLeave = rooms.leaveRoom.bind(rooms);
    rooms.enterRoom = async (params: { agentName: string; roomName: string }) => {
      const result = await realEnter(params);
      if (params.agentName === 'bob') throw new Error('injected entry failure after the join');
      return result;
    };
    try {
      const failed = await client.call('enter_room', { agentName: 'bob', roomName: 'room' });
      expect(failed.error.message).toMatch(/injected entry failure after the join/);
      // The partially joined replacement was left again.
      expect((await usersByName(client, 'room')).bob).toBe('offline');
      expect((await client.call('send_message', { roomName: 'room', message: 'x' })).error).toBeDefined();

      // A cleanup that fails is not hidden: the error says so. Re-enter alice so the next entry is a switch again.
      rooms.leaveRoom = realLeave;
      expect(await client.call('enter_room', { agentName: 'alice', roomName: 'room' })).toEqual({ success: true });
      rooms.leaveRoom = async (params: { agentName: string; roomName: string }) => {
        if (params.agentName === 'bob') throw new Error('injected cleanup failure');
        return realLeave(params);
      };
      const surfaced = await client.call('enter_room', { agentName: 'bob', roomName: 'room' });
      expect(surfaced.error.message).toMatch(/injected entry failure after the join/);
      expect(surfaced.error.message).toMatch(/cleanup also failed: injected cleanup failure/);
    } finally {
      rooms.enterRoom = realEnter;
      rooms.leaveRoom = realLeave;
    }
  });

  it('shutdown clears the bindings and ends the waits this instance owns', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });

    const pending = startWait('room');
    await waitUntilWaiting('room', 'alice');

    await client.registry.shutdown();
    expect(waitCancelled(await pending)).toBe(true);

    const send = await client.call('send_message', { roomName: 'room', message: 'after shutdown' });
    expect(send.error).toBeDefined();
    expect(send.error.message).toMatch(/has not entered room 'room'/);
  });

  it('refuses send and wait while a different-name switch is between leaving the old name and entering the new one', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });

    const rooms = (client.registry as any).roomsAdapter;
    const realEnter = rooms.enterRoom.bind(rooms);
    let reached!: () => void;
    const atReplacement = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    rooms.enterRoom = async (params: { agentName: string; roomName: string }) => {
      if (params.agentName === 'bob') {
        reached();
        await blocked;
      }
      return realEnter(params);
    };
    try {
      const switching = client.call('enter_room', { agentName: 'bob', roomName: 'room' });
      await atReplacement;
      // The old name has left (it is offline) and the replacement has not committed: the local selection is gone.
      expect((await usersByName(client, 'room')).alice).toBe('offline');

      const send = await client.call('send_message', { roomName: 'room', message: 'sent while switching' });
      expect(invalidParams(send)).toBe(true);
      expect(send.error.message).toMatch(/has not entered room 'room'/);

      const wait = await client.call('wait_for_messages', { roomName: 'room', timeout: 1 });
      expect(invalidParams(wait)).toBe(true);
      expect(wait.error.message).toMatch(/has not entered room 'room'/);

      // Neither call acted as the already-left name: nothing was stored and no wait registered under it.
      expect((await client.call('get_messages', { roomName: 'room' })).messages).toEqual([]);

      release();
      expect(await switching).toEqual({ success: true });
      expect((await client.call('send_message', { roomName: 'room', message: 'from bob' })).success).toBe(true);
      expect((await client.call('get_messages', { roomName: 'room' })).messages[0].agentName).toBe('bob');
    } finally {
      release();
      rooms.enterRoom = realEnter;
    }
  });

  it('suspends admission before an old-name leave so a held successful switch cannot act as the departed name', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });
    const sender = await extraClient();
    await sender.call('enter_room', { agentName: 'sender', roomName: 'room' });

    const rooms = (client.registry as any).roomsAdapter;
    const realLeave = rooms.leaveRoom.bind(rooms);
    let reached!: () => void;
    const atEffect = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    rooms.leaveRoom = async (params: { agentName: string; roomName: string }) => {
      const result = await realLeave(params);
      if (params.agentName === 'alice') {
        reached();
        await blocked;
      }
      return result;
    };
    try {
      const switching = client.call('enter_room', { agentName: 'bob', roomName: 'room' });
      await atEffect;
      // The real leave has taken effect, but its response is still in flight.
      expect(await usersByName(sender, 'room')).toMatchObject({ alice: 'offline' });

      const send = await client.call('send_message', { roomName: 'room', message: 'departed identity send' });
      expect(invalidParams(send)).toBe(true);
      expect(send.error.message).toMatch(/has not entered room 'room'/);

      await sender.call('send_message', { roomName: 'room', message: 'unread for alice' });
      const wait = await client.call('wait_for_messages', { roomName: 'room', timeout: 0 });
      expect(invalidParams(wait)).toBe(true);
      expect(wait.error.message).toMatch(/has not entered room 'room'/);

      // Neither call acted as the departed name: nothing was stored as alice and its cursor was not advanced.
      const stored = (await sender.call('get_messages', { roomName: 'room' })).messages as Array<{
        id: string;
        agentName: string;
        message: string;
      }>;
      expect(stored.filter((m) => m.agentName === 'alice')).toEqual([]);
      const unread = stored.find((m) => m.message === 'unread for alice')!;
      expect((await readStatus('room')).alice?.lastReadMessageId).not.toBe(unread.id);

      // The binding stays owned while suspended, so shutdown can still scope cleanup to it.
      expect((client.registry as any).identity.ownedIdentities()).toContainEqual({ roomName: 'room', agentName: 'alice' });

      release();
      expect(await switching).toEqual({ success: true });
      expect(await usersByName(client, 'room')).toMatchObject({ bob: 'online' });

      // The refused wait left the message unread: re-entering alice still returns it.
      expect(await client.call('enter_room', { agentName: 'alice', roomName: 'room' })).toEqual({ success: true });
      const got = await client.call('wait_for_messages', { roomName: 'room', timeout: 3 });
      expect(got.messages.map((m: { message: string }) => m.message)).toContain('unread for alice');
    } finally {
      release();
      rooms.leaveRoom = realLeave;
    }
  });

  it('suspends admission before a switch leave that fails after its effect and then clears the binding', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });
    const sender = await extraClient();
    await sender.call('enter_room', { agentName: 'sender', roomName: 'room' });

    const rooms = (client.registry as any).roomsAdapter;
    const realLeave = rooms.leaveRoom.bind(rooms);
    let reached!: () => void;
    const atEffect = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    rooms.leaveRoom = async (params: { agentName: string; roomName: string }) => {
      const result = await realLeave(params);
      if (params.agentName === 'alice') {
        reached();
        await blocked;
        throw new Error('injected leave failure after the effect');
      }
      return result;
    };
    try {
      const switching = client.call('enter_room', { agentName: 'bob', roomName: 'room' });
      await atEffect;
      expect(await usersByName(sender, 'room')).toMatchObject({ alice: 'offline' });

      const send = await client.call('send_message', { roomName: 'room', message: 'departed identity send' });
      expect(invalidParams(send)).toBe(true);
      expect(send.error.message).toMatch(/has not entered room 'room'/);
      await sender.call('send_message', { roomName: 'room', message: 'unread for alice' });
      const wait = await client.call('wait_for_messages', { roomName: 'room', timeout: 0 });
      expect(invalidParams(wait)).toBe(true);
      expect(wait.error.message).toMatch(/has not entered room 'room'/);

      release();
      expect((await switching).error.message).toMatch(/injected leave failure after the effect/);
      // The failed leave removed alice: the binding is cleared until an explicit re-entry.
      const after = await client.call('send_message', { roomName: 'room', message: 'after' });
      expect(invalidParams(after)).toBe(true);
      expect(after.error.message).toMatch(/has not entered room 'room'/);
      expect((await usersByName(client, 'room')).alice).toBe('offline');
    } finally {
      release();
      rooms.leaveRoom = realLeave;
    }
  });

  it('suspends admission before a selected-name leave and holds its response after the effect', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });
    const sender = await extraClient();
    await sender.call('enter_room', { agentName: 'sender', roomName: 'room' });

    const rooms = (client.registry as any).roomsAdapter;
    const realLeave = rooms.leaveRoom.bind(rooms);
    let reached!: () => void;
    const atEffect = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    rooms.leaveRoom = async (params: { agentName: string; roomName: string }) => {
      const result = await realLeave(params);
      if (params.agentName === 'alice') {
        reached();
        await blocked;
      }
      return result;
    };
    try {
      const leaving = client.call('leave_room', { agentName: 'alice', roomName: 'room' });
      await atEffect;
      expect(await usersByName(sender, 'room')).toMatchObject({ alice: 'offline' });

      const send = await client.call('send_message', { roomName: 'room', message: 'departed identity send' });
      expect(invalidParams(send)).toBe(true);
      expect(send.error.message).toMatch(/has not entered room 'room'/);
      const wait = await client.call('wait_for_messages', { roomName: 'room', timeout: 1 });
      expect(invalidParams(wait)).toBe(true);
      expect(wait.error.message).toMatch(/has not entered room 'room'/);

      release();
      expect(await leaving).toEqual({ success: true });
      const after = await client.call('send_message', { roomName: 'room', message: 'after' });
      expect(invalidParams(after)).toBe(true);
      expect(after.error.message).toMatch(/has not entered room 'room'/);
    } finally {
      release();
      rooms.leaveRoom = realLeave;
    }
  });

  it('restores the old binding and admission when a held leave fails with the old name still online', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });
    const sender = await extraClient();
    await sender.call('enter_room', { agentName: 'sender', roomName: 'room' });

    const rooms = (client.registry as any).roomsAdapter;
    const realLeave = rooms.leaveRoom.bind(rooms);
    let reached!: () => void;
    const atLeave = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    rooms.leaveRoom = async (params: { agentName: string; roomName: string }) => {
      if (params.agentName === 'alice') {
        reached();
        await blocked;
        throw new Error('injected leave failure before the effect');
      }
      return realLeave(params);
    };
    try {
      const switching = client.call('enter_room', { agentName: 'bob', roomName: 'room' });
      await atLeave;
      // Admission is suspended while the leave is unresolved, even though alice is still online.
      const during = await client.call('send_message', { roomName: 'room', message: 'during the leave' });
      expect(invalidParams(during)).toBe(true);
      expect(during.error.message).toMatch(/has not entered room 'room'/);
      expect((await usersByName(sender, 'room')).alice).toBe('online');

      release();
      expect((await switching).error.message).toMatch(/injected leave failure before the effect/);
      // The old name was provably still online, so its binding and admission are restored.
      expect((await client.call('send_message', { roomName: 'room', message: 'still alice' })).success).toBe(true);
      expect((await client.call('get_messages', { roomName: 'room' })).messages[0].agentName).toBe('alice');
    } finally {
      release();
      rooms.leaveRoom = realLeave;
    }
  });

  it('clears the binding and admission when a held leave fails and membership is unreadable', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });

    const rooms = (client.registry as any).roomsAdapter;
    const realLeave = rooms.leaveRoom.bind(rooms);
    const realList = rooms.listRoomUsers.bind(rooms);
    let reached!: () => void;
    const atEffect = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let failNextRead = false;
    rooms.leaveRoom = async (params: { agentName: string; roomName: string }) => {
      const result = await realLeave(params);
      if (params.agentName === 'alice') {
        reached();
        await blocked;
        failNextRead = true;
        throw new Error('injected leave failure after the effect');
      }
      return result;
    };
    rooms.listRoomUsers = async (params: { roomName: string }) => {
      if (failNextRead) {
        failNextRead = false;
        throw new Error('injected membership read failure');
      }
      return realList(params);
    };
    try {
      const switching = client.call('enter_room', { agentName: 'bob', roomName: 'room' });
      await atEffect;
      release();
      expect((await switching).error.message).toMatch(/injected leave failure after the effect/);
      // An unreadable membership is not proof the old name is usable: the binding is cleared.
      const after = await client.call('send_message', { roomName: 'room', message: 'after' });
      expect(invalidParams(after)).toBe(true);
      expect(after.error.message).toMatch(/has not entered room 'room'/);
    } finally {
      release();
      rooms.leaveRoom = realLeave;
      rooms.listRoomUsers = realList;
    }
  });

  it('keeps another room and another name usable while a switch holds the old-name leave response', async () => {
    await client.call('create_room', { roomName: 'a' });
    await client.call('create_room', { roomName: 'b' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'a' });
    await client.call('enter_room', { agentName: 'bob', roomName: 'b' });

    const rooms = (client.registry as any).roomsAdapter;
    const realLeave = rooms.leaveRoom.bind(rooms);
    let reached!: () => void;
    const atEffect = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    rooms.leaveRoom = async (params: { agentName: string; roomName: string }) => {
      const result = await realLeave(params);
      if (params.roomName === 'a' && params.agentName === 'alice') {
        reached();
        await blocked;
      }
      return result;
    };
    try {
      const switching = client.call('enter_room', { agentName: 'carol', roomName: 'a' });
      await atEffect;
      // Suspension is per room: room b still acts as bob.
      expect((await client.call('send_message', { roomName: 'b', message: 'from b' })).success).toBe(true);
      expect((await client.call('get_messages', { roomName: 'b' })).messages[0].agentName).toBe('bob');

      release();
      expect(await switching).toEqual({ success: true });
    } finally {
      release();
      rooms.leaveRoom = realLeave;
    }
  });

  it('cancels a pending indefinite old-name wait when a held switch leave is released', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });

    const pending = startWait('room');
    await waitUntilWaiting('room', 'alice');

    const rooms = (client.registry as any).roomsAdapter;
    const realLeave = rooms.leaveRoom.bind(rooms);
    let reached!: () => void;
    const atEffect = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    rooms.leaveRoom = async (params: { agentName: string; roomName: string }) => {
      const result = await realLeave(params);
      if (params.agentName === 'alice') {
        reached();
        await blocked;
      }
      return result;
    };
    try {
      const switching = client.call('enter_room', { agentName: 'bob', roomName: 'room' });
      await atEffect;
      // The wait is still owned while suspended, so shutdown could still end it; the switch is not blocked by it.
      expect((client.registry as any).identity.ownedIdentities()).toContainEqual({ roomName: 'room', agentName: 'alice' });

      release();
      expect(await switching).toEqual({ success: true });
      expect(waitCancelled(await pending)).toBe(true);
      expect(await usersByName(client, 'room')).toMatchObject({ bob: 'online' });
    } finally {
      release();
      rooms.leaveRoom = realLeave;
    }
  });

  it('does not start a replacement join when shutdown begins while a switch holds the old-name leave', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });

    const rooms = (client.registry as any).roomsAdapter;
    const realLeave = rooms.leaveRoom.bind(rooms);
    const realEnter = rooms.enterRoom.bind(rooms);
    const realList = rooms.listRoomUsers.bind(rooms);
    const joinsAfterShutdown: string[] = [];
    let prechecksAfterShutdown = 0;
    let bobLeaves = 0;
    let shutdownStarted = false;
    let reached!: () => void;
    const atEffect = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    rooms.leaveRoom = async (params: { agentName: string; roomName: string }) => {
      if (params.agentName === 'bob') bobLeaves++;
      const result = await realLeave(params);
      if (params.agentName === 'alice') {
        reached();
        await blocked;
      }
      return result;
    };
    rooms.enterRoom = async (params: { agentName: string; roomName: string }) => {
      if (shutdownStarted) joinsAfterShutdown.push(params.agentName);
      return realEnter(params);
    };
    rooms.listRoomUsers = async (params: { roomName: string }) => {
      const result = await realList(params);
      if (shutdownStarted) prechecksAfterShutdown++;
      return result;
    };
    try {
      const switching = client.call('enter_room', { agentName: 'bob', roomName: 'room' });
      await atEffect;
      // The real old-name leave has taken effect, but its response is still in flight.
      expect((await usersByName(client, 'room')).alice).toBe('offline');

      shutdownStarted = true;
      await client.registry.shutdown();
      release();

      const switched = await switching;
      expect(switched.error).toBeDefined();
      expect(switched.error.message).toMatch(/shutting down and no longer accepts room identity changes/);

      // Shutdown was observed before the replacement was joined: no precheck, no join and no cleanup leave.
      expect(prechecksAfterShutdown).toBe(0);
      expect(joinsAfterShutdown).toEqual([]);
      expect(bobLeaves).toBe(0);
      expect((await usersByName(client, 'room')).bob).toBeUndefined();

      const send = await client.call('send_message', { roomName: 'room', message: 'after shutdown' });
      expect(send.error).toBeDefined();
      expect(send.error.message).toMatch(/has not entered room 'room'/);
    } finally {
      release();
      rooms.leaveRoom = realLeave;
      rooms.enterRoom = realEnter;
      rooms.listRoomUsers = realList;
    }
  });

  it('shutdown while an initial entry is in flight leaves no binding and no queued entry commits', async () => {
    await client.call('create_room', { roomName: 'room' });

    const rooms = (client.registry as any).roomsAdapter;
    const realEnter = rooms.enterRoom.bind(rooms);
    let reached!: () => void;
    const atEntry = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    rooms.enterRoom = async (params: { agentName: string; roomName: string }) => {
      if (params.agentName === 'alice') {
        reached();
        await blocked;
      }
      return realEnter(params);
    };
    try {
      const aliceEntry = client.call('enter_room', { agentName: 'alice', roomName: 'room' });
      await atEntry;
      // A later entry queues behind the blocked one.
      const bobEntry = client.call('enter_room', { agentName: 'bob', roomName: 'room' });

      await client.registry.shutdown();
      release();

      expect((await aliceEntry).error).toBeDefined();
      expect((await bobEntry).error).toBeDefined();
      // No binding survived shutdown: an initial entry leaves the joined member as a normal shutdown does.
      const send = await client.call('send_message', { roomName: 'room', message: 'after shutdown' });
      expect(invalidParams(send)).toBe(true);
      expect(send.error.message).toMatch(/has not entered room 'room'/);
    } finally {
      release();
      rooms.enterRoom = realEnter;
    }
  });

  it('a failed switch to a name already online on another connection leaves that member online', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });
    const other = await extraClient();
    await other.call('enter_room', { agentName: 'bob', roomName: 'room' });
    expect((await usersByName(client, 'room')).bob).toBe('online');

    const rooms = (client.registry as any).roomsAdapter;
    const realEnter = rooms.enterRoom.bind(rooms);
    rooms.enterRoom = async (params: { agentName: string; roomName: string }) => {
      if (params.agentName === 'bob') throw new Error('entry failed before the join');
      return realEnter(params);
    };
    try {
      const failed = await client.call('enter_room', { agentName: 'bob', roomName: 'room' });
      expect(failed.error.message).toMatch(/entry failed before the join/);

      // bob was already online through the other connection: this switch must not leave it.
      expect((await usersByName(client, 'room')).bob).toBe('online');
      expect((await other.call('send_message', { roomName: 'room', message: 'still bob' })).success).toBe(true);
      expect((await client.call('send_message', { roomName: 'room', message: 'x' })).error).toBeDefined();
    } finally {
      rooms.enterRoom = realEnter;
    }
  });

  it('does not evict a member online elsewhere when the ownership lookup is unreadable', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });
    const other = await extraClient();
    await other.call('enter_room', { agentName: 'bob', roomName: 'room' });
    expect((await usersByName(client, 'room')).bob).toBe('online');

    const rooms = (client.registry as any).roomsAdapter;
    const realEnter = rooms.enterRoom.bind(rooms);
    const realList = rooms.listRoomUsers.bind(rooms);
    let readFailed = false;
    rooms.listRoomUsers = async (params: { roomName: string }) => {
      if (!readFailed) {
        readFailed = true;
        throw new Error('injected membership read failure');
      }
      return realList(params);
    };
    rooms.enterRoom = async (params: { agentName: string; roomName: string }) => {
      if (params.agentName === 'bob') throw new Error('entry failed before the join');
      return realEnter(params);
    };
    try {
      const failed = await client.call('enter_room', { agentName: 'bob', roomName: 'room' });
      expect(failed.error).toBeDefined();
      // An unreadable precheck is not absence: bob is online elsewhere and must stay online.
      expect((await usersByName(client, 'room')).bob).toBe('online');
      expect((await other.call('send_message', { roomName: 'room', message: 'still bob' })).success).toBe(true);
    } finally {
      rooms.enterRoom = realEnter;
      rooms.listRoomUsers = realList;
    }
  });

  it('cleans up a replacement that joined and then rejected while the instance shuts down', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });

    const rooms = (client.registry as any).roomsAdapter;
    const realEnter = rooms.enterRoom.bind(rooms);
    let joined!: () => void;
    const didJoin = new Promise<void>((resolve) => {
      joined = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    rooms.enterRoom = async (params: { agentName: string; roomName: string }) => {
      if (params.agentName === 'bob') {
        await realEnter(params);
        joined();
        await blocked;
        throw new Error('injected entry failure after the join');
      }
      return realEnter(params);
    };
    try {
      const switching = client.call('enter_room', { agentName: 'bob', roomName: 'room' });
      await didJoin;
      await client.registry.shutdown();
      release();
      const failed = await switching;
      expect(failed.error.message).toMatch(/injected entry failure after the join/);
      // The join this attempt introduced was cleaned up exactly once despite the shutdown.
      expect((await usersByName(client, 'room')).bob).toBe('offline');
    } finally {
      release();
      rooms.enterRoom = realEnter;
    }
  });

  it('surfaces a cleanup failure when a joined replacement rejects during shutdown', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });

    const rooms = (client.registry as any).roomsAdapter;
    const realEnter = rooms.enterRoom.bind(rooms);
    const realLeave = rooms.leaveRoom.bind(rooms);
    let joined!: () => void;
    const didJoin = new Promise<void>((resolve) => {
      joined = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    rooms.enterRoom = async (params: { agentName: string; roomName: string }) => {
      if (params.agentName === 'bob') {
        await realEnter(params);
        joined();
        await blocked;
        throw new Error('injected entry failure after the join');
      }
      return realEnter(params);
    };
    rooms.leaveRoom = async (params: { agentName: string; roomName: string }) => {
      if (params.agentName === 'bob') throw new Error('injected cleanup failure');
      return realLeave(params);
    };
    try {
      const switching = client.call('enter_room', { agentName: 'bob', roomName: 'room' });
      await didJoin;
      await client.registry.shutdown();
      release();
      const failed = await switching;
      expect(failed.error.message).toMatch(/injected entry failure after the join/);
      expect(failed.error.message).toMatch(/cleanup also failed: injected cleanup failure/);
    } finally {
      release();
      rooms.enterRoom = realEnter;
      rooms.leaveRoom = realLeave;
    }
  });

  it('keeps admission closed and cleanup ownership when shutdown overlaps a held switch leave that then fails after its effect', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });

    // A pending wait this instance owns: shutdown must end it without consuming its unread messages.
    const pending = startWait('room');
    await waitUntilWaiting('room', 'alice');

    const identity = (client.registry as any).identity;
    const rooms = (client.registry as any).roomsAdapter;
    const realLeave = rooms.leaveRoom.bind(rooms);
    const realEnter = rooms.enterRoom.bind(rooms);
    const joinsAfterShutdown: string[] = [];
    let bobLeaves = 0;
    let shutdownStarted = false;
    let reached!: () => void;
    const atEffect = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    rooms.leaveRoom = async (params: { agentName: string; roomName: string }) => {
      if (params.agentName === 'bob') bobLeaves++;
      const result = await realLeave(params);
      if (params.agentName === 'alice') {
        reached();
        await blocked;
        throw new Error('injected leave failure after the effect');
      }
      return result;
    };
    rooms.enterRoom = async (params: { agentName: string; roomName: string }) => {
      if (shutdownStarted) joinsAfterShutdown.push(params.agentName);
      return realEnter(params);
    };
    try {
      const switching = client.call('enter_room', { agentName: 'bob', roomName: 'room' });
      await atEffect;
      // The real old-name leave has taken effect, but its response is still in flight: the room is suspended.
      expect(await usersByName(client, 'room')).toMatchObject({ alice: 'offline' });
      const refused = await client.call('send_message', { roomName: 'room', message: 'during recovery' });
      expect(invalidParams(refused)).toBe(true);

      // While the transition is unresolved, the suspended binding stays owned, so shutdown can still scope cleanup to it.
      const ownedBeforeShutdown = identity.ownedIdentities();
      expect(ownedBeforeShutdown).toContainEqual({ roomName: 'room', agentName: 'alice' });

      shutdownStarted = true;
      await client.registry.shutdown();
      release();

      // The leave failure recovery runs after shutdown: it must not restart admission or start a replacement join.
      expect((await switching).error.message).toMatch(/injected leave failure after the effect/);
      expect(waitCancelled(await pending)).toBe(true);
      expect(joinsAfterShutdown).toEqual([]);
      expect(bobLeaves).toBe(0);
      expect((await usersByName(client, 'room')).bob).toBeUndefined();
      const after = await client.call('send_message', { roomName: 'room', message: 'after shutdown' });
      expect(invalidParams(after)).toBe(true);
      expect(after.error.message).toMatch(/has not entered room 'room'/);
    } finally {
      release();
      rooms.leaveRoom = realLeave;
      rooms.enterRoom = realEnter;
    }
  });

  it('does not revive admission when shutdown overlaps a selected-name leave failure that still finds the name online', async () => {
    await client.call('create_room', { roomName: 'room' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room' });

    const identity = (client.registry as any).identity;
    const rooms = (client.registry as any).roomsAdapter;
    const realLeave = rooms.leaveRoom.bind(rooms);
    let reached!: () => void;
    const atLeave = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    rooms.leaveRoom = async (params: { agentName: string; roomName: string }) => {
      if (params.agentName === 'alice') {
        reached();
        await blocked;
        // Fails before its effect, so the old name is provably still online: the recovery would normally restore it.
        throw new Error('injected leave failure before the effect');
      }
      return realLeave(params);
    };
    try {
      const leaving = client.call('leave_room', { agentName: 'alice', roomName: 'room' });
      await atLeave;
      expect(await usersByName(client, 'room')).toMatchObject({ alice: 'online' });
      const during = await client.call('send_message', { roomName: 'room', message: 'during leave' });
      expect(invalidParams(during)).toBe(true);
      const ownedBeforeShutdown = identity.ownedIdentities();
      expect(ownedBeforeShutdown).toContainEqual({ roomName: 'room', agentName: 'alice' });

      await client.registry.shutdown();
      release();

      expect((await leaving).error.message).toMatch(/injected leave failure before the effect/);
      // alice is still online, but shutdown already cleared the binding: the recovery must not restore admission.
      const after = await client.call('send_message', { roomName: 'room', message: 'after shutdown' });
      expect(invalidParams(after)).toBe(true);
      expect(after.error.message).toMatch(/has not entered room 'room'/);
    } finally {
      release();
      rooms.leaveRoom = realLeave;
    }
  });
});
