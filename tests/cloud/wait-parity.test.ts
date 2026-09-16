// wait_for_messages gives the same result in file mode and in cloud mode for the same sequence of tool calls
// (docs/cloud-architecture.md G4). Each scenario runs once against a file-mode server on a temporary data directory
// and once against a cloud-mode server on the real agora; the results are compared without ids and timestamps.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { CloudApiClient } from '../../src/cloud/index.js';
import { createMcpClient, waitUntil, withEnv, type McpTestClient } from './harness/mcp.js';

const apiUrl = process.env.AGENT_COMM_API_URL!;
const token = process.env.AGENT_COMM_TOKEN!;

interface WaitResult {
  messages: Array<{ id: string; agentName: string; roomName: string; message: string; timestamp: string; mentions: string[] }>;
  hasNewMessages: boolean;
  timedOut: boolean;
  warning?: string;
  waitingAgents?: string[];
}

interface Mode {
  name: 'file' | 'cloud';
  client: McpTestClient;
  /** Resolves once the agent is registered as waiting in the room. */
  untilWaiting(roomName: string, agentName: string): Promise<void>;
}

function withoutIds(result: WaitResult) {
  return {
    ...result,
    messages: result.messages.map(({ agentName, roomName, message, mentions }) => ({ agentName, roomName, message, mentions })),
  };
}

describe('wait_for_messages: the same results in file mode and cloud mode', () => {
  let dataDir: string;
  const clients: McpTestClient[] = [];

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-comm-parity-'));
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  async function fileMode(): Promise<Mode> {
    const client = await withEnv({ AGENT_COMM_DATA_DIR: dataDir, AGENT_COMM_API_URL: undefined, AGENT_COMM_TOKEN: undefined }, () =>
      createMcpClient(dataDir),
    );
    clients.push(client);
    expect(client.registry.mode).toBe('file');
    return {
      name: 'file',
      client,
      untilWaiting: (roomName, agentName) =>
        waitUntil(async () => {
          const file = path.join(dataDir, 'rooms', roomName, 'waiting_agents.json');
          const waiting = await fs.readFile(file, 'utf8').then((text) => JSON.parse(text) as Array<{ agentName: string }>, () => []);
          return waiting.some((entry) => entry.agentName === agentName);
        }, 10000, `${agentName} waiting (file mode)`),
    };
  }

  async function cloudMode(): Promise<Mode> {
    const client = await createMcpClient();
    clients.push(client);
    expect(client.registry.mode).toBe('cloud');
    const api = new CloudApiClient({ apiUrl, token });
    return {
      name: 'cloud',
      client,
      untilWaiting: (roomName, agentName) =>
        waitUntil(async () => {
          const members = await api.listMembers(roomName);
          return members.members.some((member) => member.agentName === agentName && member.waiting === true);
        }, 10000, `${agentName} waiting (cloud mode)`),
    };
  }

  async function inBothModes<T>(scenario: (mode: Mode) => Promise<T>): Promise<{ file: T; cloud: T }> {
    const file = await scenario(await fileMode());
    const cloud = await scenario(await cloudMode());
    return { file, cloud };
  }

  it('reports the same deadlock warning and waiting agents', async () => {
    const { file, cloud } = await inBothModes(async ({ client, untilWaiting }) => {
      const roomName = 'parity-deadlock';
      await client.call('create_room', { roomName });
      for (const agentName of ['alice', 'bob', 'carol']) await client.call('enter_room', { agentName, roomName });

      const alice = client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName, timeout: 15 });
      await untilWaiting(roomName, 'alice');
      const bob = client.call<WaitResult>('wait_for_messages', { agentName: 'bob', roomName, timeout: 15 });
      await untilWaiting(roomName, 'bob');
      await client.call('send_message', { agentName: 'carol', roomName, message: 'wake up @alice @bob' });
      return { alice: withoutIds(await alice), bob: withoutIds(await bob) };
    });

    expect(cloud).toEqual(file);
    expect(cloud.bob.warning).toBe('Potential deadlock detected: 1 other agent(s) are also waiting for messages');
    expect(cloud.bob.waitingAgents).toEqual(['alice']);
    expect(cloud.alice.warning).toBeUndefined();
    expect(cloud.bob.messages.map((m) => m.message)).toEqual(['wake up @alice @bob']);
  }, 60000);

  it('with mentionsOnly, returns only the mentions, keeps the agent listed as waiting and reads what it passed over', async () => {
    const { file, cloud } = await inBothModes(async ({ client, untilWaiting }) => {
      const roomName = 'parity-mentions';
      await client.call('create_room', { roomName });
      for (const agentName of ['alice', 'bob', 'carol']) await client.call('enter_room', { agentName, roomName });

      const alice = client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName, timeout: 15, mentionsOnly: true });
      await untilWaiting(roomName, 'alice');
      await client.call('send_message', { agentName: 'carol', roomName, message: 'question for anyone' });
      await client.call('send_message', { agentName: 'carol', roomName, message: 'and one for @bob' });
      // bob gets carol's messages at once; alice passes over them and is still waiting.
      const bob = await client.call<WaitResult>('wait_for_messages', { agentName: 'bob', roomName, timeout: 5 });
      await client.call('send_message', { agentName: 'bob', roomName, message: 'answered, @alice' });
      const first = await alice;
      const second = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName, timeout: 1 });
      return { bob: withoutIds(bob), alice: [first, second].map(withoutIds) };
    });

    expect(cloud).toEqual(file);
    expect(cloud.bob.messages.map((m) => m.message)).toEqual(['question for anyone', 'and one for @bob']);
    expect(cloud.bob.waitingAgents).toEqual(['alice']);
    expect(cloud.bob.warning).toBe('Potential deadlock detected: 1 other agent(s) are also waiting for messages');
    expect(cloud.alice[0]!.messages).toEqual([{ agentName: 'bob', roomName: 'parity-mentions', message: 'answered, @alice', mentions: ['alice'] }]);
    expect(cloud.alice[0]).toMatchObject({ hasNewMessages: true, timedOut: false });
    expect(cloud.alice[0]!.warning).toBeUndefined();
    expect(cloud.alice[1]).toEqual({ messages: [], hasNewMessages: false, timedOut: true });
  }, 60000);

  it('returns what others sent before the agent spoke, then only what is new', async () => {
    const { file, cloud } = await inBothModes(async ({ client }) => {
      const roomName = 'parity-reply';
      await client.call('create_room', { roomName });
      await client.call('enter_room', { agentName: 'alice', roomName });
      await client.call('enter_room', { agentName: 'bob', roomName });
      await client.call('send_message', { agentName: 'bob', roomName, message: 'question 1' });
      await client.call('send_message', { agentName: 'alice', roomName, message: 'answer 0' });
      const first = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName, timeout: 3 });
      await client.call('send_message', { agentName: 'bob', roomName, message: 'question 2' });
      await client.call('send_message', { agentName: 'alice', roomName, message: 'answer 1' });
      const second = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName, timeout: 3 });
      const third = await client.call<WaitResult>('wait_for_messages', { agentName: 'alice', roomName, timeout: 1 });
      return [first, second, third].map(withoutIds);
    });

    expect(cloud).toEqual(file);
    expect(cloud.map((result) => result.messages.map((m) => m.message))).toEqual([['question 1'], ['question 2'], []]);
    expect(cloud[2]).toEqual({ messages: [], hasNewMessages: false, timedOut: true });
  }, 60000);
});
