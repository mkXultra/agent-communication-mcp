// Server notices in cloud mode (agentName `system`, agora 0.8.0 / D18: docs/cloud-architecture.md §3.2 全員待機の通知,
// docs/api.yaml getMessages サーバーのお知らせ). agora posts one when every online member of a room has been waiting for
// ALL_WAITING_NOTICE_MS (15 minutes in production), delivers it like any other message and never filters it out with
// `excludeSelf` or `mentionsOnly`. The MCP server returns it the same way: over the WebSocket, over the long-polling
// fallback and from get_messages, with and without mentionsOnly. No client can use the name `system`.
//
// The real agora runs here with ALL_WAITING_NOTICE_MS=3000, so the notice comes 3 seconds after alice and bob both wait
// (or after a message sent while they do). alice's MCP server goes through a pass-through proxy that records the frames
// it sends; bob is an MCP server process of his own that talks to agora directly.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { CloudApiClient, CloudBackend } from '../../src/cloud/index.js';
import type { ApiMessage } from '../../src/cloud/types.js';
import { deleteAllRooms, issueToken, startAgora, type AgoraInstance } from './harness/agora.js';
import { createMcpClient, sleep, waitUntil, withEnv, type McpTestClient, type PendingToolCall } from './harness/mcp.js';
import { AgoraProxy } from './harness/proxy.js';

const NOTICE_AFTER_MS = 3000;

interface ToolMessage {
  id: string;
  agentName: string;
  roomName: string;
  message: string;
  timestamp: string;
  mentions: string[];
}

interface WaitResult {
  messages: ToolMessage[];
  hasNewMessages: boolean;
  timedOut: boolean;
  warning?: string;
  waitingAgents?: string[];
}

/** MessageService.waitForMessages (file mode) for one other waiting agent. */
const FILE_MODE_DEADLOCK_WARNING = 'Potential deadlock detected: 1 other agent(s) are also waiting for messages';

function queryOf(path: string): URLSearchParams {
  return new URL(path, 'http://proxy').searchParams;
}

/** A notice as the tools return it: the shape of any other message (a notice has no metadata and mentions nobody). */
function toolMessageOf(notice: ApiMessage): ToolMessage {
  return {
    id: notice.id,
    agentName: 'system',
    roomName: notice.roomName,
    message: notice.message,
    timestamp: notice.timestamp,
    mentions: [],
  };
}

