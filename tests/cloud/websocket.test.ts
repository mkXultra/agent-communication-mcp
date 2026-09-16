// wait_for_messages over WebSocket against the real agora (docs/cloud-architecture.md §5.4, D3, D6).
// A pass-through proxy (harness/proxy.ts) sits in front of agora to count upgrades, read the frames
// the client sends and cut connections; every API request is still answered by agora itself.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getCloudBackend, CloudApiClient, CloudBackend } from '../../src/cloud/index.js';
import { WaitCancelledError } from '../../src/errors/index.js';
import { issueToken, startAgora, type AgoraInstance } from './harness/agora.js';
import { createMcpClient, McpCallError, sleep, waitUntil, withEnv, type McpTestClient } from './harness/mcp.js';
import { AgoraProxy, type RecordedRequest } from './harness/proxy.js';

const agoraUrl = process.env.AGENT_COMM_API_URL!;
const token = process.env.AGENT_COMM_TOKEN!;

interface WaitResult {
  messages: Array<{ id: string; agentName: string; roomName: string; message: string; timestamp: string; mentions: string[] }>;
  hasNewMessages: boolean;
  timedOut: boolean;
  warning?: string;
  waitingAgents?: string[];
}

async function membersOf(api: CloudApiClient, roomName: string) {
  const list = await api.listMembers(roomName);
  return Object.fromEntries(list.members.map((m) => [m.agentName, m]));
}

/** MessageService.waitForMessages (file mode) for one other waiting agent. */
const FILE_MODE_DEADLOCK_WARNING = 'Potential deadlock detected: 1 other agent(s) are also waiting for messages';

