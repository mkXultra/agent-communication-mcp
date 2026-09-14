// Test helper: the real MCP server (ToolRegistry) behind an in-memory transport.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { MemoryTransport } from '../../helpers/MemoryTransport.js';
import { ToolRegistry } from '../../../src/server/ToolRegistry.js';

export class McpCallError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data: { errorCode?: string } | undefined,
  ) {
    super(message);
    this.name = 'McpCallError';
  }
}

export interface PendingToolCall<T> {
  id: number;
  /** As {@link McpTestClient.call}; rejects with `Request timeout` when no response comes. */
  result: Promise<T>;
  /** Sends notifications/cancelled for the call, as an MCP client does when a tool call times out or is interrupted. */
  cancel(reason?: string): void;
}

export interface McpTestClient {
  registry: ToolRegistry;
  /** Calls a tool and returns the parsed JSON text content; JSON-RPC errors reject with {@link McpCallError}. */
  call<T = any>(name: string, args?: Record<string, unknown>): Promise<T>;
  /** Starts a tool call that can be cancelled. */
  start<T = any>(name: string, args?: Record<string, unknown>): PendingToolCall<T>;
  close(): Promise<void>;
}

let nextId = 1;

/**
 * Builds a server the way src/index.ts does. The operating mode is taken from the environment at this
 * point (AGENT_COMM_TOKEN -> cloud at AGENT_COMM_API_URL or the default URL, otherwise the given data directory).
 */
export async function createMcpClient(dataDir?: string): Promise<McpTestClient> {
  const server = new Server({ name: 'agent-communication', version: '1.0.0' }, { capabilities: { tools: {} } });
  const transport = new MemoryTransport();
  const registry = new ToolRegistry(dataDir);
  await server.connect(transport);
  await registry.registerAll(server);

  const start = <T>(name: string, args: Record<string, unknown> = {}): PendingToolCall<T> => {
    const id = nextId++;
    const result = (async () => {
      // MemoryTransport resolves with error responses too, although its type only describes results.
      const response = (await transport.simulateRequest({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: `agent_communication_${name}`, arguments: args },
      })) as unknown as {
        result?: { content: Array<{ text: string }> };
        error?: { code: number; message: string; data?: { errorCode?: string } };
      };
      if (response.error) {
        throw new McpCallError(response.error.code, response.error.message, response.error.data);
      }
      return JSON.parse(response.result!.content[0]!.text) as T;
    })();
    return {
      id,
      result,
      cancel(reason = 'cancelled by the test') {
        transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason } });
      },
    };
  };

  return {
    registry,
    call: (name, args) => start(name, args).result,
    start,
    async close() {
      await transport.close();
      await registry.shutdown();
    },
  };
}

/** Runs `fn` with some environment variables replaced (`undefined` removes one) and restores them afterwards. */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `condition` until it is true or `timeoutMs` passes. */
export async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 10000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(25);
  }
}
