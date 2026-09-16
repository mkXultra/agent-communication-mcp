// wait_for_messages with `timeout: 0`: wait until a message arrives (docs/cloud-architecture.md §5.4, 無期限待機).
// The real agora runs with WAIT_TIMEOUT_MAX_SECONDS=2, so it drops a declared wait after 2 seconds and the client has
// to declare it again several times within one test (in production the server keeps a wait 300 seconds). A pass-through
// proxy records the frames the client sends with their times, the long polls, and refuses WebSocket upgrades on demand.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CloudApiClient, CloudBackend, type CloudWaitService } from '../../src/cloud/index.js';
import { WaitCancelledError } from '../../src/errors/index.js';
import { deleteAllRooms, issueToken, startAgora, type AgoraInstance } from './harness/agora.js';
import { sleep, waitUntil } from './harness/mcp.js';
import { AgoraProxy } from './harness/proxy.js';

const SERVER_WAIT_MAX_SECONDS = 2;

type WaitOptions = ConstructorParameters<typeof CloudWaitService>[1];

function queryOf(path: string): URLSearchParams {
  return new URL(path, 'http://proxy').searchParams;
}

describe('wait_for_messages without a time limit (timeout 0)', () => {
  let agora: AgoraInstance;
  let token: string;
  let proxy: AgoraProxy;
  let api: CloudApiClient;
  const backends: CloudBackend[] = [];

  beforeAll(async () => {
    agora = await startAgora({ vars: { WAIT_TIMEOUT_MAX_SECONDS: String(SERVER_WAIT_MAX_SECONDS) } });
    token = await issueToken(agora.url, 'indefinite wait test');
    proxy = await AgoraProxy.start(agora.url);
    api = new CloudApiClient({ apiUrl: agora.url, token });
  }, 120000);

  afterAll(async () => {
    await proxy?.close();
    await agora?.stop();
  }, 60000);

  beforeEach(async () => {
    proxy.reset();
    await deleteAllRooms(agora.url, token);
  });

  afterEach(async () => {
    for (const backend of backends.splice(0)) await backend.close();
  });

  /** An MCP server process's cloud backend through the proxy, told how long this agora keeps a wait. */
  function backendWith(options: WaitOptions = {}): CloudBackend {
    const backend = new CloudBackend({ apiUrl: proxy.url, token }, { wait: { serverWaitMaxSeconds: SERVER_WAIT_MAX_SECONDS, ...options } });
    backends.push(backend);
    return backend;
  }

  async function setupRoom(backend: CloudBackend, roomName: string): Promise<void> {
    await backend.rooms.createRoom({ roomName });
    await backend.rooms.enterRoom({ agentName: 'alice', roomName });
    await backend.rooms.enterRoom({ agentName: 'bob', roomName });
    proxy.reset();
  }

  /** Whether agora lists the member as waiting right now (asked directly, not through the proxy). */
  async function isWaiting(roomName: string, agentName: string): Promise<boolean> {
    return (await api.listMembers(roomName)).members.find((member) => member.agentName === agentName)?.waiting === true;
  }

  const longPolls = (roomName: string) =>
    proxy.requests.filter((r) => r.method === 'GET' && r.path.startsWith(`/rooms/${roomName}/messages?`) && queryOf(r.path).has('wait'));

  it('declares the wait again before the server drops it, and returns the message that arrives after several declarations', async () => {
    const roomName = 'redeclare';
    const backend = backendWith();
    await setupRoom(backend, roomName);

    let settled = false;
    const waiting = backend.messaging.waitForMessages({ agentName: 'alice', roomName, timeout: 0 }).finally(() => {
      settled = true;
    });
    await waitUntil(() => proxy.clientFrames.length > 0, 5000, 'first wait_start');
    const startedAt = proxy.clientFrameLog[0]!.at;

    // Each declaration lasts 2 s on the server; watch the member for 7 s.
    const samples: boolean[] = [];
    while (Date.now() - startedAt < 7000) {
      samples.push(await isWaiting(roomName, 'alice'));
      await sleep(200);
    }
    expect(settled).toBe(false);
    // Listed as waiting from the first declaration on, without a gap when a declaration would have run out.
    const firstSeen = samples.indexOf(true);
    expect(firstSeen).toBeGreaterThanOrEqual(0);
    expect(firstSeen).toBeLessThanOrEqual(2);
    expect(samples.slice(firstSeen)).not.toContain(false);

    const sent = await backend.messaging.sendMessage({ agentName: 'bob', roomName, message: 'after several declarations' });
    const result = await waiting;
    expect(result).toEqual({
      messages: [
        { id: sent.messageId, agentName: 'bob', roomName, message: 'after several declarations', timestamp: sent.timestamp, mentions: [] },
      ],
      hasNewMessages: true,
      timedOut: false,
    });

    // One wait: wait_start with the same requestId every 1.5 s (2 s less a quarter), then wait_end and the read position.
    const frames = proxy.clientFrameLog;
    const starts = frames.filter(({ frame }) => frame.type === 'wait_start');
    const requestId = starts[0]!.frame.requestId;
    expect(starts.length).toBeGreaterThanOrEqual(5);
    expect(starts.map(({ frame }) => frame)).toEqual(starts.map(() => ({ type: 'wait_start', requestId, timeoutSeconds: 2 })));
    const intervals = starts.slice(1).map(({ at }, i) => at - starts[i]!.at);
    for (const interval of intervals) {
      expect(interval).toBeGreaterThanOrEqual(1400);
      expect(interval).toBeLessThan(1900);
    }
    expect(frames.slice(starts.length).map(({ frame }) => frame)).toEqual([
      { type: 'wait_end', requestId },
      { type: 'read', seq: expect.any(Number), requestId: expect.any(String) },
    ]);
    expect(backend.waits.stats.waitRedeclarations).toBe(starts.length - 1);
    expect(backend.waits.stats.longPollRequests).toBe(0);
    expect(proxy.countRequests('UPGRADE', `/rooms/${roomName}/ws`)).toBe(1);
    expect(await isWaiting(roomName, 'alice')).toBe(false);
  }, 30000);

  it('with mentionsOnly, keeps declaring the wait through messages that do not mention the agent, and returns on a mention', async () => {
    const roomName = 'mentions';
    const backend = backendWith();
    await setupRoom(backend, roomName);

    let settled = false;
    const waiting = backend.messaging.waitForMessages({ agentName: 'alice', roomName, timeout: 0, mentionsOnly: true }).finally(() => {
      settled = true;
    });
    await waitUntil(() => proxy.clientFrames.length > 0, 5000, 'first wait_start');

    // Messages for others across several declarations (each lasts 2 s on the server); alice stays listed as waiting.
    for (let i = 0; i < 4; i++) {
      await sleep(1200);
      await backend.messaging.sendMessage({ agentName: 'bob', roomName, message: `for anyone ${i}` });
      expect(await isWaiting(roomName, 'alice')).toBe(true);
    }
    await sleep(1000);
    expect(settled).toBe(false);
    expect(await isWaiting(roomName, 'alice')).toBe(true);

    const sent = await backend.messaging.sendMessage({ agentName: 'bob', roomName, message: 'finally @alice' });
    const result = await waiting;
    expect(result.messages.map((message) => message.id)).toEqual([sent.messageId]);
    expect(result.timedOut).toBe(false);

    // One wait: wait_start with the same requestId every 1.5 s, unaffected by the messages passed over, then wait_end and
    // a single read position past everything.
    const frames = proxy.clientFrameLog;
    const starts = frames.filter(({ frame }) => frame.type === 'wait_start');
    expect(starts.length).toBeGreaterThanOrEqual(4);
    expect(new Set(starts.map(({ frame }) => frame.requestId)).size).toBe(1);
    const intervals = starts.slice(1).map(({ at }, i) => at - starts[i]!.at);
    for (const interval of intervals) {
      expect(interval).toBeGreaterThanOrEqual(1400);
      expect(interval).toBeLessThan(1900);
    }
    const latestSeq = (await api.getMessages(roomName, { since: 0 })).latestSeq;
    expect(frames.slice(starts.length).map(({ frame }) => frame)).toEqual([
      { type: 'wait_end', requestId: starts[0]!.frame.requestId },
      { type: 'read', seq: latestSeq, requestId: expect.any(String) },
    ]);
    expect(backend.waits.stats.longPollRequests).toBe(0);
  }, 30000);

  it('with mentionsOnly over long polling, passes mentionsOnly on every long poll until a mention arrives', async () => {
    const roomName = 'mentions-long-poll';
    const backend = backendWith({ webSocketRetryCooldownMs: 1500 });
    await setupRoom(backend, roomName);
    proxy.webSocketPolicy = 'reject';

    let settled = false;
    const waiting = backend.messaging.waitForMessages({ agentName: 'alice', roomName, timeout: 0, mentionsOnly: true }).finally(() => {
      settled = true;
    });
    await waitUntil(() => isWaiting(roomName, 'alice'), 5000, 'alice waiting');
    await backend.messaging.sendMessage({ agentName: 'bob', roomName, message: 'for anyone' });
    // Several long-poll rounds (the WebSocket is tried again after each 1.5 s cooldown).
    await sleep(4000);
    expect(settled).toBe(false);
    await waitUntil(() => isWaiting(roomName, 'alice'), 3000, 'alice still waiting');

    const sent = await backend.messaging.sendMessage({ agentName: 'bob', roomName, message: 'now @alice' });
    const result = await waiting;
    expect(result.messages.map((message) => message.id)).toEqual([sent.messageId]);
    const polls = longPolls(roomName);
    expect(polls.length).toBeGreaterThanOrEqual(2);
    for (const poll of polls) {
      expect(queryOf(poll.path).get('mentionsOnly')).toBe('true');
      expect(queryOf(poll.path).get('agentName')).toBe('alice');
    }
    // After the first round, the rounds ask from after the message passed over.
    const forAnyoneSeq = (await api.getMessages(roomName, { since: 0 })).messages.find((m) => m.message === 'for anyone')!.seq;
    expect(Number(queryOf(polls[polls.length - 1]!.path).get('since'))).toBeGreaterThanOrEqual(forAnyoneSeq);
  }, 30000);

  it('connects again when agora restarts during the wait, and returns the message sent after the restart', async () => {
    const roomName = 'restart';
    const backend = backendWith({ webSocketRetryCooldownMs: 1000 });
    await setupRoom(backend, roomName);

    let settled = false;
    const waiting = backend.messaging.waitForMessages({ agentName: 'alice', roomName, timeout: 0 }).finally(() => {
      settled = true;
    });
    await waitUntil(() => isWaiting(roomName, 'alice'), 5000, 'alice waiting');
    // Longer than the cooldown: a connection that lasted is made again at once when it drops.
    await sleep(1500);
    const connectsBefore = backend.waits.stats.webSocketConnects;

    await agora.restart();
    await waitUntil(
      () => backend.waits.stats.webSocketConnects > connectsBefore && backend.waits.hasOpenSocket(roomName, 'alice'),
      45000,
      'connected again after the restart',
    );
    await waitUntil(() => isWaiting(roomName, 'alice'), 10000, 'alice waiting again');
    expect(settled).toBe(false);

    const sent = await backend.messaging.sendMessage({ agentName: 'bob', roomName, message: 'after the restart' });
    const result = await waiting;
    expect(result.messages.map((message) => message.id)).toEqual([sent.messageId]);
    expect(result.timedOut).toBe(false);
    expect(backend.waits.hasOpenSocket(roomName, 'alice')).toBe(true);
  }, 120000);

  it('declares the wait with long polls while the WebSocket cannot be established, and goes back to it once it can', async () => {
    const roomName = 'long-poll';
    const backend = backendWith({ webSocketRetryCooldownMs: 1500 });
    await setupRoom(backend, roomName);
    proxy.webSocketPolicy = 'reject';

    let settled = false;
    const waiting = backend.messaging.waitForMessages({ agentName: 'alice', roomName, timeout: 0 }).finally(() => {
      settled = true;
    });
    await sleep(7000);
    expect(settled).toBe(false);
    // Long poll after long poll, each one declaring alice's wait, and the WebSocket tried again after each cooldown.
    const polls = longPolls(roomName);
    expect(polls.length).toBeGreaterThanOrEqual(3);
    for (const poll of polls) {
      expect(queryOf(poll.path).get('agentName')).toBe('alice');
      expect(Number(queryOf(poll.path).get('wait'))).toBeGreaterThanOrEqual(1);
    }
    expect(proxy.countRequests('UPGRADE', `/rooms/${roomName}/ws`)).toBeGreaterThanOrEqual(3);
    await waitUntil(() => isWaiting(roomName, 'alice'), 3000, 'alice waiting over long polling');

    proxy.webSocketPolicy = 'pass';
    await waitUntil(() => backend.waits.hasOpenSocket(roomName, 'alice'), 10000, 'back on the WebSocket');
    await waitUntil(() => isWaiting(roomName, 'alice'), 5000, 'alice waiting over the WebSocket');
    const pollsBefore = longPolls(roomName).length;

    const sent = await backend.messaging.sendMessage({ agentName: 'bob', roomName, message: 'over the WebSocket again' });
    const result = await waiting;
    expect(result.messages.map((message) => message.id)).toEqual([sent.messageId]);
    expect(longPolls(roomName)).toHaveLength(pollsBefore);
  }, 60000);

  it('lets a newer call for the same agent and room take over, leaving the message to the newer call', async () => {
    const roomName = 'take-over';
    const backend = backendWith();
    await setupRoom(backend, roomName);

    const first = backend.messaging.waitForMessages({ agentName: 'alice', roomName, timeout: 0 });
    const firstOutcome = first.then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await waitUntil(() => isWaiting(roomName, 'alice'), 5000, 'alice waiting');

    const second = backend.messaging.waitForMessages({ agentName: 'alice', roomName, timeout: 0 });
    const error = await firstOutcome;
    expect(error).toBeInstanceOf(WaitCancelledError);
    expect((error as Error).message).toBe(
      'Waiting for messages ended without a result: a newer wait_for_messages call for the same agent and room took over',
    );
    await waitUntil(() => new Set(proxy.clientFrames.map((frame) => frame.requestId)).size === 2, 5000, 'second wait declared');
    await waitUntil(() => isWaiting(roomName, 'alice'), 5000, 'alice waiting again');

    const sent = await backend.messaging.sendMessage({ agentName: 'bob', roomName, message: 'for the newer call' });
    expect((await second).messages.map((message) => message.id)).toEqual([sent.messageId]);

    // The first wait was ended on the server before the second one was declared.
    const types = proxy.clientFrames.map((frame) => `${frame.type} ${frame.requestId === proxy.clientFrames[0]!.requestId ? 'first' : 'second'}`);
    const firstEnd = types.indexOf('wait_end first');
    expect(firstEnd).toBeGreaterThan(0);
    expect(types.slice(0, firstEnd).every((type) => type === 'wait_start first')).toBe(true);
    expect(types[firstEnd + 1]).toBe('wait_start second');
  }, 30000);

  it('ends at once without a result when its signal aborts, and consumes nothing', async () => {
    const roomName = 'cancelled';
    const backend = backendWith({ webSocketRetryCooldownMs: 60000 });
    await setupRoom(backend, roomName);
    // Over long polling the server marks what it returns read, so a cancelled call must not move the client cursor.
    proxy.webSocketPolicy = 'reject';
    proxy.delayResponses((r) => r.method === 'GET' && r.path.startsWith(`/rooms/${roomName}/messages?`) && queryOf(r.path).has('wait'), 1500);

    const controller = new AbortController();
    const waiting = backend.messaging.waitForMessages({ agentName: 'alice', roomName, timeout: 0 }, controller.signal);
    const outcome = waiting.then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await waitUntil(() => isWaiting(roomName, 'alice'), 5000, 'alice waiting');
    await backend.messaging.sendMessage({ agentName: 'bob', roomName, message: 'not consumed' });
    // agora has answered the long poll with the message (and marked it read); the answer is still on its way.
    await waitUntil(
      async () => ((await api.listMembers(roomName)).members.find((member) => member.agentName === 'alice')?.lastReadSeq ?? 0) > 0,
      3000,
      'marked read by the long poll',
    );
    const abortedAt = Date.now();
    controller.abort();
    expect(await outcome).toBeInstanceOf(WaitCancelledError);
    expect(Date.now() - abortedAt).toBeLessThan(500);

    proxy.reset();
    const next = await backend.messaging.waitForMessages({ agentName: 'alice', roomName, timeout: 3000 });
    expect(next.messages.map((message) => message.message)).toEqual(['not consumed']);
  }, 30000);
});