describe('wait_for_messages over WebSocket', () => {
  let proxy: AgoraProxy;
  let client: McpTestClient;
  let api: CloudApiClient;
  const env = () => ({ AGENT_COMM_API_URL: proxy.url, AGENT_COMM_TOKEN: token });
  const backend = () => getCloudBackend(env())!;

  beforeAll(async () => {
    proxy = await AgoraProxy.start(agoraUrl);
    api = new CloudApiClient({ apiUrl: agoraUrl, token });
  });

  afterAll(async () => {
    await proxy.close();
  });

  beforeEach(async () => {
    proxy.reset();
    client = await withEnv(env(), () => createMcpClient());
  });

  afterEach(async () => {
    await client.close();
  });

  async function setupRoom(roomName: string, agents: string[]): Promise<void> {
    await client.call('create_room', { roomName });
    for (const agentName of agents) await client.call('enter_room', { agentName, roomName });
  }

  it('keeps one connection per room x agent for the lifetime of the process', async () => {
    await setupRoom('hold-1', ['alice', 'bob']);
    await setupRoom('hold-2', ['alice']);

    await client.call('wait_for_messages', { agentName: 'alice', roomName: 'hold-1', timeout: 1 });
    await client.call('wait_for_messages', { agentName: 'alice', roomName: 'hold-1', timeout: 1 });
    await client.call('wait_for_messages', { agentName: 'alice', roomName: 'hold-2', timeout: 1 });
    await client.call('wait_for_messages', { agentName: 'bob', roomName: 'hold-1', timeout: 1 });
    await client.call('wait_for_messages', { agentName: 'alice', roomName: 'hold-2', timeout: 1 });

    const upgrades = proxy.requests.filter((r) => r.method === 'UPGRADE').map((r) => r.path);
    expect(upgrades).toHaveLength(3);
    // `since` is the read position the join response reported (the rooms were empty).
    expect(upgrades).toEqual(
      expect.arrayContaining([
        '/rooms/hold-1/ws?agentName=alice&since=0',
        '/rooms/hold-2/ws?agentName=alice&since=0',
        '/rooms/hold-1/ws?agentName=bob&since=0',
      ]),
    );
    // Still connected between calls (the server sees them as connected members).
    const room1 = await membersOf(api, 'hold-1');
    const room2 = await membersOf(api, 'hold-2');
    expect(room1.alice!.connected).toBe(true);
    expect(room1.bob!.connected).toBe(true);
    expect(room2.alice!.connected).toBe(true);
    expect(backend().waits.hasOpenSocket('hold-1', 'alice')).toBe(true);

    // No HTTP long polling while the WebSocket works.
    expect(proxy.requests.some((r) => r.method === 'GET' && r.path.includes('/messages?') && r.path.includes('wait='))).toBe(false);
  });

  it('declares each wait with wait_start / wait_end and stores the read position with read', async () => {
    await setupRoom('frames', ['alice', 'bob']);

    // Timed-out wait: tool timeout 2 s -> 2000 ms -> wait_start.timeoutSeconds = 2
    const waiting = client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'frames', timeout: 2 });
    await waitUntil(async () => (await membersOf(api, 'frames')).alice!.waiting === true, 5000, 'alice waiting');
    const timedOut = await waiting;
    expect(timedOut).toEqual({ messages: [], hasNewMessages: false, timedOut: true });
    expect((await membersOf(api, 'frames')).alice!.waiting).toBe(false);

    const [start, end, ...rest] = proxy.clientFrames;
    expect(start).toEqual({ type: 'wait_start', requestId: expect.any(String), timeoutSeconds: 2 });
    expect(end).toEqual({ type: 'wait_end', requestId: start!.requestId });
    expect(rest).toEqual([]);

    // Wait released by a message: wait_start, wait_end and read up to the returned message.
    proxy.clientFrames.length = 0;
    setTimeout(() => void client.call('send_message', { agentName: 'bob', roomName: 'frames', message: 'ping @alice' }), 300);
    const released = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'frames', timeout: 5 });
    expect(released.hasNewMessages).toBe(true);
    expect(released.timedOut).toBe(false);
    expect(released.messages.map((m) => m.message)).toEqual(['ping @alice']);
    expect(Object.keys(released.messages[0]!).sort()).toEqual(['agentName', 'id', 'mentions', 'message', 'roomName', 'timestamp']);

    const types = proxy.clientFrames.map((frame) => frame.type);
    expect(types).toEqual(['wait_start', 'wait_end', 'read']);
    const stored = await api.getMessages('frames', { since: 0 });
    expect(proxy.clientFrames[2]).toEqual({ type: 'read', seq: stored.latestSeq, requestId: expect.any(String) });
    expect((await membersOf(api, 'frames')).alice!.lastReadSeq).toBe(stored.latestSeq);
  });

  it('declares up to 300 seconds (the tool maximum) and 30 seconds when no timeout is given; 301 is rejected', async () => {
    await setupRoom('timeouts', ['alice', 'bob']);
    const aliceWaiting = async () => (await membersOf(api, 'timeouts')).alice!.waiting === true;

    const longest = client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'timeouts', timeout: 300 });
    await waitUntil(aliceWaiting, 5000, 'alice waiting (300 s)');
    expect(proxy.clientFrames).toEqual([{ type: 'wait_start', requestId: expect.any(String), timeoutSeconds: 300 }]);
    await client.call('send_message', { agentName: 'bob', roomName: 'timeouts', message: 'within 300 seconds' });
    expect((await longest).messages.map((m) => m.message)).toEqual(['within 300 seconds']);

    proxy.clientFrames.length = 0;
    const byDefault = client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'timeouts' });
    await waitUntil(aliceWaiting, 5000, 'alice waiting (default)');
    expect(proxy.clientFrames).toEqual([{ type: 'wait_start', requestId: expect.any(String), timeoutSeconds: 30 }]);
    await client.call('send_message', { agentName: 'bob', roomName: 'timeouts', message: 'within 30 seconds' });
    expect((await byDefault).messages.map((m) => m.message)).toEqual(['within 30 seconds']);

    proxy.clientFrames.length = 0;
    await expect(client.call('wait_for_messages', { agentName: 'alice', roomName: 'timeouts', timeout: 301 })).rejects.toThrow(
      "Validation failed for field 'timeout': Timeout cannot exceed 300000ms",
    );
    expect(proxy.clientFrames).toEqual([]);
  });

  it('ends a wait without a time limit when the MCP client cancels the call, and leaves the next message for the next call', async () => {
    await setupRoom('cancelled', ['alice', 'bob']);
    const aliceWaiting = async () => (await membersOf(api, 'cancelled')).alice!.waiting === true;

    const pending = client.start<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'cancelled', timeout: 0 });
    let answered = false;
    pending.result.then(
      () => {
        answered = true;
      },
      (error: unknown) => {
        if (error instanceof McpCallError) answered = true;
      },
    );
    await waitUntil(aliceWaiting, 5000, 'alice waiting');
    // This agora keeps a declared wait 300 s: only wait_end makes it stop listing alice this soon.
    pending.cancel('tool call timed out');
    await waitUntil(async () => !(await aliceWaiting()), 3000, 'wait ended on the server');
    const [start, end, ...rest] = proxy.clientFrames;
    expect(start).toEqual({ type: 'wait_start', requestId: expect.any(String), timeoutSeconds: 300 });
    expect(end).toEqual({ type: 'wait_end', requestId: start!.requestId });
    expect(rest).toEqual([]);

    await client.call('send_message', { agentName: 'bob', roomName: 'cancelled', message: 'for the next call' });
    await sleep(300);
    const next = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'cancelled', timeout: 3 });
    expect(next.messages.map((m) => m.message)).toEqual(['for the next call']);
    // No response is sent for a cancelled call.
    expect(answered).toBe(false);
  });

  it('with mentionsOnly, waits through messages that do not mention the agent and returns on a mention, reading the others', async () => {
    await setupRoom('mentions', ['alice', 'bob', 'carol']);
    const aliceWaiting = async () => (await membersOf(api, 'mentions')).alice!.waiting === true;

    let settled = false;
    const waiting = client
      .call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'mentions', timeout: 10, mentionsOnly: true })
      .finally(() => {
        settled = true;
      });
    await waitUntil(aliceWaiting, 5000, 'alice waiting');
    await client.call('send_message', { agentName: 'bob', roomName: 'mentions', message: 'question for anyone' });
    await client.call('send_message', { agentName: 'carol', roomName: 'mentions', message: 'over to you @bob' });
    await client.call('send_message', { agentName: 'alice', roomName: 'mentions', message: 'note to myself @alice' });
    await sleep(500);
    // Filtered on the client: the wait goes on, still declared on the server (D3), without another frame.
    expect(settled).toBe(false);
    expect(await aliceWaiting()).toBe(true);
    expect(proxy.clientFrames.map((frame) => frame.type)).toEqual(['wait_start']);

    await client.call('send_message', { agentName: 'bob', roomName: 'mentions', message: 'your turn @alice' });
    const result = await waiting;
    expect(result.messages.map((m) => m.message)).toEqual(['your turn @alice']);
    expect(result.messages[0]!.mentions).toEqual(['alice']);
    expect(result).toMatchObject({ hasNewMessages: true, timedOut: false });

    // One read position for the whole wait, past the messages it passed over; nothing went over HTTP.
    const stored = await api.getMessages('mentions', { since: 0 });
    expect(proxy.clientFrames.map((frame) => frame.type)).toEqual(['wait_start', 'wait_end', 'read']);
    expect(proxy.clientFrames[2]).toEqual({ type: 'read', seq: stored.latestSeq, requestId: expect.any(String) });
    expect((await membersOf(api, 'mentions')).alice!.lastReadSeq).toBe(stored.latestSeq);
    expect(proxy.requests.some((r) => r.method === 'GET' && r.path.includes('/messages?'))).toBe(false);

    // The client cursor moved past them as well: the next wait, without mentionsOnly, does not return them.
    const next = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'mentions', timeout: 1 });
    expect(next).toEqual({ messages: [], hasNewMessages: false, timedOut: true });
  });

  it('with mentionsOnly, times out with only messages that do not mention the agent and stores the read position past them', async () => {
    await setupRoom('mentions-timeout', ['alice', 'bob']);
    setTimeout(() => void client.call('send_message', { agentName: 'bob', roomName: 'mentions-timeout', message: 'for anyone' }), 300);

    const started = Date.now();
    const result = await client.call<WaitResult>('wait_for_messages', {
      agentName: 'alice',
      roomName: 'mentions-timeout',
      timeout: 2,
      mentionsOnly: true,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
    expect(result).toEqual({ messages: [], hasNewMessages: false, timedOut: true });

    const stored = await api.getMessages('mentions-timeout', { since: 0 });
    expect(stored.messages.map((m) => m.message)).toEqual(['for anyone']);
    expect(proxy.clientFrames.map((frame) => frame.type)).toEqual(['wait_start', 'wait_end', 'read']);
    expect(proxy.clientFrames[2]).toEqual({ type: 'read', seq: stored.latestSeq, requestId: expect.any(String) });
    expect((await membersOf(api, 'mentions-timeout')).alice!.lastReadSeq).toBe(stored.latestSeq);

    // Returned again neither by this process (client cursor) nor by another one (server read position).
    const next = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'mentions-timeout', timeout: 1 });
    expect(next).toEqual({ messages: [], hasNewMessages: false, timedOut: true });
    const other = new CloudBackend({ apiUrl: proxy.url, token });
    try {
      const elsewhere = await other.messaging.waitForMessages({ agentName: 'alice', roomName: 'mentions-timeout', timeout: 1000 });
      expect(elsewhere).toEqual({ messages: [], hasNewMessages: false, timedOut: true });
    } finally {
      await other.close();
    }
  });

  it('with mentionsOnly, returns only the mentions among the messages buffered since the last call and consumes the rest', async () => {
    await setupRoom('mentions-buffered', ['alice', 'bob']);
    await client.call('wait_for_messages', { agentName: 'alice', roomName: 'mentions-buffered', timeout: 1 });
    for (const message of ['before', 'first @alice', 'between', 'second @alice', 'after']) {
      await client.call('send_message', { agentName: 'bob', roomName: 'mentions-buffered', message });
    }
    await sleep(300);

    const started = Date.now();
    const result = await client.call<WaitResult>('wait_for_messages', {
      agentName: 'alice',
      roomName: 'mentions-buffered',
      timeout: 5,
      mentionsOnly: true,
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.messages.map((m) => m.message)).toEqual(['first @alice', 'second @alice']);
    // Like the `nextCursor` of the API, the read position covers every message the wait looked at, 'after' included.
    const stored = await api.getMessages('mentions-buffered', { since: 0 });
    expect((await membersOf(api, 'mentions-buffered')).alice!.lastReadSeq).toBe(stored.latestSeq);

    const next = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'mentions-buffered', timeout: 1 });
    expect(next).toEqual({ messages: [], hasNewMessages: false, timedOut: true });
  });

  it('with mentionsOnly, a cancelled wait leaves read what it passed over, and the mention that follows for the next call', async () => {
    await setupRoom('mentions-cancelled', ['alice', 'bob']);
    const member = async () => (await membersOf(api, 'mentions-cancelled')).alice!;

    const pending = client.start<WaitResult>('wait_for_messages', {
      agentName: 'alice',
      roomName: 'mentions-cancelled',
      timeout: 0,
      mentionsOnly: true,
    });
    let answered = false;
    pending.result.then(
      () => {
        answered = true;
      },
      (error: unknown) => {
        if (error instanceof McpCallError) answered = true;
      },
    );
    await waitUntil(async () => (await member()).waiting === true, 5000, 'alice waiting');
    await client.call('send_message', { agentName: 'bob', roomName: 'mentions-cancelled', message: 'for anyone' });
    await sleep(500);

    pending.cancel('tool call timed out');
    await waitUntil(async () => (await member()).waiting === false, 3000, 'wait ended on the server');
    const stored = await api.getMessages('mentions-cancelled', { since: 0 });
    await waitUntil(async () => (await member()).lastReadSeq === stored.latestSeq, 3000, 'read position stored');
    expect(proxy.clientFrames.map((frame) => frame.type)).toEqual(['wait_start', 'wait_end', 'read']);

    // The connection drops before the next call, which connects again from the client cursor: past what the cancelled
    // wait passed over.
    proxy.destroyWebSockets();
    await waitUntil(() => !backend().waits.hasOpenSocket('mentions-cancelled', 'alice'), 5000, 'socket closed');
    await client.call('send_message', { agentName: 'bob', roomName: 'mentions-cancelled', message: 'now for @alice' });
    const next = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'mentions-cancelled', timeout: 3 });
    expect(next.messages.map((m) => m.message)).toEqual(['now for @alice']);
    expect(proxy.requests.filter((r) => r.method === 'UPGRADE').map((r) => r.path)).toEqual([
      '/rooms/mentions-cancelled/ws?agentName=alice&since=0',
      `/rooms/mentions-cancelled/ws?agentName=alice&since=${stored.latestSeq}`,
    ]);
    expect(answered).toBe(false);
  });

  it('with mentionsOnly, stores the read position of what it passed over on a connection that dropped before the wait timed out', async () => {
    const roomName = 'mentions-dropped';
    await setupRoom(roomName, ['alice', 'bob']);
    const member = async () => (await membersOf(api, roomName)).alice!;
    const markReads = () =>
      proxy.requests.filter((r) => r.method === 'GET' && r.path.startsWith(`/rooms/${roomName}/messages?`)).map((r) => r.path);

    const waiting = client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName, timeout: 5, mentionsOnly: true });
    await waitUntil(async () => (await member()).waiting === true, 5000, 'alice waiting');
    await client.call('send_message', { agentName: 'bob', roomName, message: 'for anyone' });
    await sleep(500);
    // Passed over on the first connection, which drops; the call connects again and waits out its timeout there.
    proxy.destroyWebSockets();
    await waitUntil(() => proxy.clientFrames.filter((frame) => frame.type === 'wait_start').length === 2, 5000, 'declared again');
    expect((await member()).lastReadSeq).toBe(0);

    const result = await waiting;
    expect(result).toEqual({ messages: [], hasNewMessages: false, timedOut: true });
    const stored = await api.getMessages(roomName, { since: 0 });
    expect((await member()).lastReadSeq).toBe(stored.latestSeq);
    // The second connection did not deliver the message, so the read position went over HTTP, after a check without
    // side effects that the message is still there.
    expect(proxy.clientFrames.map((frame) => frame.type)).toEqual(['wait_start', 'wait_start', 'wait_end']);
    expect(markReads()).toEqual([
      `/rooms/${roomName}/messages?before=${stored.latestSeq + 1}&limit=1`,
      `/rooms/${roomName}/messages?agentName=alice&before=${stored.latestSeq + 1}&limit=1&markRead=true`,
    ]);

    // Returned again neither by this process (client cursor) nor by another one (server read position).
    const next = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName, timeout: 1 });
    expect(next).toEqual({ messages: [], hasNewMessages: false, timedOut: true });
    const other = new CloudBackend({ apiUrl: proxy.url, token });
    try {
      const elsewhere = await other.messaging.waitForMessages({ agentName: 'alice', roomName, timeout: 1000 });
      expect(elsewhere).toEqual({ messages: [], hasNewMessages: false, timedOut: true });
    } finally {
      await other.close();
    }
  });

  it('with mentionsOnly, stores that read position when a wait without a time limit is cancelled on the connection made after a drop', async () => {
    const roomName = 'mentions-dropped-cancelled';
    await setupRoom(roomName, ['alice', 'bob']);
    const member = async () => (await membersOf(api, roomName)).alice!;
    // Connects again at once after a drop, instead of long polling until the cooldown is over.
    const other = new CloudBackend({ apiUrl: proxy.url, token }, { wait: { webSocketRetryCooldownMs: 50 } });
    try {
      const controller = new AbortController();
      const outcome = other.messaging
        .waitForMessages({ agentName: 'alice', roomName, timeout: 0, mentionsOnly: true }, controller.signal)
        .then(
          () => 'resolved',
          (error: unknown) => error,
        );
      await waitUntil(async () => (await member()).waiting === true, 5000, 'alice waiting');
      await client.call('send_message', { agentName: 'bob', roomName, message: 'for anyone' });
      await sleep(500);
      proxy.destroyWebSockets();
      await waitUntil(() => proxy.clientFrames.filter((frame) => frame.type === 'wait_start').length === 2, 5000, 'declared again');

      controller.abort();
      expect(await outcome).toBeInstanceOf(WaitCancelledError);
      const stored = await api.getMessages(roomName, { since: 0 });
      expect((await member()).lastReadSeq).toBe(stored.latestSeq);
      expect(other.waits.stats.longPollRequests).toBe(0);

      const fresh = new CloudBackend({ apiUrl: proxy.url, token });
      try {
        const elsewhere = await fresh.messaging.waitForMessages({ agentName: 'alice', roomName, timeout: 1000 });
        expect(elsewhere).toEqual({ messages: [], hasNewMessages: false, timedOut: true });
      } finally {
        await fresh.close();
      }
    } finally {
      await other.close();
    }
  });

  it('with mentionsOnly, stores that read position over HTTP when the call ends with no connection left to store it', async () => {
    const roomName = 'mentions-no-connection';
    await setupRoom(roomName, ['alice', 'bob']);
    const member = async () => (await membersOf(api, roomName)).alice!;
    const longPoll = (r: RecordedRequest): boolean =>
      r.method === 'GET' && r.path.startsWith(`/rooms/${roomName}/messages?`) && /[?&]wait=/.test(r.path);
    const other = new CloudBackend({ apiUrl: proxy.url, token });
    try {
      const controller = new AbortController();
      const outcome = other.messaging
        .waitForMessages({ agentName: 'alice', roomName, timeout: 0, mentionsOnly: true }, controller.signal)
        .then(
          () => 'resolved',
          (error: unknown) => error,
        );
      await waitUntil(async () => (await member()).waiting === true, 5000, 'alice waiting');
      await client.call('send_message', { agentName: 'bob', roomName, message: 'for anyone' });
      await sleep(500);
      // The connection drops, the WebSocket cannot be made again, and the long poll that follows is never answered.
      proxy.webSocketPolicy = 'reject';
      proxy.holdRequests(longPoll);
      proxy.destroyWebSockets();
      await waitUntil(() => proxy.requests.some(longPoll), 10000, 'long poll held');
      expect((await member()).lastReadSeq).toBe(0);

      controller.abort();
      expect(await outcome).toBeInstanceOf(WaitCancelledError);
      const stored = await api.getMessages(roomName, { since: 0 });
      expect((await member()).lastReadSeq).toBe(stored.latestSeq);
      expect(proxy.requests.filter((r) => r.method === 'GET' && r.path.includes('before=')).map((r) => r.path)).toEqual([
        `/rooms/${roomName}/messages?before=${stored.latestSeq + 1}&limit=1`,
        `/rooms/${roomName}/messages?agentName=alice&before=${stored.latestSeq + 1}&limit=1&markRead=true`,
      ]);
    } finally {
      proxy.holdRequests(undefined);
      await other.close();
    }
  });

  /**
   * The setup of the test above: alice's mentionsOnly wait in `other` passes over 'for anyone', then loses its connection
   * with no way left to store that read position before the call ends (WebSocket refused, long poll held). Returns the
   * outcome of the wait and the seq passed over.
   */
  async function passOverWithNoConnectionLeft(
    roomName: string,
    other: CloudBackend,
    signal: AbortSignal,
  ): Promise<{ outcome: Promise<unknown>; passedOverSeq: number }> {
    await setupRoom(roomName, ['alice', 'bob']);
    const longPoll = (r: RecordedRequest): boolean =>
      r.method === 'GET' && r.path.startsWith(`/rooms/${roomName}/messages?`) && /[?&]wait=/.test(r.path);
    const outcome = other.messaging.waitForMessages({ agentName: 'alice', roomName, timeout: 0, mentionsOnly: true }, signal).then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await waitUntil(async () => (await membersOf(api, roomName)).alice!.waiting === true, 5000, 'alice waiting');
    const sent = await client.call<{ messageId: string }>('send_message', { agentName: 'bob', roomName, message: 'for anyone' });
    await sleep(500);
    proxy.webSocketPolicy = 'reject';
    proxy.holdRequests(longPoll);
    proxy.destroyWebSockets();
    await waitUntil(() => proxy.requests.some(longPoll), 10000, 'long poll held');
    const passedOver = (await api.getMessages(roomName, { since: 0 })).messages.find((m) => m.id === sent.messageId)!;
    return { outcome, passedOverSeq: passedOver.seq };
  }

  /** The IDs another process's default wait for alice returns (straight to agora, past the proxy's rules). */
  async function returnedToAnotherProcess(roomName: string): Promise<string[]> {
    const fresh = new CloudBackend({ apiUrl: agoraUrl, token });
    try {
      return (await fresh.messaging.waitForMessages({ agentName: 'alice', roomName, timeout: 3000 })).messages.map((m) => m.id);
    } finally {
      await fresh.close();
    }
  }

  it('with mentionsOnly, does not mark a message sent after clear_room_messages read when storing that read position over HTTP', async () => {
    const roomName = 'mentions-cleared-meanwhile';
    const other = new CloudBackend({ apiUrl: proxy.url, token });
    const controller = new AbortController();
    try {
      const { outcome, passedOverSeq } = await passOverWithNoConnectionLeft(roomName, other, controller.signal);
      await api.clearRoomMessages(roomName, true);
      const clearedTo = (await membersOf(api, roomName)).alice!.lastReadSeq;
      const sent = await api.sendMessage(roomName, { agentName: 'bob', message: 'after the clear', clientMessageId: `${roomName}-new` });

      controller.abort();
      expect(await outcome).toBeInstanceOf(WaitCancelledError);
      // No message at or below the seq passed over is left, so only the check went out: a markRead request that finds
      // nothing stores the room's latest seq, past the message sent after the clear.
      expect(proxy.requests.filter((r) => r.method === 'GET' && r.path.includes('before=')).map((r) => r.path)).toEqual([
        `/rooms/${roomName}/messages?before=${passedOverSeq + 1}&limit=1`,
      ]);
      expect((await membersOf(api, roomName)).alice!.lastReadSeq).toBe(clearedTo);
      expect(await returnedToAnotherProcess(roomName)).toEqual([sent.messageId]);
    } finally {
      controller.abort();
      proxy.holdRequests(undefined);
      await other.close();
    }
  });

  it('with mentionsOnly, does not mark read by that read position a room deleted, created again and rejoined meanwhile', async () => {
    const roomName = 'mentions-recreated-meanwhile';
    const other = new CloudBackend({ apiUrl: proxy.url, token });
    const controller = new AbortController();
    try {
      const { outcome, passedOverSeq } = await passOverWithNoConnectionLeft(roomName, other, controller.signal);
      await api.deleteRoom(roomName);
      await api.createRoom(roomName);
      await api.joinRoom(roomName, 'alice');
      await api.joinRoom(roomName, 'bob');
      const joinedAt = (await membersOf(api, roomName)).alice!.lastReadSeq;
      const sent = await api.sendMessage(roomName, { agentName: 'bob', message: 'in the room created again', clientMessageId: `${roomName}-new` });
      // The new room has a message at or below the seq passed over in the old one: only the epoch tells them apart.
      expect(sent.seq).toBeLessThanOrEqual(passedOverSeq);

      controller.abort();
      expect(await outcome).toBeInstanceOf(WaitCancelledError);
      expect(proxy.requests.filter((r) => r.method === 'GET' && r.path.includes('before=')).map((r) => r.path)).toEqual([
        `/rooms/${roomName}/messages?before=${passedOverSeq + 1}&limit=1`,
      ]);
      expect((await membersOf(api, roomName)).alice!.lastReadSeq).toBe(joinedAt);
      expect(await returnedToAnotherProcess(roomName)).toEqual([sent.messageId]);
    } finally {
      controller.abort();
      proxy.holdRequests(undefined);
      await other.close();
    }
  });

  it('with mentionsOnly, stores the read position of what a wait passed over when the server shuts down', async () => {
    const roomName = 'mentions-shutdown';
    await setupRoom(roomName, ['alice', 'bob']);
    const member = async () => (await membersOf(api, roomName)).alice!;

    const pending = client.start<WaitResult>('wait_for_messages', { agentName: 'alice', roomName, timeout: 0, mentionsOnly: true });
    pending.result.catch(() => undefined);
    await waitUntil(async () => (await member()).waiting === true, 5000, 'alice waiting');
    await client.call('send_message', { agentName: 'bob', roomName, message: 'for anyone' });
    await sleep(500);

    await client.registry.shutdown();
    // The wait ended over its open connection before the server closed it.
    expect(proxy.clientFrames.map((frame) => frame.type)).toEqual(['wait_start', 'wait_end', 'read']);
    const stored = await api.getMessages(roomName, { since: 0 });
    expect((await member()).lastReadSeq).toBe(stored.latestSeq);
    await waitUntil(async () => (await member()).connected === false, 5000, 'alice disconnected');
  });

  it('returns messages that arrived while no wait was running, then only new ones', async () => {
    await setupRoom('buffered', ['alice', 'bob']);
    await client.call('wait_for_messages', { agentName: 'alice', roomName: 'buffered', timeout: 1 });

    await client.call('send_message', { agentName: 'bob', roomName: 'buffered', message: 'one' });
    await client.call('send_message', { agentName: 'alice', roomName: 'buffered', message: 'own message' });
    await client.call('send_message', { agentName: 'bob', roomName: 'buffered', message: 'two' });

    const started = Date.now();
    const first = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'buffered', timeout: 5 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(first.messages.map((m) => m.message)).toEqual(['one', 'two']);

    const second = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'buffered', timeout: 1 });
    expect(second).toEqual({ messages: [], hasNewMessages: false, timedOut: true });
  });

  it('does not lose a message that arrived before the agent replied (sending moves the server read position)', async () => {
    await setupRoom('reply', ['alice', 'bob']);
    setTimeout(() => void client.call('send_message', { agentName: 'bob', roomName: 'reply', message: 'question 1' }), 200);
    const first = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'reply', timeout: 5 });
    expect(first.messages.map((m) => m.message)).toEqual(['question 1']);

    await client.call('send_message', { agentName: 'bob', roomName: 'reply', message: 'question 2' });
    await client.call('send_message', { agentName: 'alice', roomName: 'reply', message: 'answer 1' });

    const second = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'reply', timeout: 2 });
    expect(second.messages.map((m) => m.message)).toEqual(['question 2']);
  });

  it('reports the other agents already waiting when a wait begins (waiting frame)', async () => {
    await setupRoom('deadlock', ['alice', 'bob', 'carol']);

    const alice = client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'deadlock', timeout: 5 });
    await waitUntil(async () => (await membersOf(api, 'deadlock')).alice!.waiting === true, 5000, 'alice waiting');
    const bob = client.call<WaitResult>('wait_for_messages', { agentName: 'bob', roomName: 'deadlock', timeout: 5 });
    await waitUntil(async () => (await membersOf(api, 'deadlock')).bob!.waiting === true, 5000, 'bob waiting');
    await client.call('send_message', { agentName: 'carol', roomName: 'deadlock', message: 'wake up' });

    const [aliceResult, bobResult] = await Promise.all([alice, bob]);
    expect(aliceResult.messages.map((m) => m.message)).toEqual(['wake up']);
    expect(aliceResult.warning).toBeUndefined();
    expect(aliceResult.waitingAgents).toBeUndefined();
    expect(bobResult.messages.map((m) => m.message)).toEqual(['wake up']);
    expect(bobResult.waitingAgents).toEqual(['alice']);
    // The file-mode text, not agora's own wording from the waiting frame.
    expect(bobResult.warning).toBe(FILE_MODE_DEADLOCK_WARNING);
  });

  it('returns messages sent before the agent first spoke in the room (read position from enter_room)', async () => {
    await setupRoom('first-reply', ['alice', 'bob']);
    await client.call('send_message', { agentName: 'bob', roomName: 'first-reply', message: 'hello alice' });
    await client.call('send_message', { agentName: 'alice', roomName: 'first-reply', message: 'hi bob' });
    // Entering and sending are one request each: the read position and its epoch came with the join response.
    expect(proxy.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /rooms',
      'POST /rooms/first-reply/join',
      'POST /rooms/first-reply/join',
      'POST /rooms/first-reply/messages',
      'POST /rooms/first-reply/messages',
    ]);

    const result = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'first-reply', timeout: 3 });
    expect(result.messages.map((m) => m.message)).toEqual(['hello alice']);
    expect(result.timedOut).toBe(false);
  });

  it('also returns them when the agent entered the room from another MCP process', async () => {
    await setupRoom('entered-elsewhere', ['alice', 'bob']);
    // A second MCP server process for alice: it has no read position of its own.
    const other = new CloudBackend({ apiUrl: proxy.url, token });
    try {
      await client.call('send_message', { agentName: 'bob', roomName: 'entered-elsewhere', message: 'before alice spoke' });
      await other.messaging.sendMessage({ agentName: 'alice', roomName: 'entered-elsewhere', message: 'alice speaks' });
      await other.messaging.sendMessage({ agentName: 'alice', roomName: 'entered-elsewhere', message: 'alice again' });
      // Only the first send of that process looks the read position (and its epoch) up, with one GET /members.
      expect(proxy.requests.filter((r) => r.method === 'GET').map((r) => r.path)).toEqual([
        '/rooms/entered-elsewhere/members?includeOffline=true',
      ]);

      const result = await other.messaging.waitForMessages({ agentName: 'alice', roomName: 'entered-elsewhere', timeout: 3000 });
      expect(result.messages.map((m) => m.message)).toEqual(['before alice spoke']);
    } finally {
      await other.close();
    }
  });

  it('waits in several rooms at once and releases only the room that got a message', async () => {
    await setupRoom('multi-a', ['alice', 'bob']);
    await setupRoom('multi-b', ['alice', 'bob']);

    const inA = client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'multi-a', timeout: 2 });
    const inB = client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'multi-b', timeout: 5 });
    setTimeout(() => void client.call('send_message', { agentName: 'bob', roomName: 'multi-b', message: 'for b' }), 300);

    const [a, b] = await Promise.all([inA, inB]);
    expect(b.messages.map((m) => m.message)).toEqual(['for b']);
    expect(a).toEqual({ messages: [], hasNewMessages: false, timedOut: true });
  });

  it('drops buffered messages after clear_room_messages', async () => {
    await setupRoom('cleared', ['alice', 'bob']);
    await client.call('wait_for_messages', { agentName: 'alice', roomName: 'cleared', timeout: 1 });
    await client.call('send_message', { agentName: 'bob', roomName: 'cleared', message: 'old 1' });
    await client.call('send_message', { agentName: 'bob', roomName: 'cleared', message: 'old 2' });

    const cleared = await client.call('clear_room_messages', { roomName: 'cleared', confirm: true });
    expect(cleared).toEqual({ success: true, roomName: 'cleared', clearedCount: 2 });

    const afterClear = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'cleared', timeout: 1 });
    expect(afterClear.messages).toEqual([]);
    await client.call('send_message', { agentName: 'bob', roomName: 'cleared', message: 'new' });
    const fresh = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'cleared', timeout: 2 });
    expect(fresh.messages.map((m) => m.message)).toEqual(['new']);
  });

  it('keeps a message sent after clear_room_messages that arrived before the clear response', async () => {
    await setupRoom('clear-race', ['alice', 'bob']);
    await client.call('wait_for_messages', { agentName: 'alice', roomName: 'clear-race', timeout: 1 });
    await client.call('send_message', { agentName: 'bob', roomName: 'clear-race', message: 'old 1' });
    await client.call('send_message', { agentName: 'bob', roomName: 'clear-race', message: 'old 2' });

    // agora clears the room at once; its answer reaches the client 2 s later.
    proxy.delayResponses((r) => r.method === 'DELETE' && r.path.startsWith('/rooms/clear-race/messages'), 2000);
    let clearAnswered = false;
    const clearing = client.call('clear_room_messages', { roomName: 'clear-race', confirm: true }).finally(() => {
      clearAnswered = true;
    });
    await waitUntil(async () => (await api.getMessages('clear-race', { since: 0 })).count === 0, 5000, 'room cleared');
    await client.call('send_message', { agentName: 'bob', roomName: 'clear-race', message: 'after clear' });
    // The message frame is pushed while agora handles the send, so alice's connection has buffered it by now.
    await sleep(300);
    expect(clearAnswered).toBe(false);
    expect(await clearing).toEqual({ success: true, roomName: 'clear-race', clearedCount: 2 });

    const started = Date.now();
    const result = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'clear-race', timeout: 3 });
    expect(result.messages.map((m) => m.message)).toEqual(['after clear']);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reconnects on the next call after the connection was cut, and delivers what was sent meanwhile', async () => {
    await setupRoom('cut', ['alice', 'bob']);
    await client.call('wait_for_messages', { agentName: 'alice', roomName: 'cut', timeout: 1 });
    expect(backend().waits.hasOpenSocket('cut', 'alice')).toBe(true);

    proxy.destroyWebSockets();
    await waitUntil(() => !backend().waits.hasOpenSocket('cut', 'alice'), 5000, 'socket closed');
    await client.call('send_message', { agentName: 'bob', roomName: 'cut', message: 'sent while disconnected' });

    const result = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'cut', timeout: 3 });
    expect(result.messages.map((m) => m.message)).toEqual(['sent while disconnected']);
    expect(proxy.requests.filter((r) => r.method === 'UPGRADE')).toHaveLength(2);
    expect(backend().waits.hasOpenSocket('cut', 'alice')).toBe(true);
  });

  it('reconnects within a wait that loses its connection', async () => {
    await setupRoom('mid-wait', ['alice', 'bob']);
    await client.call('wait_for_messages', { agentName: 'alice', roomName: 'mid-wait', timeout: 1 });

    const waiting = client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'mid-wait', timeout: 6 });
    await waitUntil(async () => (await membersOf(api, 'mid-wait')).alice!.waiting === true, 5000, 'alice waiting');
    proxy.destroyWebSockets();
    await sleep(300);
    await client.call('send_message', { agentName: 'bob', roomName: 'mid-wait', message: 'after the cut' });

    const result = await waiting;
    expect(result.messages.map((m) => m.message)).toEqual(['after the cut']);
    expect(proxy.requests.filter((r) => r.method === 'UPGRADE').length).toBeGreaterThanOrEqual(2);
  });

  it('detects a connection that went silent (keepalive ping) and reconnects on the next call', async () => {
    await setupRoom('silent', ['alice', 'bob']);
    const backend = new CloudBackend({ apiUrl: proxy.url, token }, { wait: { pingIntervalMs: 200 } });
    try {
      await backend.rooms.enterRoom({ agentName: 'alice', roomName: 'silent' });
      await backend.messaging.waitForMessages({ agentName: 'alice', roomName: 'silent', timeout: 1000 });
      // Pongs keep an idle connection open.
      await sleep(1500);
      expect(backend.waits.hasOpenSocket('silent', 'alice')).toBe(true);

      // A NAT forgets the connection: no close reaches either side, pings go unanswered.
      proxy.freezeWebSockets();
      const frozenAt = Date.now();
      await waitUntil(() => !backend.waits.hasOpenSocket('silent', 'alice'), 5000, 'silent connection dropped');
      expect(Date.now() - frozenAt).toBeLessThan(1500);
      await client.call('send_message', { agentName: 'bob', roomName: 'silent', message: 'sent while silent' });

      const connects = backend.waits.stats.webSocketConnects;
      const result = await backend.messaging.waitForMessages({ agentName: 'alice', roomName: 'silent', timeout: 3000 });
      expect(result.messages.map((m) => m.message)).toEqual(['sent while silent']);
      expect(backend.waits.stats.webSocketConnects).toBe(connects + 1);
      expect(backend.waits.stats.longPollRequests).toBe(0);
      expect(backend.waits.hasOpenSocket('silent', 'alice')).toBe(true);
    } finally {
      await backend.close();
    }
  });

  it('treats an unanswered wait_start as a dead connection and reconnects within the same call', async () => {
    await setupRoom('no-ack', ['alice', 'bob']);
    const backend = new CloudBackend({ apiUrl: proxy.url, token }, { wait: { ackTimeoutMs: 500, pingIntervalMs: 60000 } });
    try {
      await backend.rooms.enterRoom({ agentName: 'alice', roomName: 'no-ack' });
      await backend.messaging.waitForMessages({ agentName: 'alice', roomName: 'no-ack', timeout: 1000 });
      proxy.freezeWebSockets();
      const upgrades = proxy.countRequests('UPGRADE', '/rooms/no-ack/ws');

      setTimeout(() => void client.call('send_message', { agentName: 'bob', roomName: 'no-ack', message: 'after the reconnect' }), 1500);
      const started = Date.now();
      const result = await backend.messaging.waitForMessages({ agentName: 'alice', roomName: 'no-ack', timeout: 6000 });
      expect(result.messages.map((m) => m.message)).toEqual(['after the reconnect']);
      expect(Date.now() - started).toBeLessThan(4000);
      expect(proxy.countRequests('UPGRADE', '/rooms/no-ack/ws')).toBe(upgrades + 1);
      expect(backend.waits.stats.longPollRequests).toBe(0);
    } finally {
      await backend.close();
    }
  });

  it('ends at the timeout when the held connection stops answering', async () => {
    await setupRoom('stalled', ['alice']);
    await client.call('wait_for_messages', { agentName: 'alice', roomName: 'stalled', timeout: 1 });
    proxy.freezeWebSockets();

    const started = Date.now();
    const result = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'stalled', timeout: 2 });
    const elapsed = Date.now() - started;
    expect(result).toEqual({ messages: [], hasNewMessages: false, timedOut: true });
    // The ack wait is cut at the deadline (plus a short grace), not at the 10 s ack timeout.
    expect(elapsed).toBeGreaterThanOrEqual(2000);
    expect(elapsed).toBeLessThan(4500);
    expect(backend().waits.hasOpenSocket('stalled', 'alice')).toBe(false);
  });

  it('follows a room that was deleted and created again (new epoch, seq restarts)', async () => {
    await setupRoom('reborn', ['alice', 'bob']);
    for (let i = 0; i < 3; i++) await client.call('send_message', { agentName: 'bob', roomName: 'reborn', message: `old ${i}` });
    const old = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'reborn', timeout: 1 });
    expect(old.messages).toHaveLength(3);

    await api.deleteRoom('reborn');
    await waitUntil(() => !backend().waits.hasOpenSocket('reborn', 'alice'), 5000, 'socket closed by the server');
    await setupRoom('reborn', ['alice', 'bob']);
    await client.call('send_message', { agentName: 'bob', roomName: 'reborn', message: 'first in the new room' });

    const result = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'reborn', timeout: 3 });
    expect(result.messages.map((m) => m.message)).toEqual(['first in the new room']);
  });

  it('releases the connection when the agent leaves the room and when the server shuts down', async () => {
    await setupRoom('release', ['alice', 'bob']);
    await client.call('wait_for_messages', { agentName: 'alice', roomName: 'release', timeout: 1 });
    await client.call('wait_for_messages', { agentName: 'bob', roomName: 'release', timeout: 1 });
    expect((await membersOf(api, 'release')).alice!.connected).toBe(true);

    await client.call('leave_room', { agentName: 'alice', roomName: 'release' });
    await waitUntil(async () => (await membersOf(api, 'release')).alice!.connected === false, 5000, 'alice disconnected');
    expect((await membersOf(api, 'release')).bob!.connected).toBe(true);

    await client.registry.shutdown();
    await waitUntil(async () => (await membersOf(api, 'release')).bob!.connected === false, 5000, 'bob disconnected');
  });
});

