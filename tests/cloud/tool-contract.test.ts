// The existing tool outputs rebuilt from the cloud API (docs/cloud-architecture.md §5.2 / §5.3), checked
// against the real agora: get_messages paging, resend-safe send_message, list_rooms, list_room_users,
// get_status and the file-mode behaviours the API does not have on its own.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CloudApiClient } from '../../src/cloud/index.js';
import type { ApiMessage } from '../../src/cloud/types.js';
import { createMcpClient, withEnv, type McpTestClient } from './harness/mcp.js';
import { AgoraProxy } from './harness/proxy.js';

const agoraUrl = process.env.AGENT_COMM_API_URL!;
const token = process.env.AGENT_COMM_TOKEN!;

interface ToolMessage {
  id: string;
  agentName: string;
  roomName: string;
  message: string;
  timestamp: string;
  mentions: string[];
  metadata?: Record<string, unknown>;
}

describe('tool outputs in cloud mode', () => {
  let client: McpTestClient;
  const api = new CloudApiClient({ apiUrl: agoraUrl, token });

  beforeEach(async () => {
    client = await createMcpClient();
  });

  afterEach(async () => {
    await client.close();
  });

  /** Every message of the room, newest first, straight from the API (the order get_messages must reproduce). */
  async function allNewestFirst(roomName: string): Promise<ApiMessage[]> {
    const ascending: ApiMessage[] = [];
    let since = 0;
    for (;;) {
      const page = await api.getMessages(roomName, { since, limit: 1000 });
      ascending.push(...page.messages);
      if (!page.hasMore || page.messages.length === 0) break;
      since = page.nextCursor;
    }
    return ascending.reverse();
  }

  it('get_messages reproduces offset / limit (newest first) across more than one API page', async () => {
    await client.call('create_room', { roomName: 'paging' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'paging' });
    await client.call('enter_room', { agentName: 'bob', roomName: 'paging' });
    const total = 1210;
    for (let i = 0; i < total; i += 55) {
      await Promise.all(
        Array.from({ length: Math.min(55, total - i) }, (_, j) => {
          const n = i + j;
          const agentName = n % 2 === 0 ? 'alice' : 'bob';
          return api.sendMessage('paging', {
            agentName,
            message: n % 7 === 0 ? `message ${n} for @bob` : `message ${n}`,
            clientMessageId: `paging-${n}`,
          });
        }),
      );
    }
    const expected = await allNewestFirst('paging');
    expect(expected).toHaveLength(total);

    const cases = [
      { limit: 50, offset: 0 },
      { limit: 5, offset: 5 },
      { limit: 1000, offset: 0 },
      { limit: 300, offset: 950 },
      { limit: 100, offset: 1150 },
      { limit: 20, offset: 1205 },
      { limit: 10, offset: 1300 },
    ];
    for (const { limit, offset } of cases) {
      const result = await client.call('get_messages', { agentName: 'alice', roomName: 'paging', limit, offset });
      const slice = expected.slice(offset, offset + limit);
      expect(result.roomName).toBe('paging');
      expect(result.messages.map((m: ToolMessage) => m.id)).toEqual(slice.map((m) => m.id));
      expect(result.count).toBe(slice.length);
      expect(result.hasMore).toBe(offset + limit < total);
    }

    // Default limit (20), no agent.
    const defaults = await client.call('get_messages', { roomName: 'paging' });
    expect(defaults.messages.map((m: ToolMessage) => m.id)).toEqual(expected.slice(0, 20).map((m) => m.id));
    expect(defaults.hasMore).toBe(true);

    // mentionsOnly filters by the requesting agent before paging.
    const mentioned = expected.filter((m) => m.mentions.includes('bob'));
    const page = await client.call('get_messages', { agentName: 'bob', roomName: 'paging', mentionsOnly: true, limit: 40, offset: 150 });
    expect(page.messages.map((m: ToolMessage) => m.id)).toEqual(mentioned.slice(150, 190).map((m) => m.id));
    expect(page.hasMore).toBe(190 < mentioned.length);
    expect(page.messages.every((m: ToolMessage) => m.mentions.includes('bob'))).toBe(true);
  }, 120000);

  it('send_message takes a message of up to 10000 code points, like agora', async () => {
    await client.call('create_room', { roomName: 'long-message' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'long-message' });
    const emoji = String.fromCodePoint(0x1f600);
    // 10000 code points are 20000 UTF-16 code units
    const longest = emoji.repeat(10000);
    expect(await client.call('send_message', { agentName: 'alice', roomName: 'long-message', message: longest })).toMatchObject({ success: true });
    const result = await client.call('get_messages', { agentName: 'alice', roomName: 'long-message' });
    expect(result.messages.map((m: ToolMessage) => m.message)).toEqual([longest]);

    await expect(
      client.call('send_message', { agentName: 'alice', roomName: 'long-message', message: emoji.repeat(10001) }),
    ).rejects.toThrow('Message cannot exceed 10000 characters');
    expect((await api.getMessages('long-message', {})).messages).toHaveLength(1);
  });

  it('get_messages returns the file-mode message shape', async () => {
    await client.call('create_room', { roomName: 'shape' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'shape' });
    const sent = await client.call('send_message', { agentName: 'alice', roomName: 'shape', message: 'hi @bob and @carol' });
    expect(Object.keys(sent)).toEqual(['success', 'messageId', 'timestamp', 'roomName', 'mentions']);
    expect(sent).toMatchObject({ success: true, roomName: 'shape', mentions: ['bob', 'carol'] });

    const result = await client.call('get_messages', { agentName: 'alice', roomName: 'shape' });
    expect(Object.keys(result)).toEqual(['roomName', 'messages', 'count', 'hasMore']);
    expect(result.messages).toEqual([
      {
        id: sent.messageId,
        agentName: 'alice',
        roomName: 'shape',
        message: 'hi @bob and @carol',
        timestamp: sent.timestamp,
        mentions: ['bob', 'carol'],
      },
    ]);
  });

  it('list_rooms returns the file-mode items with zero counts, sorted by name, plus total', async () => {
    await client.call('create_room', { roomName: 'zeta', description: 'last' });
    await client.call('create_room', { roomName: 'alpha' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'zeta' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'alpha' });
    await api.sendMessage('zeta', { agentName: 'alice', message: 'x', clientMessageId: 'zeta-1' });

    const result = await client.call('list_rooms');
    expect(result.total).toBe(2);
    expect(result.rooms.map((room: { name: string }) => room.name)).toEqual(['alpha', 'zeta']);
    expect(result.rooms[0]).toEqual({ name: 'alpha', createdAt: expect.any(String), messageCount: 0, userCount: 0 });
    expect(result.rooms[1]).toEqual({ name: 'zeta', description: 'last', createdAt: expect.any(String), messageCount: 0, userCount: 0 });
    expect(Number.isNaN(Date.parse(result.rooms[1].createdAt))).toBe(false);
  });

  it('list_room_users maps members to name / status / messageCount / profile, offline members included', async () => {
    await client.call('create_room', { roomName: 'people' });
    await client.call('enter_room', { agentName: 'zoe', roomName: 'people' });
    await client.call('enter_room', {
      agentName: 'adam',
      roomName: 'people',
      profile: { role: 'reviewer', capabilities: ['review'] },
    });
    await client.call('leave_room', { agentName: 'zoe', roomName: 'people' });

    const result = await client.call('list_room_users', { roomName: 'people' });
    expect(result).toEqual({
      roomName: 'people',
      users: [
        { name: 'adam', status: 'online', messageCount: 0, profile: { role: 'reviewer', capabilities: ['review'] } },
        { name: 'zoe', status: 'offline', messageCount: 0 },
      ],
      onlineCount: 1,
    });
  });

  it('get_status counts unique online agents across rooms and ignores roomName like the file mode', async () => {
    await client.call('create_room', { roomName: 'status-a' });
    await client.call('create_room', { roomName: 'status-b' });
    await client.call('create_room', { roomName: 'status-empty' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'status-a' });
    await client.call('enter_room', { agentName: 'bob', roomName: 'status-a' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'status-b' });
    await client.call('enter_room', { agentName: 'carol', roomName: 'status-b' });
    await client.call('send_message', { agentName: 'alice', roomName: 'status-a', message: 'one' });
    await client.call('send_message', { agentName: 'carol', roomName: 'status-b', message: 'two' });
    await client.call('send_message', { agentName: 'carol', roomName: 'status-b', message: 'three' });

    const status = await client.call('get_status', { roomName: 'status-a' });
    expect(Object.keys(status)).toEqual(['rooms', 'totalRooms', 'totalOnlineUsers', 'totalMessages']);
    expect(status.totalRooms).toBe(3);
    expect(status.totalMessages).toBe(3);
    expect(status.totalOnlineUsers).toBe(3); // alice, bob, carol (alice is in two rooms)
    const byName = Object.fromEntries(status.rooms.map((room: { name: string }) => [room.name, room]));
    expect(byName['status-a']).toEqual({ name: 'status-a', onlineUsers: 2, totalMessages: 1, storageSize: expect.any(Number) });
    expect(byName['status-b']).toMatchObject({ onlineUsers: 2, totalMessages: 2 });
    expect(byName['status-empty']).toMatchObject({ onlineUsers: 0, totalMessages: 0 });
  });

  it('keeps the file-mode leave / read behaviour for members that already left', async () => {
    await client.call('create_room', { roomName: 'left' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'left' });
    await client.call('send_message', { agentName: 'alice', roomName: 'left', message: 'before leaving' });
    expect(await client.call('leave_room', { agentName: 'alice', roomName: 'left' })).toEqual({ success: true });
    // PresenceService.leaveRoom only needs the member row, so leaving again succeeds.
    expect(await client.call('leave_room', { agentName: 'alice', roomName: 'left' })).toEqual({ success: true });
    // MessagingAdapter.getMessages checks the member row, not the online status.
    const messages = await client.call('get_messages', { agentName: 'alice', roomName: 'left' });
    expect(messages.messages.map((m: ToolMessage) => m.message)).toEqual(['before leaving']);
    // Re-entering is idempotent.
    expect(await client.call('enter_room', { agentName: 'alice', roomName: 'left' })).toEqual({ success: true });
    expect(await client.call('enter_room', { agentName: 'alice', roomName: 'left' })).toEqual({ success: true });
  });

  it('validates inputs the tool schemas let through with the file-mode messages, after the room check', async () => {
    await client.call('create_room', { roomName: 'validation' });
    await expect(client.call('enter_room', { agentName: 'bad name', roomName: 'validation' })).rejects.toThrow(
      "Validation failed for field 'agentName': Agent name can only contain alphanumeric characters, hyphens, and underscores",
    );
    await expect(client.call('enter_room', { agentName: 'bad name', roomName: 'no-such-room' })).rejects.toThrow(
      "Room 'no-such-room' not found",
    );
    await expect(
      client.call('enter_room', { agentName: 'alice', roomName: 'validation', profile: { role: 'r'.repeat(51) } }),
    ).rejects.toThrow("Validation failed for field 'profile.role': Profile role cannot exceed 50 characters");
    await expect(client.call('send_message', { agentName: 'bad name', roomName: 'validation', message: 'x' })).rejects.toThrow(
      "Agent 'bad name' is not in room 'validation'",
    );
    await client.call('enter_room', { agentName: 'alice', roomName: 'validation' });
    // wait_for_messages has no tool schema: the timeout is checked like MessageValidator does (1 s .. 300 s, or 0).
    await expect(client.call('wait_for_messages', { agentName: 'alice', roomName: 'validation', timeout: 500 })).rejects.toThrow(
      /Validation failed for field 'timeout'/,
    );
    await expect(client.call('wait_for_messages', { agentName: 'ghost', roomName: 'validation', timeout: 500 })).rejects.toThrow(
      "Agent 'ghost' is not in room 'validation'",
    );
  });
});

