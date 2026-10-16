// wait_for_messages end to end: each agent acts on its own MCP server instance. enter_room selects the acting name
// for one room and instance, so two names in one room need two connections. send_message and wait_for_messages both
// take no agentName: they act as the name enter_room selected for the room and connection.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { MemoryTransport } from '../helpers/MemoryTransport.js';
import { ToolRegistry } from '../../src/server/ToolRegistry.js';
import path from 'path';
import { promises as fs } from 'fs';

const testDataDir = path.join(process.cwd(), 'e2e-wait-test-' + Date.now());

interface PendingCall {
  id: number;
  /** Never rejects on a response error; use {@link ToolClient.call} for that. */
  result: Promise<unknown>;
  cancel(reason?: string): void;
}

interface ToolClient {
  call(name: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<any>;
  response(name: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<any>;
  start(name: string, args?: Record<string, unknown>, timeoutMs?: number): PendingCall;
  close(): Promise<void>;
}

const clients: ToolClient[] = [];

async function connect(): Promise<ToolClient> {
  const server = new Server({ name: 'agent-communication', version: '1.0.0' }, { capabilities: { tools: {} } });
  const transport = new MemoryTransport();
  const registry = new ToolRegistry(testDataDir);
  await server.connect(transport);
  await registry.registerAll(server);
  let nextId = 1;

  const send = (name: string, args: Record<string, unknown>, timeoutMs?: number) =>
    transport.simulateRequest(
      { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: `agent_communication_${name}`, arguments: args } },
      timeoutMs,
    );

  const client: ToolClient = {
    async response(name, args = {}, timeoutMs) {
      return send(name, args, timeoutMs);
    },
    async call(name, args = {}, timeoutMs) {
      const response = await send(name, args, timeoutMs);
      if (response.error) throw new Error(response.error.message);
      return JSON.parse(response.result!.content[0].text);
    },
    start(name, args = {}, timeoutMs) {
      const id = nextId++;
      const result = transport.simulateRequest(
        { jsonrpc: '2.0', id, method: 'tools/call', params: { name: `agent_communication_${name}`, arguments: args } },
        timeoutMs,
      );
      return {
        id,
        result,
        cancel(reason = 'cancelled by the test') {
          transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason } });
        },
      };
    },
    async close() {
      await transport.close();
      await registry.shutdown();
    },
  };
  clients.push(client);
  return client;
}

/** Creates the room and returns one entered connection per agent (the acting name is per instance and room). */
async function setupRoom(roomName: string, agents: string[]): Promise<Map<string, ToolClient>> {
  const host = await connect();
  await host.call('create_room', { roomName });
  const byAgent = new Map<string, ToolClient>();
  for (const agentName of agents) {
    const client = await connect();
    await client.call('enter_room', { agentName, roomName });
    byAgent.set(agentName, client);
  }
  return byAgent;
}

