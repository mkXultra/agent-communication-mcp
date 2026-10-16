// Room identity over a real stdio MCP server in file mode: what an MCP client sees, in a separate process, for the
// published schemas and the enter -> send/wait -> switch -> leave -> restart lifecycle. The in-process tests
// (room-identity.test.ts) drive the same handlers over a MemoryTransport; this one runs `tsx src/index.ts` and talks
// JSON-RPC to its stdin/stdout, so the stdio entry point and the file-mode wiring are exercised too.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const REPO_ROOT = process.cwd();
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

/** An MCP server the test starts as a client would: a child process with JSON-RPC on its stdin/stdout. */
class StdioServer {
  stderr = '';
  /** Every line written to stdout (the MCP channel), parsed or not. */
  readonly stdoutLines: string[] = [];
  private stdout = '';
  private nextId = 1;
  private readonly pending = new Map<number, (message: any) => void>();
  private readonly exited: Promise<number | null>;

  constructor(readonly process: ChildProcess) {
    process.stdout!.setEncoding('utf8');
    process.stdout!.on('data', (chunk: string) => {
      this.stdout += chunk;
      let newline: number;
      while ((newline = this.stdout.indexOf('\n')) >= 0) {
        const line = this.stdout.slice(0, newline).trim();
        this.stdout = this.stdout.slice(newline + 1);
        if (!line) continue;
        this.stdoutLines.push(line);
        let message: { id?: number };
        try {
          message = JSON.parse(line);
        } catch {
          continue; // Not JSON-RPC: kept in stdoutLines for the assertions.
        }
        if (message.id === undefined) continue;
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      }
    });
    process.stderr!.setEncoding('utf8');
    process.stderr!.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
    this.exited = new Promise((resolve) => process.once('exit', (code) => resolve(code)));
  }

