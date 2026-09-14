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

export interface McpTestClient {
  registry: ToolRegistry;
  /** Calls a tool and returns the parsed JSON text content; JSON-RPC errors reject with {@link McpCallError}. */
  call<T = any>(name: string, args?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

let nextId = 1;

/**
 * Builds a server the way src/index.ts does. The operating mode is taken from the environment at this
 * point (AGENT_COMM_API_URL + AGENT_COMM_TOKEN -> cloud, otherwise the given data directory).
 */
export async function createMcpClient(dataDir?: string): Promise<McpTestClient> {
  const server = new Server({ name: 'agent-communication', version: '1.0.0' }, { capabilities: { tools: {} } });
  const transport = new MemoryTransport();
  const registry = new ToolRegistry(dataDir);
  await server.connect(transport);
  await registry.registerAll(server);

  return {
    registry,
    async call(name, args = {}) {
      // MemoryTransport resolves with error responses too, although its type only describes results.
      const response = (await transport.simulateRequest({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name: `agent_communication_${name}`, arguments: args },
      })) as unknown as {
        result?: { content: Array<{ text: string }> };
        error?: { code: number; message: string; data?: { errorCode?: string } };
      };
      if (response.error) {
        throw new McpCallError(response.error.code, response.error.message, response.error.data);
      }
      return JSON.parse(response.result!.content[0]!.text);
    },
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
