// Long polling (GET /rooms/{roomName}/messages?wait=) is only a fallback for when the WebSocket cannot be
// established (D6). The proxy in front of the real agora refuses WebSocket upgrades; HTTP still reaches agora.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CloudApiClient, CloudBackend, getCloudBackend } from '../../src/cloud/index.js';
import { createMcpClient, McpCallError, sleep, waitUntil, withEnv, type McpTestClient } from './harness/mcp.js';
import { AgoraProxy, type RecordedRequest } from './harness/proxy.js';

const agoraUrl = process.env.AGENT_COMM_API_URL!;
const token = process.env.AGENT_COMM_TOKEN!;

interface WaitResult {
  messages: Array<{ agentName: string; message: string }>;
  hasNewMessages: boolean;
  timedOut: boolean;
  warning?: string;
  waitingAgents?: string[];
}

function queryOf(path: string): URLSearchParams {
  return new URL(path, 'http://proxy').searchParams;
}

/** MessageService.waitForMessages (file mode) for one other waiting agent. */
const FILE_MODE_DEADLOCK_WARNING = 'Potential deadlock detected: 1 other agent(s) are also waiting for messages';

describe('wait_for_messages falls back to long polling', () => {
  let proxy: AgoraProxy;
  let client: McpTestClient;
  let api: CloudApiClient;
  const env = () => ({ AGENT_COMM_API_URL: proxy.url, AGENT_COMM_TOKEN: token });
  const longPolls = () =>
    proxy.requests.filter((r) => r.method === 'GET' && /\/messages\?/.test(r.path) && /[?&]wait=\d+/.test(r.path));

  beforeAll(async () => {
    proxy = await AgoraProxy.start(agoraUrl);
    api = new CloudApiClient({ apiUrl: agoraUrl, token });
  });

  afterAll(async () => {
    await proxy.close();
  });

  beforeEach(async () => {
    proxy.reset();
    proxy.webSocketPolicy = 'reject';
    client = await withEnv(env(), () => createMcpClient());
  });

  afterEach(async () => {
    await client.close();
  });

  async function setupRoom(roomName: string, agents: string[]): Promise<void> {
    await client.call('create_room', { roomName });
    for (const agentName of agents) await client.call('enter_room', { agentName, roomName });
  }

  it('returns unread messages immediately when the WebSocket upgrade is refused', async () => {
    await setupRoom('fallback-now', ['alice', 'bob']);
    await client.call('send_message', { agentName: 'bob', roomName: 'fallback-now', message: 'already here' });

    const started = Date.now();
    const result = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'fallback-now', timeout: 5 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.messages.map((m) => m.message)).toEqual(['already here']);
    expect(result).toMatchObject({ hasNewMessages: true, timedOut: false });

    expect(proxy.requests.some((r) => r.method === 'UPGRADE')).toBe(true);
    expect(longPolls().length).toBeGreaterThanOrEqual(1);
    const stats = getCloudBackend(env())!.waits.stats;
    expect(stats.webSocketFallbacks).toBeGreaterThanOrEqual(1);
    expect((await api.listMembers('fallback-now')).members.find((m) => m.agentName === 'alice')!.connected).toBe(false);
  });

  it('waits for a new message, then times out, with the same results as the WebSocket path', async () => {
    await setupRoom('fallback-wait', ['alice', 'bob']);

    setTimeout(() => void client.call('send_message', { agentName: 'bob', roomName: 'fallback-wait', message: 'new one' }), 500);
    let started = Date.now();
    const released = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'fallback-wait', timeout: 5 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(Date.now() - started).toBeLessThan(2500);
    expect(released.messages.map((m) => m.message)).toEqual(['new one']);

    started = Date.now();
    const timedOut = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'fallback-wait', timeout: 2 });
    const elapsed = Date.now() - started;
    expect(timedOut).toEqual({ messages: [], hasNewMessages: false, timedOut: true });
    expect(elapsed).toBeGreaterThanOrEqual(2000);
    expect(elapsed).toBeLessThan(3500);
    // The long poll declared the wait and persisted the read position (markRead).
    expect(longPolls().every((r) => r.path.includes('agentName=alice'))).toBe(true);
  });

  it('keeps the client read cursor so replying does not hide earlier messages', async () => {
    await setupRoom('fallback-cursor', ['alice', 'bob']);
    await client.call('send_message', { agentName: 'bob', roomName: 'fallback-cursor', message: 'question 1' });
    const first = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'fallback-cursor', timeout: 3 });
    expect(first.messages.map((m) => m.message)).toEqual(['question 1']);

    await client.call('send_message', { agentName: 'bob', roomName: 'fallback-cursor', message: 'question 2' });
    await client.call('send_message', { agentName: 'alice', roomName: 'fallback-cursor', message: 'answer 1' });
    const second = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'fallback-cursor', timeout: 3 });
    expect(second.messages.map((m) => m.message)).toEqual(['question 2']);

    const third = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'fallback-cursor', timeout: 1 });
    expect(third.messages).toEqual([]);
    expect(longPolls().some((r) => /[?&]since=\d+/.test(r.path))).toBe(true);
  });

  it('reports the other waiting agents from the long-poll response', async () => {
    await setupRoom('fallback-warning', ['alice', 'bob']);
    // alice waits over a working WebSocket (direct to agora); bob can only long poll through the proxy.
    const direct = new CloudBackend({ apiUrl: agoraUrl, token });
    try {
      const alice = direct.messaging.waitForMessages({ agentName: 'alice', roomName: 'fallback-warning', timeout: 6000 });
      await waitUntil(
        async () => (await api.listMembers('fallback-warning')).members.find((m) => m.agentName === 'alice')!.waiting === true,
        5000,
        'alice waiting',
      );
      const bob = await client.call<WaitResult>('wait_for_messages', { agentName: 'bob', roomName: 'fallback-warning', timeout: 1 });
      expect(bob.timedOut).toBe(true);
      expect(bob.waitingAgents).toEqual(['alice']);
      // The file-mode text (MessageService.waitForMessages), not agora's `warning` of the long-poll response.
      expect(bob.warning).toBe(FILE_MODE_DEADLOCK_WARNING);

      await client.call('send_message', { agentName: 'bob', roomName: 'fallback-warning', message: 'done' });
      expect((await alice).messages.map((m) => m.message)).toEqual(['done']);
    } finally {
      await direct.close();
    }
  });

  it('starts from the member read position when the room was deleted and created again', async () => {
    await setupRoom('fallback-reborn', ['alice', 'bob']);
    for (let i = 0; i < 3; i++) await client.call('send_message', { agentName: 'bob', roomName: 'fallback-reborn', message: `old ${i}` });
    expect((await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'fallback-reborn', timeout: 2 })).messages).toHaveLength(3);

    await api.deleteRoom('fallback-reborn');
    await setupRoom('fallback-reborn', ['alice', 'bob']);
    await client.call('send_message', { agentName: 'bob', roomName: 'fallback-reborn', message: 'new room' });

    // The old cursor (seq 3) must neither hold the long poll nor mark the new room's seq 1 as read.
    const started = Date.now();
    const result = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'fallback-reborn', timeout: 5 });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.messages.map((m) => m.message)).toEqual(['new room']);
  });

  it('also falls back when the connection is dropped during the upgrade', async () => {
    proxy.webSocketPolicy = 'destroy';
    await setupRoom('fallback-destroy', ['alice', 'bob']);
    await client.call('send_message', { agentName: 'bob', roomName: 'fallback-destroy', message: 'hello' });
    const result = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'fallback-destroy', timeout: 3 });
    expect(result.messages.map((m) => m.message)).toEqual(['hello']);
    expect(longPolls().length).toBeGreaterThanOrEqual(1);
  });

  it('goes back to the WebSocket once it can be established again', async () => {
    await setupRoom('fallback-recover', ['alice', 'bob']);
    const backend = new CloudBackend({ apiUrl: proxy.url, token }, { wait: { webSocketRetryCooldownMs: 300 } });
    try {
      await backend.messaging.waitForMessages({ agentName: 'alice', roomName: 'fallback-recover', timeout: 1000 });
      expect(backend.waits.stats.webSocketFallbacks).toBe(1);
      expect(backend.waits.hasOpenSocket('fallback-recover', 'alice')).toBe(false);

      proxy.webSocketPolicy = 'pass';
      await new Promise((resolve) => setTimeout(resolve, 400));
      const pollsBefore = backend.waits.stats.longPollRequests;
      setTimeout(() => void backend.messaging.sendMessage({ agentName: 'bob', roomName: 'fallback-recover', message: 'over ws' }), 300);
      const result = await backend.messaging.waitForMessages({ agentName: 'alice', roomName: 'fallback-recover', timeout: 5000 });
      expect(result.messages.map((m) => m.message)).toEqual(['over ws']);
      expect(backend.waits.hasOpenSocket('fallback-recover', 'alice')).toBe(true);
      expect(backend.waits.stats.longPollRequests).toBe(pollsBefore);
    } finally {
      await backend.close();
    }
  });

  it('returns messages sent before the agent first spoke in the room (read position from enter_room)', async () => {
    await setupRoom('fallback-first-reply', ['alice', 'bob']);
    await client.call('send_message', { agentName: 'bob', roomName: 'fallback-first-reply', message: 'hello alice' });
    await client.call('send_message', { agentName: 'alice', roomName: 'fallback-first-reply', message: 'hi bob' });

    const result = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'fallback-first-reply', timeout: 3 });
    expect(result.messages.map((m) => m.message)).toEqual(['hello alice']);
    expect(longPolls().every((r) => queryOf(r.path).get('since') === '0')).toBe(true);
  });

  it('returns the messages when the response to the first long poll is lost', async () => {
    await setupRoom('fallback-lost', ['alice', 'bob']);
    await client.call('send_message', { agentName: 'bob', roomName: 'fallback-lost', message: 'do not lose me' });
    // agora answers (and stores alice's read position), but the answer never reaches the client.
    proxy.dropResponseOnce((r) => r.method === 'GET' && r.path.startsWith('/rooms/fallback-lost/messages?') && /[?&]wait=/.test(r.path));

    const result = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'fallback-lost', timeout: 5 });
    expect(result.messages.map((m) => m.message)).toEqual(['do not lose me']);
    // The request after the lost one asks from the same explicit position instead of the server's moved one.
    const sinces = longPolls().map((r) => queryOf(r.path).get('since'));
    expect(sinces).toEqual(['0', '0']);
    expect((await api.listMembers('fallback-lost')).members.find((m) => m.agentName === 'alice')!.lastReadSeq).toBe(1);
  });

  it('also when the read position comes from the member list (agent entered from another MCP process)', async () => {
    await setupRoom('fallback-lost-other', ['alice', 'bob']);
    await client.call('send_message', { agentName: 'bob', roomName: 'fallback-lost-other', message: 'one' });
    await client.call('send_message', { agentName: 'bob', roomName: 'fallback-lost-other', message: 'two' });
    const other = new CloudBackend({ apiUrl: proxy.url, token });
    try {
      proxy.requests.length = 0;
      proxy.dropResponseOnce(
        (r) => r.method === 'GET' && r.path.startsWith('/rooms/fallback-lost-other/messages?') && /[?&]wait=/.test(r.path),
      );
      const result = await other.messaging.waitForMessages({ agentName: 'alice', roomName: 'fallback-lost-other', timeout: 5000 });
      expect(result.messages.map((m) => m.message)).toEqual(['one', 'two']);
      // The starting position is read without side effects (the room epoch, then the member list) before any request
      // that marks messages read.
      const httpRequests = proxy.requests.filter((r) => r.method !== 'UPGRADE').map((r) => `${r.method} ${r.path}`);
      expect(httpRequests.slice(0, 2)).toEqual([
        'GET /rooms/fallback-lost-other/messages?limit=1',
        'GET /rooms/fallback-lost-other/members?includeOffline=true',
      ]);
      expect(longPolls().map((r) => queryOf(r.path).get('since'))).toEqual(['0', '0']);
    } finally {
      await other.close();
    }
  });

  it('gives up shortly after the timeout when long polls are never answered', async () => {
    await setupRoom('fallback-hang', ['alice']);
    // Only the long polls hang; the side-effect-free epoch check before them is answered.
    proxy.holdRequests((r) => r.method === 'GET' && r.path.startsWith('/rooms/fallback-hang/messages?') && queryOf(r.path).has('wait'));

    const started = Date.now();
    const error = await client
      .call('wait_for_messages', { agentName: 'alice', roomName: 'fallback-hang', timeout: 2 })
      .then(() => undefined, (e: unknown) => e);
    const elapsed = Date.now() - started;
    expect(error).toBeInstanceOf(McpCallError);
    expect((error as McpCallError).message).toMatch(/timed out/);
    // One long poll bounded by its `wait` plus a short grace; nothing is sent after the deadline.
    expect(elapsed).toBeGreaterThanOrEqual(2000);
    expect(elapsed).toBeLessThan(6000);
    expect(longPolls()).toHaveLength(1);
  });

  it('bounds a WebSocket handshake that is never answered by the timeout', async () => {
    proxy.webSocketPolicy = 'hang';
    await setupRoom('fallback-handshake', ['alice', 'bob']);
    await client.call('send_message', { agentName: 'bob', roomName: 'fallback-handshake', message: 'still delivered' });

    const started = Date.now();
    const result = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'fallback-handshake', timeout: 2 });
    const elapsed = Date.now() - started;
    expect(result.messages.map((m) => m.message)).toEqual(['still delivered']);
    // The handshake gets the rest of the wait plus a short grace (not the 10 s connect timeout), then long polling.
    expect(elapsed).toBeLessThan(5000);
    expect(longPolls().length).toBeGreaterThanOrEqual(1);
  });

  it('long polls for at least a second while time is left: one request that declares the wait', async () => {
    const roomName = 'fallback-short';
    await setupRoom(roomName, ['alice', 'bob']);
    const memberOf = async (agentName: string) => (await api.listMembers(roomName)).members.find((m) => m.agentName === agentName)!;
    // bob waits over a working WebSocket (direct to agora); alice runs in a new process that has to fall back.
    const direct = new CloudBackend({ apiUrl: agoraUrl, token });
    const fresh = new CloudBackend({ apiUrl: proxy.url, token });
    try {
      const bob = direct.messaging.waitForMessages({ agentName: 'bob', roomName, timeout: 8000 });
      await waitUntil(async () => (await memberOf('bob')).waiting === true, 5000, 'bob waiting');
      await fresh.rooms.enterRoom({ agentName: 'alice', roomName });
      proxy.requests.length = 0;

      let watching = true;
      let aliceSeenWaiting = false;
      const watcher = (async () => {
        while (watching) {
          if ((await memberOf('alice')).waiting) aliceSeenWaiting = true;
          await sleep(50);
        }
      })();
      const started = Date.now();
      const alice = await fresh.messaging.waitForMessages({ agentName: 'alice', roomName, timeout: 1000 });
      const elapsed = Date.now() - started;
      watching = false;
      await watcher;

      // The WebSocket attempt leaves less than a second: still one long poll with wait=1, not a loop of wait=0.
      expect(longPolls().map((r) => queryOf(r.path).get('wait'))).toEqual(['1']);
      expect(elapsed).toBeLessThan(2500);
      expect(aliceSeenWaiting).toBe(true);
      expect(alice).toEqual({
        messages: [],
        hasNewMessages: false,
        timedOut: true,
        warning: FILE_MODE_DEADLOCK_WARNING,
        waitingAgents: ['bob'],
      });

      await client.call('send_message', { agentName: 'alice', roomName, message: 'done' });
      expect((await bob).messages.map((m) => m.message)).toEqual(['done']);
    } finally {
      await direct.close();
      await fresh.close();
    }
  });

  it('returns the unread messages it has when the next page does not come, and the rest with the next call', async () => {
    const roomName = 'fallback-pages';
    await setupRoom(roomName, ['alice', 'bob']);
    const total = 1010;
    for (let i = 0; i < total; i += 50) {
      await Promise.all(
        Array.from({ length: Math.min(50, total - i) }, (_, j) =>
          api.sendMessage(roomName, { agentName: 'bob', message: `m${i + j}`, clientMessageId: `pages-${i + j}` }),
        ),
      );
    }
    const firstPage = await api.getMessages(roomName, { since: 0, limit: 1000 });
    const secondPage = await api.getMessages(roomName, { since: firstPage.nextCursor, limit: 1000 });
    const inOrder = [...firstPage.messages, ...secondPage.messages].map((m) => m.id);
    expect(inOrder).toHaveLength(total);

    // The long poll answers the first 1000; the request for the rest is never answered.
    const restRequest = (r: RecordedRequest): boolean =>
      r.method === 'GET' &&
      r.path.startsWith(`/rooms/${roomName}/messages?`) &&
      !queryOf(r.path).has('wait') &&
      queryOf(r.path).get('since') === String(firstPage.nextCursor);
    proxy.holdRequests(restRequest);

    const started = Date.now();
    const first = await client.call<WaitResult & { messages: Array<{ id: string }> }>('wait_for_messages', {
      agentName: 'alice',
      roomName,
      timeout: 2,
    });
    const elapsed = Date.now() - started;
    expect(first.messages.map((m) => m.id)).toEqual(inOrder.slice(0, 1000));
    expect(first).toMatchObject({ hasNewMessages: true, timedOut: false });
    // One request for the rest, bounded like any round trip of the wait, and not resent.
    expect(proxy.requests.filter(restRequest)).toHaveLength(1);
    expect(elapsed).toBeLessThan(6000);

    proxy.holdRequests(undefined);
    const rest = await client.call<WaitResult & { messages: Array<{ id: string }> }>('wait_for_messages', {
      agentName: 'alice',
      roomName,
      timeout: 2,
    });
    expect(rest.messages.map((m) => m.id)).toEqual(inOrder.slice(1000));
  }, 60000);

  it('keeps the messages of a room created again between the epoch check and the long poll', async () => {
    const roomName = 'fallback-epoch-race';
    await setupRoom(roomName, ['alice', 'bob']);
    await client.call('send_message', { agentName: 'bob', roomName, message: 'old' });
    const old = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName, timeout: 3 });
    expect(old.messages.map((m) => m.message)).toEqual(['old']);

    // The next wait checks the epoch first; agora answers at once, but the answer reaches the client a second later.
    const epochCheck = (r: RecordedRequest): boolean => r.method === 'GET' && r.path === `/rooms/${roomName}/messages?limit=1`;
    proxy.delayResponses(epochCheck, 1000);
    const checksBefore = proxy.requests.filter(epochCheck).length;
    const waiting = client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName, timeout: 5 });
    await waitUntil(() => proxy.requests.filter(epochCheck).length > checksBefore, 5000, 'epoch check sent');

    // Meanwhile the room is deleted and created again, alice enters it from another process and bob sends twice.
    await api.deleteRoom(roomName);
    await api.createRoom(roomName);
    await api.joinRoom(roomName, 'alice');
    await api.joinRoom(roomName, 'bob');
    await api.sendMessage(roomName, { agentName: 'bob', message: 'new 1', clientMessageId: 'epoch-race-1' });
    await api.sendMessage(roomName, { agentName: 'bob', message: 'new 2', clientMessageId: 'epoch-race-2' });

    // The long poll that follows (from the old cursor) marks the new room's messages read; they still come back.
    const result = await waiting;
    expect(result.messages.map((m) => m.message)).toEqual(['new 1', 'new 2']);
  });
});