/** The result of a tool call, or 'still waiting' if it has none after `ms` (the call is then cancelled). */
async function resultWithin<T>(call: PendingToolCall<T>, ms: number): Promise<T | 'still waiting'> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'still waiting'>((resolve) => {
    timer = setTimeout(() => resolve('still waiting'), ms);
  });
  try {
    const outcome = await Promise.race([call.result, late]);
    if (outcome === 'still waiting') call.cancel();
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

describe('server notices (agentName system) in cloud mode', () => {
  let agora: AgoraInstance;
  let token: string;
  let proxy: AgoraProxy;
  let api: CloudApiClient;
  let client: McpTestClient;
  let bob: CloudBackend;
  const controllers: AbortController[] = [];

  beforeAll(async () => {
    agora = await startAgora({ vars: { ALL_WAITING_NOTICE_MS: String(NOTICE_AFTER_MS) } });
    token = await issueToken(agora.url, 'server notices test');
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
    client = await withEnv({ AGENT_COMM_API_URL: proxy.url, AGENT_COMM_TOKEN: token }, () => createMcpClient());
    bob = new CloudBackend({ apiUrl: agora.url, token });
  });

  afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.abort();
    await client.close();
    await bob.close();
  });

  async function setupRoom(roomName: string): Promise<void> {
    await client.call('create_room', { roomName });
    await client.call('enter_room', { agentName: 'alice', roomName });
    await client.call('enter_room', { agentName: 'bob', roomName });
    proxy.reset();
  }

  async function member(roomName: string, agentName: string) {
    return (await api.listMembers(roomName)).members.find((candidate) => candidate.agentName === agentName)!;
  }

  function untilWaiting(roomName: string, agentName: string): Promise<void> {
    return waitUntil(async () => (await member(roomName, agentName)).waiting === true, 5000, `${agentName} waiting`);
  }

  /** The room's messages, oldest first, straight from agora. */
  async function stored(roomName: string): Promise<ApiMessage[]> {
    return (await api.getMessages(roomName, { since: 0, limit: 1000 })).messages;
  }

  async function notices(roomName: string): Promise<ApiMessage[]> {
    return (await stored(roomName)).filter((message) => message.agentName === 'system');
  }

  /** A wait in an MCP server process of the test (timeout in ms). It ends without a result when the test ends. */
  function waitIn(backend: CloudBackend, params: { agentName: string; roomName: string; timeout: number; mentionsOnly?: boolean }) {
    const controller = new AbortController();
    controllers.push(controller);
    const waiting = backend.messaging.waitForMessages(params, controller.signal);
    // A test that fails before it takes the result leaves the wait to the abort, which rejects it.
    waiting.catch(() => undefined);
    return waiting;
  }

  const bobWaits = (roomName: string, timeout: number) => waitIn(bob, { agentName: 'bob', roomName, timeout });

  /** alice and then bob wait until the all-waiting notice wakes them both; returns the notice. */
  async function produceNotice(roomName: string): Promise<ApiMessage> {
    const alice = client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName, timeout: 15 });
    await untilWaiting(roomName, 'alice');
    const results = await Promise.all([alice, bobWaits(roomName, 15000)]);
    const found = await notices(roomName);
    expect(found).toHaveLength(1);
    for (const result of results) expect(result.messages).toEqual([toolMessageOf(found[0]!)]);
    return found[0]!;
  }

  it('wakes every waiting agent over the WebSocket with the notice, a wait without a time limit included, and returns it once', async () => {
    const roomName = 'notice';
    await setupRoom(roomName);

    const alice = client.start<WaitResult>('wait_for_messages', { agentName: 'alice', roomName, timeout: 0 });
    await untilWaiting(roomName, 'alice');
    // bob's wait makes everyone in the room wait: agora posts the notice 3 seconds later.
    const bobResult = bobWaits(roomName, 20000);

    const result = await resultWithin(alice, 10000);
    const [notice, ...more] = await notices(roomName);
    expect(result).toEqual({ messages: [toolMessageOf(notice!)], hasNewMessages: true, timedOut: false });
    expect(notice).toMatchObject({ agentName: 'system', roomName, message: '全員が0分待機中です（alice, bob）', mentions: [] });
    expect(more).toEqual([]);
    expect(await bobResult).toEqual({
      messages: [toolMessageOf(notice!)],
      hasNewMessages: true,
      timedOut: false,
      warning: FILE_MODE_DEADLOCK_WARNING,
      waitingAgents: ['alice'],
    });

    // Delivered over alice's WebSocket, and read up to the notice like any message a wait returns.
    expect(proxy.requests.filter((r) => r.method === 'GET' && r.path.includes('/messages?'))).toEqual([]);
    const requestId = proxy.clientFrames[0]!.requestId;
    expect(proxy.clientFrames).toEqual([
      { type: 'wait_start', requestId, timeoutSeconds: 300 },
      { type: 'wait_end', requestId },
      { type: 'read', seq: notice!.seq, requestId: expect.any(String) },
    ]);
    expect((await member(roomName, 'alice')).lastReadSeq).toBe(notice!.seq);
    expect((await member(roomName, 'bob')).lastReadSeq).toBe(notice!.seq);

    // Returned again neither by this process (client cursor) nor by another one (server read position).
    const next = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName, timeout: 1 });
    expect(next).toEqual({ messages: [], hasNewMessages: false, timedOut: true });
    const other = new CloudBackend({ apiUrl: agora.url, token });
    try {
      const elsewhere = await other.messaging.waitForMessages({ agentName: 'alice', roomName, timeout: 1000 });
      expect(elsewhere).toEqual({ messages: [], hasNewMessages: false, timedOut: true });
    } finally {
      await other.close();
    }
  });

  it('with mentionsOnly over the WebSocket, returns the notice after passing over a message that mentions nobody, and reads up to the notice', async () => {
    const roomName = 'notice-mentions';
    await setupRoom(roomName);

    let settled = false;
    const settle = (): void => {
      settled = true;
    };
    const alice = client.start<WaitResult>('wait_for_messages', { agentName: 'alice', roomName, timeout: 0, mentionsOnly: true });
    alice.result.then(settle, settle);
    await untilWaiting(roomName, 'alice');
    const bobResult = bobWaits(roomName, 20000);
    await untilWaiting(roomName, 'bob');
    // Sent while everyone waits: alice's wait passes over it, and agora counts the 3 seconds from it.
    await bob.messaging.sendMessage({ agentName: 'bob', roomName, message: 'for anyone' });
    await sleep(1000);
    expect(settled).toBe(false);
    expect((await member(roomName, 'alice')).waiting).toBe(true);
    expect(proxy.clientFrames.map((frame) => frame.type)).toEqual(['wait_start']);
    expect(await notices(roomName)).toEqual([]);

    const result = await resultWithin(alice, 10000);
    const [passedOver, notice, ...rest] = await stored(roomName);
    expect(result).toEqual({ messages: [toolMessageOf(notice!)], hasNewMessages: true, timedOut: false });
    expect(passedOver).toMatchObject({ agentName: 'bob', message: 'for anyone', mentions: [] });
    expect(notice).toMatchObject({ agentName: 'system', message: '全員が0分待機中です（alice, bob）', mentions: [] });
    expect(rest).toEqual([]);
    expect((await bobResult).messages).toEqual([toolMessageOf(notice!)]);

    // As on a mention: one read position for the whole wait, past the message passed over and up to the notice.
    const requestId = proxy.clientFrames[0]!.requestId;
    expect(proxy.clientFrames).toEqual([
      { type: 'wait_start', requestId, timeoutSeconds: 300 },
      { type: 'wait_end', requestId },
      { type: 'read', seq: notice!.seq, requestId: expect.any(String) },
    ]);
    expect((await member(roomName, 'alice')).lastReadSeq).toBe(notice!.seq);

    // The next wait returns what comes after the notice, and neither the notice nor the message passed over.
    await bob.messaging.sendMessage({ agentName: 'bob', roomName, message: 'after the notice' });
    const next = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName, timeout: 3 });
    expect(next.messages.map((message) => message.message)).toEqual(['after the notice']);
  });

  it('returns the notice from the long-polling fallback, with and without mentionsOnly', async () => {
    const roomName = 'notice-long-poll';
    await setupRoom(roomName);
    // alice and bob wait in a process whose WebSocket upgrades are refused, so both wait with long polls.
    proxy.webSocketPolicy = 'reject';
    const longPolling = new CloudBackend({ apiUrl: proxy.url, token });
    const longPolls = (agentName: string) =>
      proxy.requests.filter(
        (r) =>
          r.method === 'GET' &&
          r.path.startsWith(`/rooms/${roomName}/messages?`) &&
          queryOf(r.path).get('agentName') === agentName &&
          queryOf(r.path).has('wait'),
      );
    try {
      const alice = waitIn(longPolling, { agentName: 'alice', roomName, timeout: 15000, mentionsOnly: true });
      await untilWaiting(roomName, 'alice');
      const bobResult = waitIn(longPolling, { agentName: 'bob', roomName, timeout: 15000 });
      await untilWaiting(roomName, 'bob');
      await longPolling.messaging.sendMessage({ agentName: 'bob', roomName, message: 'for anyone' });

      const [aliceResult, bobValue] = await Promise.all([alice, bobResult]);
      const [passedOver, notice, ...rest] = await stored(roomName);
      expect(aliceResult).toMatchObject({ messages: [toolMessageOf(notice!)], hasNewMessages: true, timedOut: false });
      expect(bobValue).toMatchObject({ messages: [toolMessageOf(notice!)], hasNewMessages: true, timedOut: false });
      expect(passedOver).toMatchObject({ agentName: 'bob', message: 'for anyone' });
      expect(notice).toMatchObject({ agentName: 'system', message: '全員が0分待機中です（alice, bob）', mentions: [] });
      expect(rest).toEqual([]);

      // Only long polls: alice's with mentionsOnly, bob's without. agora read alice up to the notice.
      expect(longPolling.waits.stats.webSocketConnects).toBe(0);
      expect(longPolls('alice').length).toBeGreaterThanOrEqual(1);
      expect(longPolls('bob').length).toBeGreaterThanOrEqual(1);
      for (const poll of longPolls('alice')) expect(queryOf(poll.path).get('mentionsOnly')).toBe('true');
      for (const poll of longPolls('bob')) expect(queryOf(poll.path).has('mentionsOnly')).toBe(false);
      expect((await member(roomName, 'alice')).lastReadSeq).toBe(notice!.seq);
    } finally {
      await longPolling.close();
    }
  });

  it('get_messages with mentionsOnly returns the notice with the messages that mention the agent', async () => {
    const roomName = 'notice-get-messages';
    await setupRoom(roomName);
    await client.call('send_message', { agentName: 'bob', roomName, message: 'before, for @alice' });
    await client.call('send_message', { agentName: 'bob', roomName, message: 'before, for anyone' });
    // alice reads them, so that her next wait waits for the notice.
    const read = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName, timeout: 1 });
    expect(read.messages).toHaveLength(2);
    const notice = await produceNotice(roomName);
    await client.call('send_message', { agentName: 'bob', roomName, message: 'after, for @alice' });
    await client.call('send_message', { agentName: 'alice', roomName, message: 'after, for @bob' });

    const forAlice = await client.call('get_messages', { agentName: 'alice', roomName, mentionsOnly: true });
    expect(forAlice).toEqual({
      roomName,
      messages: [
        expect.objectContaining({ agentName: 'bob', message: 'after, for @alice' }),
        toolMessageOf(notice),
        expect.objectContaining({ agentName: 'bob', message: 'before, for @alice' }),
      ],
      count: 3,
      hasMore: false,
    });
    // offset and limit count the notice like the mentions.
    expect(await client.call('get_messages', { agentName: 'alice', roomName, mentionsOnly: true, limit: 1, offset: 1 })).toEqual({
      roomName,
      messages: [toolMessageOf(notice)],
      count: 1,
      hasMore: true,
    });
    const forBob = await client.call('get_messages', { agentName: 'bob', roomName, mentionsOnly: true });
    expect(forBob.messages.map((message: ToolMessage) => message.message)).toEqual(['after, for @bob', notice.message]);
    // Without mentionsOnly, the notice is one of the room's messages like before.
    const all = await client.call('get_messages', { agentName: 'alice', roomName });
    expect(all.messages.map((message: ToolMessage) => message.agentName)).toEqual(['alice', 'bob', 'system', 'bob', 'bob']);
  });

  it('leaves the name system to the notices: no agent enters, sends or waits as system', async () => {
    const roomName = 'notice-reserved';
    await setupRoom(roomName);
    // agora refuses the name with a VALIDATION_ERROR (400), which the tools report as invalid params.
    const refusal = `Validation failed for field 'request': agentName "system" is reserved for server notices`;
    for (const [tool, args] of [
      ['enter_room', { agentName: 'system', roomName }],
      ['send_message', { agentName: 'system', roomName, message: 'not a notice' }],
      ['wait_for_messages', { agentName: 'system', roomName, timeout: 1 }],
    ] as const) {
      await expect(client.call(tool, args)).rejects.toMatchObject({
        code: ErrorCode.InvalidParams,
        message: `MCP error ${ErrorCode.InvalidParams}: ${refusal}`,
      });
    }
    await expect(bob.rooms.enterRoom({ agentName: 'system', roomName })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      message: refusal,
    });
    expect(await stored(roomName)).toEqual([]);
    expect((await api.listMembers(roomName)).members.map((m) => m.agentName).sort()).toEqual(['alice', 'bob']);
  });
});