describe('wait_for_messages after agora restarts (server-side disconnect)', () => {
  let agora: AgoraInstance;
  let client: McpTestClient;
  let restartToken: string;

  beforeAll(async () => {
    agora = await startAgora();
    restartToken = await issueToken(agora.url, 'websocket restart test');
    client = await withEnv({ AGENT_COMM_API_URL: agora.url, AGENT_COMM_TOKEN: restartToken }, () => createMcpClient());
  }, 120000);

  afterAll(async () => {
    await client?.close();
    await agora?.stop();
  }, 60000);

  it('reconnects with the next wait_for_messages and keeps working', async () => {
    const backend = getCloudBackend({ AGENT_COMM_API_URL: agora.url, AGENT_COMM_TOKEN: restartToken })!;
    const api = new CloudApiClient({ apiUrl: agora.url, token: restartToken });
    await client.call('create_room', { roomName: 'restart' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'restart' });
    await client.call('enter_room', { agentName: 'bob', roomName: 'restart' });

    await client.call('wait_for_messages', { agentName: 'alice', roomName: 'restart', timeout: 1 });
    const connectsBefore = backend.waits.stats.webSocketConnects;
    expect(backend.waits.hasOpenSocket('restart', 'alice')).toBe(true);

    await agora.restart();
    await waitUntil(() => !backend.waits.hasOpenSocket('restart', 'alice'), 15000, 'socket closed by the restart');
    await client.call('send_message', { agentName: 'bob', roomName: 'restart', message: 'after restart' });

    const backlog = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'restart', timeout: 5 });
    expect(backlog.messages.map((m) => m.message)).toEqual(['after restart']);
    expect(backend.waits.stats.webSocketConnects).toBe(connectsBefore + 1);
    expect(backend.waits.stats.longPollRequests).toBe(0);

    setTimeout(() => void client.call('send_message', { agentName: 'bob', roomName: 'restart', message: 'live again' }), 300);
    const live = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'restart', timeout: 5 });
    expect(live.messages.map((m) => m.message)).toEqual(['live again']);
    expect(backend.waits.stats.webSocketConnects).toBe(connectsBefore + 1);
    expect((await api.listMembers('restart')).members.find((m) => m.agentName === 'alice')!.connected).toBe(true);
  }, 90000);
});
