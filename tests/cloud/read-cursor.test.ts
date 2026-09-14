// Where wait_for_messages starts reading (the client-side read cursor, src/cloud/CloudWaitService.ts).
// The cursor is taken before the agent's first send (agora before api 0.4.2 moved an agent's read position when it
// sent): from the join response, or from the member list in a process that did not enter the room. Both responses
// carry the room's epoch (api 0.5.1), so the cursor is tied to the room it was taken in and a room deleted and created
// again under the same name is never read from an old position, without any request just for the epoch.
// Runs against the agora with FAULT_INJECTION=1 (to make single reads fail) through a proxy that records requests.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { CloudApiClient, CloudBackend } from '../../src/cloud/index.js';
import { issueToken } from './harness/agora.js';
import { createMcpClient, withEnv, type McpTestClient } from './harness/mcp.js';
import { AgoraProxy, type RecordedRequest } from './harness/proxy.js';

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

  /** The requests `action` makes, as "METHOD path" (clientMessageId and operationId values left out). */
  async function requestsOf(action: () => Promise<unknown>): Promise<string[]> {
    proxy.requests.length = 0;
    await action();
    return proxy.requests.map((r: RecordedRequest) => `${r.method} ${r.path}`);
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

  it('takes the read position and its epoch from the join response: entering and sending are one request each', async () => {
    const roomName = 'cursor-requests-join';
    await client.call('create_room', { roomName });
    const alice = anotherProcess();

    expect(await requestsOf(() => alice.rooms.enterRoom({ agentName: 'alice', roomName }))).toEqual([`POST /rooms/${roomName}/join`]);
    await client.call('enter_room', { agentName: 'bob', roomName });
    await client.call('send_message', { agentName: 'bob', roomName, message: 'before alice spoke' });
    expect(await requestsOf(() => alice.messaging.sendMessage({ agentName: 'alice', roomName, message: 'alice speaks' }))).toEqual([
      `POST /rooms/${roomName}/messages`,
    ]);

    // The WebSocket starts from the join's position (0): no request besides the upgrade, and bob's message comes back.
    let result: Awaited<ReturnType<CloudBackend['messaging']['waitForMessages']>> | undefined;
    const requests = await requestsOf(async () => {
      result = await alice.messaging.waitForMessages({ agentName: 'alice', roomName, timeout: 3000 });
    });
    expect(requests).toEqual([`UPGRADE /rooms/${roomName}/ws?agentName=alice&since=0`]);
    expect(result!.messages.map((m) => m.message)).toEqual(['before alice spoke']);
  });

  it('takes the read position and its epoch with one GET /members before the first send of a process that did not enter', async () => {
    const roomName = 'cursor-requests-members';
    await client.call('create_room', { roomName });
    await client.call('enter_room', { agentName: 'alice', roomName });
    await client.call('enter_room', { agentName: 'bob', roomName });
    await client.call('send_message', { agentName: 'bob', roomName, message: 'before alice spoke' });

    const other = anotherProcess();
    expect(await requestsOf(() => other.messaging.sendMessage({ agentName: 'alice', roomName, message: 'alice speaks' }))).toEqual([
      `GET /rooms/${roomName}/members?includeOffline=true`,
      `POST /rooms/${roomName}/messages`,
    ]);
    expect(await requestsOf(() => other.messaging.sendMessage({ agentName: 'alice', roomName, message: 'again' }))).toEqual([
      `POST /rooms/${roomName}/messages`,
    ]);
    const result = await other.messaging.waitForMessages({ agentName: 'alice', roomName, timeout: 3000 });
    expect(result.messages.map((m) => m.message)).toEqual(['before alice spoke']);
  });

  it('checks the epoch of a long poll with the same GET /members that gives the read position', async () => {
    const roomName = 'cursor-requests-long-poll';
    proxy.webSocketPolicy = 'reject';
    await client.call('create_room', { roomName });
    await client.call('enter_room', { agentName: 'bob', roomName });
    const alice = anotherProcess();
    await alice.rooms.enterRoom({ agentName: 'alice', roomName });
    // HTTP requests only (the refused upgrade is left out), with the long poll's `wait` seconds left out (timing).
    const httpOnly = (requests: string[]) => requests.filter((r) => !r.startsWith('UPGRADE')).map((r) => r.replace(/&wait=\d+/, ''));
    const longPoll = (since: number) =>
      `GET /rooms/${roomName}/messages?agentName=alice&since=${since}&limit=1000&excludeSelf=true&markRead=true`;

    // A process with a cursor: one GET /members (its epoch confirms the cursor), then the long poll.
    await api.sendMessage(roomName, { agentName: 'bob', message: 'one', clientMessageId: `${roomName}-one` });
    let result = await alice.messaging.waitForMessages({ agentName: 'alice', roomName, timeout: 3000 });
    expect(result.messages.map((m) => m.message)).toEqual(['one']);
    await api.sendMessage(roomName, { agentName: 'bob', message: 'two', clientMessageId: `${roomName}-two` });
    expect(
      httpOnly(await requestsOf(async () => {
        result = await alice.messaging.waitForMessages({ agentName: 'alice', roomName, timeout: 3000 });
      })),
    ).toEqual([`GET /rooms/${roomName}/members?includeOffline=true`, longPoll(1)]);
    expect(result.messages.map((m) => m.message)).toEqual(['two']);

    // A process without a cursor: the same single GET /members gives the position.
    await api.sendMessage(roomName, { agentName: 'bob', message: 'three', clientMessageId: `${roomName}-three` });
    const other = anotherProcess();
    expect(
      httpOnly(await requestsOf(async () => {
        result = await other.messaging.waitForMessages({ agentName: 'alice', roomName, timeout: 3000 });
      })),
    ).toEqual([`GET /rooms/${roomName}/members?includeOffline=true`, longPoll(2)]);
    expect(result.messages.map((m) => m.message)).toEqual(['three']);

    // The room is deleted and created again: the GET /members that reveals the new epoch also gives the position there.
    await api.deleteRoom(roomName);
    await api.createRoom(roomName);
    await api.joinRoom(roomName, 'alice');
    await api.joinRoom(roomName, 'bob');
    await api.sendMessage(roomName, { agentName: 'bob', message: 'new room', clientMessageId: `${roomName}-new` });
    expect(
      httpOnly(await requestsOf(async () => {
        result = await alice.messaging.waitForMessages({ agentName: 'alice', roomName, timeout: 3000 });
      })),
    ).toEqual([`GET /rooms/${roomName}/members?includeOffline=true`, longPoll(0)]);
    expect(result.messages.map((m) => m.message)).toEqual(['new room']);
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
