// Room identity in cloud mode against the real agora: enter_room selects the acting agent name for one MCP server
// instance and room, and send_message acts as it without taking agentName. The name is never stored in the cloud
// room state and is not shared between instances, even when they use the same API token.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CloudApiClient, getCloudBackend } from '../../src/cloud/index.js';
import { createMcpClient, enterAgents, waitUntil, type McpTestClient } from './harness/mcp.js';

const INVALID_PARAMS = -32602;
const agoraUrl = process.env.AGENT_COMM_API_URL!;
const token = process.env.AGENT_COMM_TOKEN!;

describe('room identity in cloud mode', () => {
  let client: McpTestClient;
  let api: CloudApiClient;

  /** The member rows of a room, by name (status and pending wait included). */
  const membersOf = async (roomName: string) => {
    const list = await api.listMembers(roomName);
    return Object.fromEntries(list.members.map((member) => [member.agentName, member]));
  };

  beforeEach(async () => {
    client = await createMcpClient();
    api = new CloudApiClient({ apiUrl: agoraUrl, token });
  });

  afterEach(async () => {
    await client.close();
  });

  it('sends without agentName as the name enter_room selected, keeping the other inputs', async () => {
    await client.call('create_room', { roomName: 'identity' });
    expect(await client.call('enter_room', { agentName: 'alice', roomName: 'identity' })).toEqual({ success: true });

    const sent = await client.call('send_message', { roomName: 'identity', message: 'hello @bob' });
    expect(sent).toMatchObject({ success: true, roomName: 'identity', mentions: ['bob'] });

    const { messages } = await client.call('get_messages', { agentName: 'alice', roomName: 'identity' });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ agentName: 'alice', message: 'hello @bob' });
  });

  it('rejects an explicit agentName at runtime, even when it matches the selected name', async () => {
    await client.call('create_room', { roomName: 'identity' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'identity' });

    for (const agentName of ['alice', 'bob']) {
      await expect(client.call('send_message', { agentName, roomName: 'identity', message: 'hi' })).rejects.toMatchObject({
        code: INVALID_PARAMS,
        message: expect.stringMatching(/'agentName' is not an input of agent_communication_send_message/),
      });
    }
    expect((await client.call('get_messages', { roomName: 'identity' })).messages).toEqual([]);
  });

  it('requires a successful enter_room on this connection before send_message', async () => {
    await client.call('create_room', { roomName: 'identity' });

    await expect(client.call('send_message', { roomName: 'identity', message: 'too early' })).rejects.toMatchObject({
      code: INVALID_PARAMS,
      message: expect.stringMatching(/has not entered room 'identity'/),
    });
    expect((await client.call('get_messages', { roomName: 'identity' })).messages).toEqual([]);

    await client.call('enter_room', { agentName: 'alice', roomName: 'identity' });
    expect((await client.call('send_message', { roomName: 'identity', message: 'now' })).success).toBe(true);
  });

  it('creates no binding when the initial entry fails', async () => {
    await expect(client.call('enter_room', { agentName: 'alice', roomName: 'missing' })).rejects.toThrow(/not found/);

    await client.call('create_room', { roomName: 'identity' });
    await expect(client.call('send_message', { roomName: 'identity', message: 'x' })).rejects.toThrow(/has not entered room/);
  });

  it('keeps the binding on a same-name re-entry (idempotent entry and profile)', async () => {
    const profile = { role: 'reviewer', capabilities: ['review'] };
    await client.call('create_room', { roomName: 'identity' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'identity', profile });
    await client.call('send_message', { roomName: 'identity', message: 'first' });

    expect(await client.call('enter_room', { agentName: 'alice', roomName: 'identity' })).toEqual({ success: true });
    expect(await client.call('list_room_users', { roomName: 'identity' })).toMatchObject({
      users: [{ name: 'alice', status: 'online', profile }],
    });
    expect((await client.call('send_message', { roomName: 'identity', message: 'second' })).success).toBe(true);
  });

  it('keeps one binding per room, so one instance can act as a different name in each room', async () => {
    await client.call('create_room', { roomName: 'room-a' });
    await client.call('create_room', { roomName: 'room-b' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'room-a' });
    await client.call('enter_room', { agentName: 'bob', roomName: 'room-b' });

    await client.call('send_message', { roomName: 'room-a', message: 'from a' });
    await client.call('send_message', { roomName: 'room-b', message: 'from b' });

    expect((await client.call('get_messages', { roomName: 'room-a' })).messages[0].agentName).toBe('alice');
    expect((await client.call('get_messages', { roomName: 'room-b' })).messages[0].agentName).toBe('bob');
  });

  it('a switch on one connection leaves another connection acting as its own name', async () => {
    const roomName = 'identity-switch-isolated';
    await client.call('create_room', { roomName });
    const other = await createMcpClient();
    try {
      await client.call('enter_room', { agentName: 'alice', roomName });
      await other.call('enter_room', { agentName: 'bob', roomName });

      // client switches alice -> carol; the other connection still acts as bob.
      expect(await client.call('enter_room', { agentName: 'carol', roomName })).toEqual({ success: true });
      expect((await other.call('send_message', { roomName, message: 'from bob' })).success).toBe(true);
      expect((await client.call('send_message', { roomName, message: 'from carol' })).success).toBe(true);

      const byMessage = Object.fromEntries(
        (await client.call('get_messages', { roomName })).messages.map((m: { message: string; agentName: string }) => [m.message, m.agentName]),
      );
      expect(byMessage).toEqual({ 'from bob': 'bob', 'from carol': 'carol' });
    } finally {
      await other.close();
    }
  });

  it('keeps two connections using the same token and room on their own names', async () => {
    await client.call('create_room', { roomName: 'identity' });
    const other = await createMcpClient();
    try {
      await client.call('enter_room', { agentName: 'alice', roomName: 'identity' });
      await other.call('enter_room', { agentName: 'bob', roomName: 'identity' });

      await client.call('send_message', { roomName: 'identity', message: 'from alice' });
      await other.call('send_message', { roomName: 'identity', message: 'from bob' });

      const byMessage = Object.fromEntries(
        (await client.call('get_messages', { roomName: 'identity' })).messages.map((m: { message: string; agentName: string }) => [
          m.message,
          m.agentName,
        ]),
      );
      expect(byMessage).toEqual({ 'from alice': 'alice', 'from bob': 'bob' });
      // Each connection still answers for its own name.
      expect((await other.call('send_message', { roomName: 'identity', message: 'from bob again' })).success).toBe(true);
    } finally {
      await other.close();
    }
  });

  it('does not carry a binding into a fresh connection, even with the member row on the server', async () => {
    await client.call('create_room', { roomName: 'identity' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'identity' });
    await client.call('send_message', { roomName: 'identity', message: 'from alice' });

    const restarted = await createMcpClient();
    try {
      expect((await restarted.call('list_room_users', { roomName: 'identity' })).users.map((u: { name: string }) => u.name)).toEqual(['alice']);
      await expect(restarted.call('send_message', { roomName: 'identity', message: 'unknown' })).rejects.toThrow(/has not entered room/);
    } finally {
      await restarted.close();
    }
  });

  it('returns unread messages through wait_for_messages without agentName and rejects an explicit agentName', async () => {
    const roomName = 'identity-wait';
    await client.call('create_room', { roomName });
    const agents = await enterAgents(client, roomName, ['alice', 'bob']);

    await expect(client.call('wait_for_messages', { agentName: 'alice', roomName, timeout: 1 })).rejects.toMatchObject({
      code: INVALID_PARAMS,
      message: expect.stringMatching(/'agentName' is not an input of agent_communication_wait_for_messages/),
    });

    await agents.of('bob').call('send_message', { roomName, message: 'hello alice' });
    const result = await client.call('wait_for_messages', { roomName, timeout: 5 });
    expect(result.messages.map((m: { message: string }) => m.message)).toEqual(['hello alice']);
    expect(result).toMatchObject({ hasNewMessages: true, timedOut: false });
  });

  it('requires a successful enter_room on this connection before wait_for_messages', async () => {
    await client.call('create_room', { roomName: 'identity-wait-missing' });
    await expect(client.call('wait_for_messages', { roomName: 'identity-wait-missing', timeout: 1 })).rejects.toThrow(
      /has not entered room 'identity-wait-missing'/,
    );
  });

  it('switches to a different name, leaves the old one and cancels its pending indefinite wait', async () => {
    const roomName = 'identity-switch';
    await client.call('create_room', { roomName });
    const agents = await enterAgents(client, roomName, ['alice', 'bob']);

    const pending = client.call('wait_for_messages', { roomName, timeout: 0 });
    // The wait ends with an error by design; keep the rejection handled until the assertion below takes it.
    pending.catch(() => undefined);
    await waitUntil(async () => (await membersOf(roomName)).alice?.waiting === true, 5000, 'alice waiting');

    const started = Date.now();
    expect(await client.call('enter_room', { agentName: 'dave', roomName })).toEqual({ success: true });
    // The long wait did not keep the switch from running.
    expect(Date.now() - started).toBeLessThan(3000);

    await expect(pending).rejects.toMatchObject({ message: expect.stringMatching(/Waiting for messages ended without a result/) });
    const members = await membersOf(roomName);
    expect(members.alice?.status).toBe('offline');
    expect(members.dave?.status).toBe('online');

    // The canceled wait did not take the message meant for the next call, which acts as the new name.
    await agents.of('bob').call('send_message', { roomName, message: 'after the switch' });
    const got = await client.call('wait_for_messages', { roomName, timeout: 5 });
    expect(got.messages.map((m: { message: string }) => m.message)).toEqual(['after the switch']);
  });

  it('cancels a pending finite old-name wait when the room switches names', async () => {
    const roomName = 'identity-switch-finite';
    await client.call('create_room', { roomName });
    await client.call('enter_room', { agentName: 'alice', roomName });

    const finite = client.call('wait_for_messages', { roomName, timeout: 30 });
    finite.catch(() => undefined);
    await waitUntil(async () => (await membersOf(roomName)).alice?.waiting === true, 5000, 'alice waiting');

    expect(await client.call('enter_room', { agentName: 'erin', roomName })).toEqual({ success: true });
    await expect(finite).rejects.toMatchObject({ message: expect.stringMatching(/Waiting for messages ended without a result/) });
  });

  it('clears the binding and cancels waits when the selected name leaves, and not when another name leaves', async () => {
    const roomName = 'identity-leave';
    await client.call('create_room', { roomName });
    await enterAgents(client, roomName, ['alice', 'bob']);

    const pending = client.call('wait_for_messages', { roomName, timeout: 0 });
    pending.catch(() => undefined);
    await waitUntil(async () => (await membersOf(roomName)).alice?.waiting === true, 5000, 'alice waiting');

    expect(await client.call('leave_room', { agentName: 'alice', roomName })).toEqual({ success: true });
    await expect(pending).rejects.toMatchObject({ message: expect.stringMatching(/Waiting for messages ended without a result/) });
    await expect(client.call('send_message', { roomName, message: 'x' })).rejects.toThrow(/has not entered room/);

    // Leaving another name keeps the selected binding (and would keep its waits).
    await client.call('enter_room', { agentName: 'erin', roomName });
    expect(await client.call('leave_room', { agentName: 'bob', roomName })).toEqual({ success: true });
    expect((await client.call('send_message', { roomName, message: 'still erin' })).success).toBe(true);
  });

  it('serializes overlapping different-name entries deterministically (the last one wins)', async () => {
    const roomName = 'identity-concurrent';
    await client.call('create_room', { roomName });
    await client.call('enter_room', { agentName: 'alice', roomName });

    const [bob, carol] = await Promise.all([
      client.call('enter_room', { agentName: 'bob', roomName }),
      client.call('enter_room', { agentName: 'carol', roomName }),
    ]);
    expect(bob).toEqual({ success: true });
    expect(carol).toEqual({ success: true });

    await client.call('send_message', { roomName, message: 'from the winner' });
    expect((await client.call('get_messages', { roomName })).messages[0].agentName).toBe('carol');
  });

  it('shutdown ends a pending wait and clears the binding', async () => {
    const roomName = 'identity-shutdown';
    await client.call('create_room', { roomName });
    await enterAgents(client, roomName, ['alice']);

    const pending = client.call('wait_for_messages', { roomName, timeout: 0 });
    pending.catch(() => undefined);
    await waitUntil(async () => (await membersOf(roomName)).alice?.waiting === true, 5000, 'alice waiting');

    await client.registry.shutdown();
    await expect(pending).rejects.toMatchObject({ message: expect.stringMatching(/Waiting for messages ended without a result/) });
    await expect(client.call('send_message', { roomName, message: 'x' })).rejects.toThrow(/has not entered room/);
  });

  it('refuses send and wait while a different-name switch is between leaving the old name and entering the new one', async () => {
    const roomName = 'identity-switch-gap';
    await client.call('create_room', { roomName });
    await client.call('enter_room', { agentName: 'alice', roomName });

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
      const switching = client.call('enter_room', { agentName: 'bob', roomName });
      await atReplacement;
      await expect(client.call('send_message', { roomName, message: 'sent while switching' })).rejects.toThrow(
        /has not entered room/,
      );
      await expect(client.call('wait_for_messages', { roomName, timeout: 1 })).rejects.toThrow(/has not entered room/);
      release();
      expect(await switching).toEqual({ success: true });
      expect((await client.call('send_message', { roomName, message: 'from bob' })).success).toBe(true);
    } finally {
      release();
      rooms.enterRoom = realEnter;
    }
  });

  it('suspends admission before an old-name leave so a held switch cannot act as the departed name', async () => {
    const roomName = 'identity-leave-window';
    await client.call('create_room', { roomName });
    await enterAgents(client, roomName, ['alice', 'sender']);

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
      const switching = client.call('enter_room', { agentName: 'bob', roomName });
      await atEffect;
      // The real leave has taken effect, but its response is still in flight.
      expect((await membersOf(roomName)).alice?.status).toBe('offline');

      await expect(client.call('send_message', { roomName, message: 'departed identity send' })).rejects.toMatchObject({
        code: INVALID_PARAMS,
        message: expect.stringMatching(/has not entered room/),
      });
      await expect(client.call('wait_for_messages', { roomName, timeout: 1 })).rejects.toThrow(/has not entered room/);

      release();
      expect(await switching).toEqual({ success: true });
      expect((await membersOf(roomName)).bob?.status).toBe('online');
      expect((await client.call('send_message', { roomName, message: 'from bob' })).success).toBe(true);
    } finally {
      release();
      rooms.leaveRoom = realLeave;
    }
  });

  it('suspends admission before a selected-name leave and holds its response after the effect', async () => {
    const roomName = 'identity-leave-window-selected';
    await client.call('create_room', { roomName });
    await enterAgents(client, roomName, ['alice', 'sender']);

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
      const leaving = client.call('leave_room', { agentName: 'alice', roomName });
      await atEffect;
      expect((await membersOf(roomName)).alice?.status).toBe('offline');

      await expect(client.call('send_message', { roomName, message: 'departed identity send' })).rejects.toMatchObject({
        code: INVALID_PARAMS,
        message: expect.stringMatching(/has not entered room/),
      });
      await expect(client.call('wait_for_messages', { roomName, timeout: 1 })).rejects.toThrow(/has not entered room/);

      release();
      expect(await leaving).toEqual({ success: true });
      await expect(client.call('send_message', { roomName, message: 'after' })).rejects.toThrow(/has not entered room/);
    } finally {
      release();
      rooms.leaveRoom = realLeave;
    }
  });

  it('clears the binding when a switch leave fails after its effect', async () => {
    const roomName = 'identity-leave-window-failure';
    await client.call('create_room', { roomName });
    await client.call('enter_room', { agentName: 'alice', roomName });

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
      const switching = client.call('enter_room', { agentName: 'bob', roomName });
      await atEffect;
      release();
      await expect(switching).rejects.toThrow(/injected leave failure after the effect/);
      await expect(client.call('send_message', { roomName, message: 'after' })).rejects.toThrow(/has not entered room/);
      expect((await membersOf(roomName)).alice?.status).toBe('offline');
    } finally {
      release();
      rooms.leaveRoom = realLeave;
    }
  });

  it('restores admission when a held leave fails with the old name still online', async () => {
    const roomName = 'identity-leave-window-online';
    await client.call('create_room', { roomName });
    await client.call('enter_room', { agentName: 'alice', roomName });

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
      const switching = client.call('enter_room', { agentName: 'bob', roomName });
      await atLeave;
      await expect(client.call('send_message', { roomName, message: 'during' })).rejects.toThrow(/has not entered room/);
      expect((await membersOf(roomName)).alice?.status).toBe('online');

      release();
      await expect(switching).rejects.toThrow(/injected leave failure before the effect/);
      expect((await client.call('send_message', { roomName, message: 'still alice' })).success).toBe(true);
    } finally {
      release();
      rooms.leaveRoom = realLeave;
    }
  });

  it('does not start a replacement join when shutdown begins while a switch holds the old-name leave', async () => {
    const roomName = 'identity-shutdown-switch-leave';
    await client.call('create_room', { roomName });
    await client.call('enter_room', { agentName: 'alice', roomName });

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
      const switching = client.call('enter_room', { agentName: 'bob', roomName });
      await atEffect;
      // The real old-name leave has taken effect, but its response is still in flight.
      expect((await membersOf(roomName)).alice?.status).toBe('offline');

      shutdownStarted = true;
      await client.registry.shutdown();
      release();

      await expect(switching).rejects.toThrow(/shutting down and no longer accepts room identity changes/);
      // Shutdown was observed before the replacement was joined: no precheck, no join and no cleanup leave.
      expect(prechecksAfterShutdown).toBe(0);
      expect(joinsAfterShutdown).toEqual([]);
      expect(bobLeaves).toBe(0);
      expect((await membersOf(roomName)).bob).toBeUndefined();
    } finally {
      release();
      rooms.leaveRoom = realLeave;
      rooms.enterRoom = realEnter;
      rooms.listRoomUsers = realList;
    }
  });

  it('shutdown while an initial entry is in flight does not restore a binding or let a queued entry commit', async () => {
    const roomName = 'identity-shutdown-race';
    await client.call('create_room', { roomName });

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
      const aliceEntry = client.call('enter_room', { agentName: 'alice', roomName });
      await atEntry;
      const bobEntry = client.call('enter_room', { agentName: 'bob', roomName });

      await client.registry.shutdown();
      release();

      await expect(aliceEntry).rejects.toBeInstanceOf(Error);
      await expect(bobEntry).rejects.toBeInstanceOf(Error);
      await expect(client.call('send_message', { roomName, message: 'after shutdown' })).rejects.toThrow(
        /has not entered room/,
      );
    } finally {
      release();
      rooms.enterRoom = realEnter;
    }
  });

  it('a failed switch to a name already online on another connection leaves that member online', async () => {
    const roomName = 'identity-switch-preexisting';
    await client.call('create_room', { roomName });
    await client.call('enter_room', { agentName: 'alice', roomName });
    const other = await createMcpClient();
    try {
      await other.call('enter_room', { agentName: 'bob', roomName });
      expect((await membersOf(roomName)).bob?.status).toBe('online');

      const rooms = (client.registry as any).roomsAdapter;
      const realEnter = rooms.enterRoom.bind(rooms);
      rooms.enterRoom = async (params: { agentName: string; roomName: string }) => {
        if (params.agentName === 'bob') throw new Error('entry failed before the join');
        return realEnter(params);
      };
      try {
        await expect(client.call('enter_room', { agentName: 'bob', roomName })).rejects.toThrow(/entry failed before the join/);
        expect((await membersOf(roomName)).bob?.status).toBe('online');
        expect((await other.call('send_message', { roomName, message: 'still bob' })).success).toBe(true);
      } finally {
        rooms.enterRoom = realEnter;
      }
    } finally {
      await other.close();
    }
  });

  it('shutdown of one same-token connection leaves another connection WebSocket, presence and wait untouched', async () => {
    const roomName = 'identity-shutdown-isolation';
    await client.call('create_room', { roomName });
    await client.call('enter_room', { agentName: 'alice', roomName });
    const other = await createMcpClient();
    try {
      await other.call('enter_room', { agentName: 'bob', roomName });

      const pending = other.call('wait_for_messages', { roomName, timeout: 0 });
      pending.catch(() => undefined);
      const backend = getCloudBackend()!;
      await waitUntil(async () => (await membersOf(roomName)).bob?.waiting === true, 5000, 'bob waiting');
      await waitUntil(() => backend.waits.hasOpenSocket(roomName, 'bob'), 5000, 'bob socket');

      await client.registry.shutdown();

      // A's shutdown is A's alone: bob's WebSocket, presence and wait belong to the other connection.
      expect(backend.waits.hasOpenSocket(roomName, 'bob')).toBe(true);
      expect((await membersOf(roomName)).bob?.status).toBe('online');
      expect((await membersOf(roomName)).bob?.connected).toBe(true);

      const sender = await createMcpClient();
      try {
        await sender.call('enter_room', { agentName: 'carol', roomName });
        await sender.call('send_message', { roomName, message: 'for bob' });
        const got = await pending;
        expect(got.messages.map((m: { message: string }) => m.message)).toContain('for bob');
      } finally {
        await sender.close();
      }
    } finally {
      await other.close();
    }
  });

  it('does not evict a member online elsewhere when the ownership lookup is unreadable', async () => {
    const roomName = 'identity-unknown-membership';
    await client.call('create_room', { roomName });
    await client.call('enter_room', { agentName: 'alice', roomName });
    const other = await createMcpClient();
    try {
      await other.call('enter_room', { agentName: 'bob', roomName });
      expect((await membersOf(roomName)).bob?.status).toBe('online');

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
        await expect(client.call('enter_room', { agentName: 'bob', roomName })).rejects.toThrow(/entry failed before the join/);
        // An unreadable precheck is not absence: bob is online elsewhere and must stay online.
        expect((await membersOf(roomName)).bob?.status).toBe('online');
        expect((await other.call('send_message', { roomName, message: 'still bob' })).success).toBe(true);
      } finally {
        rooms.enterRoom = realEnter;
        rooms.listRoomUsers = realList;
      }
    } finally {
      await other.close();
    }
  });

  it('cleans up a replacement that joined and then rejected while the instance shuts down', async () => {
    const roomName = 'identity-shutdown-partial';
    await client.call('create_room', { roomName });
    await client.call('enter_room', { agentName: 'alice', roomName });

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
      const switching = client.call('enter_room', { agentName: 'bob', roomName });
      await didJoin;
      await client.registry.shutdown();
      release();
      await expect(switching).rejects.toThrow(/injected entry failure after the join/);
      // The join this attempt introduced was cleaned up exactly once despite the shutdown.
      expect((await membersOf(roomName)).bob?.status).toBe('offline');
    } finally {
      release();
      rooms.enterRoom = realEnter;
    }
  });

  it('keeps admission closed and cleanup ownership when shutdown overlaps a held switch leave that then fails after its effect', async () => {
    const roomName = 'identity-shutdown-recovery-switch';
    await client.call('create_room', { roomName });
    await client.call('enter_room', { agentName: 'alice', roomName });

    // A pending wait this instance owns: shutdown must end it.
    const pending = client.call('wait_for_messages', { roomName, timeout: 0 });
    pending.catch(() => undefined);
    await waitUntil(async () => (await membersOf(roomName)).alice?.waiting === true, 5000, 'alice waiting');

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
      const switching = client.call('enter_room', { agentName: 'bob', roomName });
      await atEffect;
      expect((await membersOf(roomName)).alice?.status).toBe('offline');
      await expect(client.call('send_message', { roomName, message: 'during recovery' })).rejects.toThrow(
        /has not entered room/,
      );

      // While the transition is unresolved, the suspended binding stays owned, so shutdown can still scope cleanup to it.
      expect(identity.ownedIdentities()).toContainEqual({ roomName, agentName: 'alice' });

      shutdownStarted = true;
      await client.registry.shutdown();
      release();

      await expect(switching).rejects.toThrow(/injected leave failure after the effect/);
      await expect(pending).rejects.toThrow(/Waiting for messages ended without a result/);
      // The recovery runs after shutdown: no replacement precheck, join or cleanup leave may start.
      expect(joinsAfterShutdown).toEqual([]);
      expect(bobLeaves).toBe(0);
      expect((await membersOf(roomName)).bob).toBeUndefined();
      await expect(client.call('send_message', { roomName, message: 'after shutdown' })).rejects.toThrow(
        /has not entered room/,
      );
    } finally {
      release();
      rooms.leaveRoom = realLeave;
      rooms.enterRoom = realEnter;
    }
  });

  it('does not revive admission when shutdown overlaps a selected-name leave failure that still finds the name online', async () => {
    const roomName = 'identity-shutdown-recovery-leave';
    await client.call('create_room', { roomName });
    await client.call('enter_room', { agentName: 'alice', roomName });

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
      const leaving = client.call('leave_room', { agentName: 'alice', roomName });
      await atLeave;
      expect((await membersOf(roomName)).alice?.status).toBe('online');
      await expect(client.call('send_message', { roomName, message: 'during leave' })).rejects.toThrow(
        /has not entered room/,
      );
      expect(identity.ownedIdentities()).toContainEqual({ roomName, agentName: 'alice' });

      await client.registry.shutdown();
      release();

      await expect(leaving).rejects.toThrow(/injected leave failure before the effect/);
      // alice is still online, but shutdown already cleared the binding: the recovery must not restore admission.
      await expect(client.call('send_message', { roomName, message: 'after shutdown' })).rejects.toThrow(
        /has not entered room/,
      );
    } finally {
      release();
      rooms.leaveRoom = realLeave;
    }
  });
});
