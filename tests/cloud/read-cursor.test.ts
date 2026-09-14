// Where wait_for_messages starts reading (the client-side read cursor, src/cloud/CloudWaitService.ts).
// agora moves an agent's read position when the agent sends, so the cursor is taken before the agent's first send
// (from the join response, or from the member list in a process that did not enter the room), and it carries the
// epoch of the room it was taken in so that a room deleted and created again under the same name is never read
// from an old position. Runs against the agora with FAULT_INJECTION=1 (to make single reads fail) through a proxy.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { CloudApiClient, CloudBackend } from '../../src/cloud/index.js';
import { issueToken } from './harness/agora.js';
import { createMcpClient, withEnv, type McpTestClient } from './harness/mcp.js';
import { AgoraProxy } from './harness/proxy.js';

describe('the read cursor of wait_for_messages', () => {
  const faultAgoraUrl = inject('faultAgoraUrl');
  let token: string;
  let proxy: AgoraProxy;
  let api: CloudApiClient;
  let client: McpTestClient;
  const backends: CloudBackend[] = [];

  /** Another MCP server process for the same token: it has no read cursors of its own. */
  function anotherProcess(): CloudBackend {
    const backend = new CloudBackend({ apiUrl: proxy.url, token });
    backends.push(backend);
    return backend;
  }

  beforeAll(async () => {
    token = await issueToken(faultAgoraUrl, 'read cursor');
    proxy = await AgoraProxy.start(faultAgoraUrl);
    api = new CloudApiClient({ apiUrl: faultAgoraUrl, token });
  });

  afterAll(async () => {
    await proxy.close();
  });

  beforeEach(async () => {
    proxy.reset();
    client = await withEnv({ AGENT_COMM_API_URL: proxy.url, AGENT_COMM_TOKEN: token }, () => createMcpClient());
  });

  afterEach(async () => {
    for (const backend of backends.splice(0)) await backend.close();
    await client.close();
  });

  async function readPosition(roomName: string, agentName: string): Promise<number | undefined> {
    return (await api.listMembers(roomName)).members.find((m) => m.agentName === agentName)?.lastReadSeq;
  }

  it('does not send when the read position cannot be read first, so the unread message stays unread', async () => {
    const roomName = 'cursor-unreadable';
    await client.call('create_room', { roomName });
    await client.call('enter_room', { agentName: 'alice', roomName });
    await client.call('enter_room', { agentName: 'bob', roomName });
    await client.call('send_message', { agentName: 'bob', roomName, message: 'still unread' });

    const other = anotherProcess();
    proxy.headersFor = (r) =>
      r.method === 'GET' && r.path.startsWith(`/rooms/${roomName}/members`) ? { 'x-agora-fault': 'room.internal' } : undefined;
    await expect(other.messaging.sendMessage({ agentName: 'alice', roomName, message: 'too early' })).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    // Nothing was sent, so agora did not move alice's read position past bob's message.
    expect(proxy.countRequests('POST', `/rooms/${roomName}/messages`)).toBe(1);
    expect((await api.getMessages(roomName, { since: 0 })).messages.map((m) => m.message)).toEqual(['still unread']);
    expect(await readPosition(roomName, 'alice')).toBe(0);

    proxy.headersFor = () => undefined;
    await other.messaging.sendMessage({ agentName: 'alice', roomName, message: 'now it can' });
    const result = await other.messaging.waitForMessages({ agentName: 'alice', roomName, timeout: 3000 });
    expect(result.messages.map((m) => m.message)).toEqual(['still unread']);
  });

  it('enters the room when the epoch cannot be read, and the first send then reads the read position itself', async () => {
    const roomName = 'cursor-no-epoch';
    await client.call('create_room', { roomName });
    await client.call('enter_room', { agentName: 'bob', roomName });

    const other = anotherProcess();
    proxy.headersFor = (r) =>
      r.method === 'GET' && r.path === `/rooms/${roomName}/messages?limit=1` ? { 'x-agora-fault': 'room.unavailable' } : undefined;
    expect(await other.rooms.enterRoom({ agentName: 'alice', roomName })).toEqual({ success: true });
    proxy.headersFor = () => undefined;

    await client.call('send_message', { agentName: 'bob', roomName, message: 'hello alice' });
    const membersBefore = proxy.countRequests('GET', `/rooms/${roomName}/members`);
    await other.messaging.sendMessage({ agentName: 'alice', roomName, message: 'hi bob' });
    expect(proxy.countRequests('GET', `/rooms/${roomName}/members`)).toBe(membersBefore + 1);

    const result = await other.messaging.waitForMessages({ agentName: 'alice', roomName, timeout: 3000 });
    expect(result.messages.map((m) => m.message)).toEqual(['hello alice']);
  });

  /** alice enters `roomName` after 5 messages; the room is then deleted and created again, and in the new room
   * alice enters from another process and bob sends 3 messages. Returns the process that entered first. */
  async function enterThenRoomRecreated(roomName: string): Promise<CloudBackend> {
    await client.call('create_room', { roomName });
    await client.call('enter_room', { agentName: 'bob', roomName });
    for (let i = 1; i <= 5; i++) await client.call('send_message', { agentName: 'bob', roomName, message: `old ${i}` });
    const first = anotherProcess();
    await first.rooms.enterRoom({ agentName: 'alice', roomName });
    expect(await readPosition(roomName, 'alice')).toBe(5);

    await api.deleteRoom(roomName);
    await api.createRoom(roomName);
    await anotherProcess().rooms.enterRoom({ agentName: 'alice', roomName });
    await api.joinRoom(roomName, 'bob');
    for (let i = 1; i <= 3; i++) {
      await api.sendMessage(roomName, { agentName: 'bob', message: `new ${i}`, clientMessageId: `${roomName}-new-${i}` });
    }
    return first;
  }

  it('does not read a room created again from the position alice had in the old room (WebSocket)', async () => {
    const first = await enterThenRoomRecreated('cursor-reborn-ws');
    const result = await first.messaging.waitForMessages({ agentName: 'alice', roomName: 'cursor-reborn-ws', timeout: 3000 });
    expect(result.messages.map((m) => m.message)).toEqual(['new 1', 'new 2', 'new 3']);
    expect(first.waits.stats.longPollRequests).toBe(0);
  });

  it('does not read a room created again from the position alice had in the old room (long polling)', async () => {
    const first = await enterThenRoomRecreated('cursor-reborn-lp');
    proxy.webSocketPolicy = 'reject';
    const started = Date.now();
    const result = await first.messaging.waitForMessages({ agentName: 'alice', roomName: 'cursor-reborn-lp', timeout: 3000 });
    expect(result.messages.map((m) => m.message)).toEqual(['new 1', 'new 2', 'new 3']);
    // The epoch is checked before the first long poll, which therefore does not wait out the timeout on seqs of the
    // old room.
    expect(Date.now() - started).toBeLessThan(1500);
    expect(first.waits.stats.longPollRequests).toBeGreaterThan(0);
  });
});