describe('send_message is safe to resend', () => {
  let proxy: AgoraProxy;
  let client: McpTestClient;
  const api = new CloudApiClient({ apiUrl: agoraUrl, token });

  beforeAll(async () => {
    proxy = await AgoraProxy.start(agoraUrl);
  });

  afterAll(async () => {
    await proxy.close();
  });

  beforeEach(async () => {
    client = await withEnv({ AGENT_COMM_API_URL: proxy.url, AGENT_COMM_TOKEN: token }, () => createMcpClient());
  });

  afterEach(async () => {
    await client.close();
  });

  it('stores one message when the response to the first POST is lost', async () => {
    await client.call('create_room', { roomName: 'resend' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'resend' });

    proxy.requests.length = 0;
    proxy.dropResponseOnce((request) => request.method === 'POST' && request.path === '/rooms/resend/messages');
    const sent = await client.call('send_message', { agentName: 'alice', roomName: 'resend', message: 'exactly once' });

    expect(proxy.countRequests('POST', '/rooms/resend/messages')).toBe(2);
    const stored = await api.getMessages('resend', { since: 0 });
    expect(stored.messages).toHaveLength(1);
    expect(stored.messages[0]!.id).toBe(sent.messageId);
    expect(stored.messages[0]!.clientMessageId).toEqual(expect.any(String));
  });

  it('creates the room once when the response to POST /rooms is lost', async () => {
    proxy.dropResponseOnce((request) => request.method === 'POST' && request.path === '/rooms');
    expect(await client.call('create_room', { roomName: 'created-once' })).toEqual({ success: true, roomName: 'created-once' });
    expect((await api.listRooms()).map((room) => room.name)).toEqual(['created-once']);
  });
});
