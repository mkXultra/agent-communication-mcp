// Messages whose `message` frame does not fit the WebSocket frame limit (docs/api.yaml connectRoomSocket):
// agora does not send the frame but an `error` frame (PAYLOAD_TOO_LARGE, `details.seq`), stops the backlog at that
// message (`backlog_end.upToSeq` is the last one sent), and the client fetches the rest over HTTP.
//
// With the default 1 MB limit this cannot happen for a 10000-character message, so these tests run against the agora
// started with FAULT_INJECTION=1 and shrink MAX_WS_FRAME_BYTES with its `x-agora-test-vars` header. agora applies
// the header per request, so every request of these tests goes through the proxy that adds it.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { CloudApiClient, CloudBackend } from '../../src/cloud/index.js';
import { issueToken } from './harness/agora.js';
import { createMcpClient, McpCallError, withEnv, type McpTestClient } from './harness/mcp.js';
import { AgoraProxy } from './harness/proxy.js';

/** Room for a short `message` frame (about 270 bytes), not for one with a 1000-character message. */
const FRAME_LIMIT_BYTES = 800;
const BIG = (fill: string): string => fill.repeat(1000);

interface WaitResult {
  messages: Array<{ id: string; agentName: string; message: string }>;
  hasNewMessages: boolean;
  timedOut: boolean;
}

describe('messages that do not fit a WebSocket frame', () => {
  const faultAgoraUrl = inject('faultAgoraUrl');
  let token: string;
  let proxy: AgoraProxy;
  let api: CloudApiClient;
  let client: McpTestClient;

  beforeAll(async () => {
    token = await issueToken(faultAgoraUrl, 'oversized messages');
    proxy = await AgoraProxy.start(faultAgoraUrl);
    api = new CloudApiClient({ apiUrl: proxy.url, token });
  });

  afterAll(async () => {
    await proxy.close();
  });

  beforeEach(async () => {
    proxy.reset();
    proxy.extraHeaders = { 'x-agora-test-vars': JSON.stringify({ MAX_WS_FRAME_BYTES: String(FRAME_LIMIT_BYTES) }) };
    client = await withEnv({ AGENT_COMM_API_URL: proxy.url, AGENT_COMM_TOKEN: token }, () => createMcpClient());
  });

  afterEach(async () => {
    await client.close();
  });

  async function setupRoom(roomName: string): Promise<void> {
    await client.call('create_room', { roomName });
    await client.call('enter_room', { agentName: 'alice', roomName });
    await client.call('enter_room', { agentName: 'bob', roomName });
  }

  async function send(roomName: string, message: string): Promise<number> {
    const sent = await api.sendMessage(roomName, { agentName: 'bob', message, clientMessageId: `${roomName}-${message.slice(0, 20)}-${message.length}` });
    return sent.seq;
  }

  async function aliceReadSeq(roomName: string): Promise<number | undefined> {
    return (await api.listMembers(roomName)).members.find((m) => m.agentName === 'alice')!.lastReadSeq;
  }

  function fetches(roomName: string): string[] {
    return proxy.requests
      .filter((r) => r.method === 'GET' && r.path.startsWith(`/rooms/${roomName}/messages?since=`))
      .map((r) => r.path.slice(`/rooms/${roomName}/messages?`.length));
  }

  it('fetches the rest of a backlog that stopped at a message too large for a frame', async () => {
    await setupRoom('big-backlog');
    // alice has no connection yet: all four messages are backlog when she connects.
    await send('big-backlog', 'small 1');
    await send('big-backlog', BIG('b'));
    await send('big-backlog', 'small 3');
    const last = await send('big-backlog', 'small 4');

    const result = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'big-backlog', timeout: 3 });
    expect(result.messages.map((m) => m.message)).toEqual(['small 1', BIG('b'), 'small 3', 'small 4']);
    expect(result.timedOut).toBe(false);
    // The frame delivered seq 1; seq 2..4 came over HTTP in one request after backlog_end.upToSeq.
    expect(fetches('big-backlog')).toEqual(['since=1&limit=3']);

    // The read position covers what came over HTTP too, so another MCP process does not get them again.
    expect(await aliceReadSeq('big-backlog')).toBe(last);
    const fresh = new CloudBackend({ apiUrl: proxy.url, token });
    try {
      const again = await fresh.messaging.waitForMessages({ agentName: 'alice', roomName: 'big-backlog', timeout: 1000 });
      expect(again).toEqual({ messages: [], hasNewMessages: false, timedOut: true });
    } finally {
      await fresh.close();
    }
  });

  it('keeps a live message that could not be fetched and returns it on the next call', async () => {
    await setupRoom('big-live');
    await client.call('wait_for_messages', { agentName: 'alice', roomName: 'big-live', timeout: 1 });

    const failFetch = (path: string): boolean => path.startsWith('/rooms/big-live/messages?since=');
    proxy.headersFor = (r) => (r.method === 'GET' && failFetch(r.path) ? { 'x-agora-fault': 'room.internal' } : undefined);
    const seq = await send('big-live', BIG('L'));

    const failed = await client
      .call('wait_for_messages', { agentName: 'alice', roomName: 'big-live', timeout: 3 })
      .then(() => undefined, (e: unknown) => e);
    expect(failed).toBeInstanceOf(McpCallError);
    expect((failed as McpCallError).message).toMatch(/Injected fault/);
    expect(fetches('big-live')).toHaveLength(1);

    // agora works again: the message is still pending, fetched again and returned.
    proxy.headersFor = () => undefined;
    const result = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'big-live', timeout: 3 });
    expect(result.messages.map((m) => m.message)).toEqual([BIG('L')]);
    expect(fetches('big-live')).toHaveLength(2);
    expect(await aliceReadSeq('big-live')).toBe(seq);

    const fresh = new CloudBackend({ apiUrl: proxy.url, token });
    try {
      const again = await fresh.messaging.waitForMessages({ agentName: 'alice', roomName: 'big-live', timeout: 1000 });
      expect(again.messages).toEqual([]);
    } finally {
      await fresh.close();
    }
  });

  it('keeps every pending message when only one of the fetches fails', async () => {
    await setupRoom('big-partial');
    await client.call('wait_for_messages', { agentName: 'alice', roomName: 'big-partial', timeout: 1 });

    const first = await send('big-partial', BIG('1'));
    const second = await send('big-partial', BIG('2'));
    // Only the fetch of the second message fails.
    proxy.headersFor = (r) =>
      r.method === 'GET' && r.path.startsWith(`/rooms/big-partial/messages?since=${first}&`) ? { 'x-agora-fault': 'room.internal' } : undefined;

    const failed = await client
      .call('wait_for_messages', { agentName: 'alice', roomName: 'big-partial', timeout: 3 })
      .then(() => undefined, (e: unknown) => e);
    expect(failed).toBeInstanceOf(McpCallError);
    expect(fetches('big-partial')).toEqual([`since=${first - 1}&limit=1`, `since=${first}&limit=1`]);

    proxy.headersFor = () => undefined;
    const result = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName: 'big-partial', timeout: 3 });
    expect(result.messages.map((m) => m.message)).toEqual([BIG('1'), BIG('2')]);
    expect(await aliceReadSeq('big-partial')).toBe(second);
  });
});