  static async start(env: Record<string, string | undefined>): Promise<StdioServer> {
    const child = spawn(TSX, ['src/index.ts'], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    const server = new StdioServer(child);
    await waitUntil(() => server.stderr.includes('Agent Communication MCP Server started on stdio'), 20000, 'server start');
    await server.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'room-identity-stdio-test', version: '1.0.0' },
    });
    server.notify('notifications/initialized');
    return server;
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 20000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.process.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    this.process.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  async tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const response = await this.request('tools/call', { name: `agent_communication_${name}`, arguments: args });
    if (response.error) throw new Error(`${name}: ${response.error.message}`);
    return JSON.parse(response.result.content[0].text);
  }

  async stop(): Promise<void> {
    if (this.process.exitCode !== null) return;
    this.process.kill('SIGTERM');
    const exited = await Promise.race([
      this.exited,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    if (exited === null && this.process.exitCode === null) this.process.kill('SIGKILL');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

describe('room identity over stdio in file mode', () => {
  let dataDir: string;
  const started: StdioServer[] = [];

  async function start(): Promise<StdioServer> {
    const server = await StdioServer.start({
      AGENT_COMM_TOKEN: undefined,
      AGENT_COMM_API_URL: undefined,
      AGENT_COMM_DATA_DIR: dataDir,
    });
    started.push(server);
    return server;
  }

  /** Polls until the file-mode wait registered `agentName` in the room's waiting_agents.json. */
  async function waitUntilWaiting(roomName: string, agentName: string): Promise<void> {
    const file = path.join(dataDir, 'rooms', roomName, 'waiting_agents.json');
    await waitUntil(
      async () => {
        try {
          const waiting = JSON.parse(await fs.readFile(file, 'utf8')) as Array<{ agentName: string }>;
          return waiting.some((entry) => entry.agentName === agentName);
        } catch {
          return false;
        }
      },
      5000,
      `wait of '${agentName}' to register in '${roomName}'`,
    );
  }

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-comm-identity-stdio-'));
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((server) => server.stop()));
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('publishes the identity contract and runs enter -> send/wait -> switch -> leave -> restart', async () => {
    const roomName = 'stdio-identity';
    const server = await start();

    // tools/list: the published schemas take no agentName and keep the other inputs.
    const listed = await server.request('tools/list');
    const tools = listed.result.tools as Array<{ name: string; inputSchema: any }>;
    const send = tools.find((tool) => tool.name === 'agent_communication_send_message')!;
    expect(Object.keys(send.inputSchema.properties)).toEqual(['roomName', 'message']);
    expect(send.inputSchema.required).toEqual(['roomName', 'message']);
    expect(send.inputSchema.additionalProperties).toBe(false);
    const wait = tools.find((tool) => tool.name === 'agent_communication_wait_for_messages')!;
    expect(Object.keys(wait.inputSchema.properties)).toEqual(['roomName', 'timeout', 'mentionsOnly']);
    expect(wait.inputSchema.required).toEqual(['roomName']);
    expect(wait.inputSchema.additionalProperties).toBe(false);

    // enter_room is required on this connection first.
    await server.tool('create_room', { roomName });
    const before = await server.request('tools/call', {
      name: 'agent_communication_send_message',
      arguments: { roomName, message: 'too early' },
    });
    expect(before.error.message).toContain(`has not entered room '${roomName}'`);

    expect(await server.tool('enter_room', { agentName: 'alice', roomName })).toEqual({ success: true });
    const sent = await server.tool('send_message', { roomName, message: 'from alice' });
    expect(sent).toMatchObject({ success: true, roomName });

    // An explicit agentName is rejected at runtime, even when it matches.
    for (const [name, args] of [
      ['agent_communication_send_message', { agentName: 'alice', roomName, message: 'hi' }],
      ['agent_communication_wait_for_messages', { agentName: 'alice', roomName, timeout: 1 }],
    ] as const) {
      const rejected = await server.request('tools/call', { name, arguments: args });
      expect(rejected.error.code).toBe(-32602);
      expect(rejected.error.message).toMatch(/'agentName' is not an input of agent_communication_/);
    }

    // A long wait in this process is cancelled (with no result) by switching the room to a different name; the switch
    // itself is not kept waiting.
    const waiting = server.request('tools/call', {
      name: 'agent_communication_wait_for_messages',
      arguments: { roomName, timeout: 0 },
    });
    await waitUntilWaiting(roomName, 'alice');
    const startedAt = Date.now();
    expect(await server.tool('enter_room', { agentName: 'bob', roomName })).toEqual({ success: true });
    expect(Date.now() - startedAt).toBeLessThan(5000);
    const cancelled = await waiting;
    expect(cancelled.error.message).toContain('Waiting for messages ended without a result');

    const users = await server.tool('list_room_users', { roomName });
    expect(Object.fromEntries(users.users.map((user: { name: string; status: string }) => [user.name, user.status]))).toMatchObject({
      alice: 'offline',
      bob: 'online',
    });
    expect((await server.tool('send_message', { roomName, message: 'from bob' })).success).toBe(true);

    // Leaving the selected name clears the binding; the connection must enter the room again.
    expect(await server.tool('leave_room', { agentName: 'bob', roomName })).toEqual({ success: true });
    const afterLeave = await server.request('tools/call', {
      name: 'agent_communication_send_message',
      arguments: { roomName, message: 'after leaving' },
    });
    expect(afterLeave.error.message).toContain(`has not entered room '${roomName}'`);

    // A fresh server process over the same files has no binding, even though the member rows remain.
    const restarted = await start();
    const restartedSend = await restarted.request('tools/call', {
      name: 'agent_communication_send_message',
      arguments: { roomName, message: 'from the restarted process' },
    });
    expect(restartedSend.error.message).toContain(`has not entered room '${roomName}'`);
    expect((await restarted.tool('list_room_users', { roomName })).users.map((user: { name: string }) => user.name)).toContain('alice');
  }, 90000);

  it('keeps two stdio processes using the same files on their own acting names', async () => {
    const roomName = 'stdio-identity-isolated';
    const alice = await start();
    const bob = await start();

    await alice.tool('create_room', { roomName });
    await alice.tool('enter_room', { agentName: 'alice', roomName });
    await bob.tool('enter_room', { agentName: 'bob', roomName });

    await alice.tool('send_message', { roomName, message: 'from alice' });
    await bob.tool('send_message', { roomName, message: 'from bob' });

    const byMessage = Object.fromEntries(
      (await alice.tool('get_messages', { roomName })).messages.map((m: { message: string; agentName: string }) => [m.message, m.agentName]),
    );
    expect(byMessage).toEqual({ 'from alice': 'alice', 'from bob': 'bob' });

    // Switching one process does not touch the other's acting name.
    expect(await alice.tool('enter_room', { agentName: 'carol', roomName })).toEqual({ success: true });
    expect((await bob.tool('send_message', { roomName, message: 'from bob again' })).success).toBe(true);
  }, 90000);
});