describe('Wait For Messages E2E Tests', () => {
  beforeAll(async () => {
    await fs.mkdir(testDataDir, { recursive: true });
    process.env.AGENT_COMM_DATA_DIR = testDataDir;
  });

  afterAll(async () => {
    try {
      await fs.rm(testDataDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    delete process.env.AGENT_COMM_DATA_DIR;
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    // Leave a clean data directory for the next test.
    try {
      const files = await fs.readdir(testDataDir);
      await Promise.all(files.map((file) => fs.rm(path.join(testDataDir, file), { recursive: true, force: true })));
    } catch {
      // Ignore if the directory does not exist
    }
    await fs.mkdir(path.join(testDataDir, 'rooms'), { recursive: true });
  });

  describe('Wait For Messages Basic Functionality', () => {
    it('should return immediately if messages are already available', async () => {
      const room = await setupRoom('wait-test-room', ['sender', 'waiter']);
      await room.get('sender')!.call('send_message', { roomName: 'wait-test-room', message: 'Hello waiter!' });

      const startTime = Date.now();
      const result = await room.get('waiter')!.call('wait_for_messages', { roomName: 'wait-test-room',
        timeout: 5,
      });
      const duration = Date.now() - startTime;

      expect(result.hasNewMessages).toBe(true);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].message).toBe('Hello waiter!');
      expect(duration).toBeLessThan(1000); // Should return almost immediately
    });

    it('should wait for new messages and return when they arrive', async () => {
      const room = await setupRoom('wait-test-room-2', ['sender2', 'waiter2']);
      const sender = room.get('sender2')!;
      const waiter = room.get('waiter2')!;

      const startTime = Date.now();
      const waiting = waiter.call('wait_for_messages', { roomName: 'wait-test-room-2', timeout: 5 });
      setTimeout(() => {
        void sender.call('send_message', { roomName: 'wait-test-room-2', message: 'New message arrived!' });
      }, 500);

      const result = await waiting;
      const duration = Date.now() - startTime;

      expect(result.hasNewMessages).toBe(true);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].message).toBe('New message arrived!');
      expect(duration).toBeGreaterThanOrEqual(500);
      expect(duration).toBeLessThan(2000);
    });

    it('should timeout when no new messages arrive', async () => {
      await setupRoom('timeout-room', ['lonely-waiter']);
      const waiter = clients[clients.length - 1]!;

      const startTime = Date.now();
      const result = await waiter.call('wait_for_messages', { roomName: 'timeout-room', timeout: 2 });
      const duration = Date.now() - startTime;

      expect(result.hasNewMessages).toBe(false);
      expect(result.messages).toHaveLength(0);
      expect(duration).toBeGreaterThanOrEqual(2000);
      expect(duration).toBeLessThan(3000);
    });
  });

  describe('Wait For Messages Concurrent Scenarios', () => {
    it('should handle multiple agents waiting simultaneously', async () => {
      const agents = ['waiter-1', 'waiter-2', 'waiter-3', 'sender'];
      const room = await setupRoom('multi-wait-room', agents);

      const startTime = Date.now();
      const waits = ['waiter-1', 'waiter-2', 'waiter-3'].map((agentName) =>
        room.get(agentName)!.call('wait_for_messages', { roomName: 'multi-wait-room', timeout: 5 }),
      );
      setTimeout(() => {
        void room.get('sender')!.call('send_message', { roomName: 'multi-wait-room', message: 'Wake up everyone!' });
      }, 1000);

      const results = await Promise.all(waits);
      expect(Date.now() - startTime).toBeGreaterThanOrEqual(1000);
      results.forEach((result) => {
        expect(result.hasNewMessages).toBe(true);
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].message).toBe('Wake up everyone!');
      });
    });

    it('should track read status correctly across multiple wait calls', async () => {
      const room = await setupRoom('timing-test-room', ['timing-sender', 'timing-waiter']);
      const sender = room.get('timing-sender')!;
      const waiter = room.get('timing-waiter')!;

      await sender.call('send_message', { roomName: 'timing-test-room', message: 'First message' });
      const first = await waiter.call('wait_for_messages', { roomName: 'timing-test-room', timeout: 1 });
      expect(first.hasNewMessages).toBe(true);
      expect(first.messages).toHaveLength(1);
      expect(first.messages[0].message).toBe('First message');

      const startTime = Date.now();
      const waiting = waiter.call('wait_for_messages', { roomName: 'timing-test-room', timeout: 3 });
      setTimeout(() => {
        void sender.call('send_message', { roomName: 'timing-test-room', message: 'Second message' });
      }, 1000);

      const result = await waiting;
      const duration = Date.now() - startTime;
      expect(result.hasNewMessages).toBe(true);
      expect(result.messages).toHaveLength(1); // Only the new message
      expect(result.messages[0].message).toBe('Second message');
      expect(duration).toBeGreaterThanOrEqual(1000);
      expect(duration).toBeLessThan(2000);
    });
  });

  describe('Wait For Messages Timeout Range', () => {
    it('should wait without a time limit (timeout 0) until a message arrives', async () => {
      const room = await setupRoom('no-limit-room', ['sender', 'waiter']);

      let settled = false;
      const startTime = Date.now();
      const waiting = room
        .get('waiter')!
        .call('wait_for_messages', { roomName: 'no-limit-room', timeout: 0 })
        .finally(() => {
          settled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(settled).toBe(false);

      await room.get('sender')!.call('send_message', { roomName: 'no-limit-room', message: 'Worth the wait' });
      const result = await waiting;
      expect(Date.now() - startTime).toBeGreaterThanOrEqual(3000);
      expect(result.hasNewMessages).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.messages.map((m: { message: string }) => m.message)).toEqual(['Worth the wait']);
    });

    it('should accept a timeout of 300 seconds and reject 301', async () => {
      const room = await setupRoom('max-timeout-room', ['sender', 'waiter']);
      const waiter = room.get('waiter')!;

      const waiting = waiter.call('wait_for_messages', { roomName: 'max-timeout-room', timeout: 300 });
      setTimeout(() => {
        void room.get('sender')!.call('send_message', { roomName: 'max-timeout-room', message: 'Within 300 seconds' });
      }, 500);
      const result = await waiting;
      expect(result.messages.map((m: { message: string }) => m.message)).toEqual(['Within 300 seconds']);

      await expect(waiter.call('wait_for_messages', { roomName: 'max-timeout-room', timeout: 301 })).rejects.toThrow(
        "Validation failed for field 'timeout': Timeout cannot exceed 300000ms",
      );
    });

    it('should wait 30 seconds when no timeout is given', async () => {
      const room = await setupRoom('default-timeout-room', ['sender', 'waiter']);

      const startTime = Date.now();
      const result = await room
        .get('waiter')!
        .call('wait_for_messages', { roomName: 'default-timeout-room' }, 40000);
      const duration = Date.now() - startTime;

      expect(result).toEqual({ messages: [], hasNewMessages: false, timedOut: true });
      expect(duration).toBeGreaterThanOrEqual(30000);
      expect(duration).toBeLessThan(33000);
    }, 45000);

    it('should end a wait whose request was cancelled and leave the next message for the next call', async () => {
      const room = await setupRoom('cancelled-wait-room', ['sender', 'waiter']);
      const waiter = room.get('waiter')!;

      const pending = waiter.start('wait_for_messages', { roomName: 'cancelled-wait-room', timeout: 0 }, 10000);
      let answered = false;
      void pending.result.then(
        () => {
          answered = true;
        },
        () => undefined,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // What an MCP client sends when a tool call times out or the user interrupts it
      pending.cancel('client timeout');

      // A wait still running would pick this message up within a second and mark it read.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await room.get('sender')!.call('send_message', { roomName: 'cancelled-wait-room', message: 'For the next call' });
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const startTime = Date.now();
      const result = await waiter.call('wait_for_messages', { roomName: 'cancelled-wait-room', timeout: 5 });
      expect(result.messages.map((m: { message: string }) => m.message)).toEqual(['For the next call']);
      expect(Date.now() - startTime).toBeLessThan(1000);
      // No response is sent for a cancelled request.
      expect(answered).toBe(false);
    });
  });

  describe('Wait For Messages Mentions Only', () => {
    const texts = (result: { messages: Array<{ message: string }> }) => result.messages.map((m) => m.message);
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it('should wait through messages that do not mention the agent and return on a mention', async () => {
      const roomName = 'mentions-room';
      const room = await setupRoom(roomName, ['sender', 'other', 'waiter']);

      const startTime = Date.now();
      const waiting = room.get('waiter')!.call('wait_for_messages', { roomName, timeout: 10, mentionsOnly: true });
      await sleep(500);
      await room.get('sender')!.call('send_message', { roomName, message: 'A question for anyone' });
      await room.get('other')!.call('send_message', { roomName, message: 'Over to you @sender' });
      await sleep(1500);
      await room.get('sender')!.call('send_message', { roomName, message: 'Your turn @waiter' });

      const result = await waiting;
      expect(Date.now() - startTime).toBeGreaterThanOrEqual(2000);
      expect(result).toEqual({
        messages: [expect.objectContaining({ agentName: 'sender', message: 'Your turn @waiter', mentions: ['waiter'] })],
        hasNewMessages: true,
        timedOut: false,
      });

      // The messages it passed over are read: the next wait, without mentionsOnly, does not return them
      const next = await room.get('waiter')!.call('wait_for_messages', { roomName, timeout: 1 });
      expect(next).toEqual({ messages: [], hasNewMessages: false, timedOut: true });
    });

    it('should time out with only messages that do not mention the agent, and not return them again', async () => {
      const roomName = 'mentions-timeout-room';
      const room = await setupRoom(roomName, ['sender', 'other', 'waiter']);

      const startTime = Date.now();
      const waiting = room.get('waiter')!.call('wait_for_messages', { roomName, timeout: 3, mentionsOnly: true });
      await sleep(500);
      await room.get('sender')!.call('send_message', { roomName, message: 'For anyone' });
      await room.get('other')!.call('send_message', { roomName, message: 'For @sender' });

      const result = await waiting;
      expect(Date.now() - startTime).toBeGreaterThanOrEqual(3000);
      expect(result).toEqual({ messages: [], hasNewMessages: false, timedOut: true });

      const next = await room.get('waiter')!.call('wait_for_messages', { roomName, timeout: 1 });
      expect(next).toEqual({ messages: [], hasNewMessages: false, timedOut: true });
    });

    it('should return only the mentions among messages that are already unread', async () => {
      const roomName = 'mentions-unread-room';
      const room = await setupRoom(roomName, ['sender', 'other', 'waiter']);
      await room.get('sender')!.call('send_message', { roomName, message: 'Before: for anyone' });
      await room.get('other')!.call('send_message', { roomName, message: '@waiter first' });
      await room.get('sender')!.call('send_message', { roomName, message: 'After: for anyone' });

      const startTime = Date.now();
      const result = await room.get('waiter')!.call('wait_for_messages', { roomName, timeout: 5, mentionsOnly: true });
      expect(Date.now() - startTime).toBeLessThan(1000);
      expect(texts(result)).toEqual(['@waiter first']);

      const next = await room.get('waiter')!.call('wait_for_messages', { roomName, timeout: 1 });
      expect(next).toEqual({ messages: [], hasNewMessages: false, timedOut: true });
    });

    it('should return every new message when mentionsOnly is false or left out', async () => {
      const roomName = 'mentions-default-room';
      const room = await setupRoom(roomName, ['sender', 'other', 'waiter']);

      await room.get('sender')!.call('send_message', { roomName, message: 'For anyone' });
      const explicit = await room.get('waiter')!.call('wait_for_messages', { roomName, timeout: 3, mentionsOnly: false });
      expect(texts(explicit)).toEqual(['For anyone']);

      await room.get('other')!.call('send_message', { roomName, message: 'Also for anyone' });
      const leftOut = await room.get('waiter')!.call('wait_for_messages', { roomName, timeout: 3 });
      expect(texts(leftOut)).toEqual(['Also for anyone']);
    });
  });

  describe('Wait For Messages Error Handling', () => {
    it('directs a connection that has not entered the room to enter_room', async () => {
      const client = await connect();
      const response = await client.response('wait_for_messages', { roomName: 'non-existent-room', timeout: 1 });

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32602);
      expect(response.error!.message).toContain("has not entered room 'non-existent-room'");
    });

    it('rejects an explicit agentName even when the connection entered the room', async () => {
      const host = await connect();
      await host.call('create_room', { roomName: 'restricted-wait-room' });
      await host.call('enter_room', { agentName: 'alice', roomName: 'restricted-wait-room' });

      const response = await host.response('wait_for_messages', { agentName: 'outsider', roomName: 'restricted-wait-room', timeout: 1 });
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32602);
      expect(response.error!.message).toContain("'agentName' is not an input of agent_communication_wait_for_messages");
    });
  });
});
