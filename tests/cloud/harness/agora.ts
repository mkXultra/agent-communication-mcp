// Test harness: runs the real agora API (Cloudflare Workers + Durable Objects) with `wrangler dev`.
// Each instance gets its own free port, inspector port and `--persist-to` directory, so several
// test runs (e.g. reviewers in parallel) never share state. Instances run in their own process
// group and are always killed as a group.

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { cloudFetch as fetch } from '../../../src/cloud/http';

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** `POST /tokens` is limited to 5/hour and 20/day per IP by default; every test file issues tokens. */
export const TEST_TOKEN_VARS: Record<string, string> = {
  TOKEN_ISSUE_PER_HOUR: '1000',
  TOKEN_ISSUE_PER_DAY: '100000',
};

export interface AgoraInstance {
  readonly url: string;
  readonly port: number;
  readonly persistDir: string;
  /**
   * Passed as `--var API_VERSION:<instanceId>`; agora's `/health` echoes it, so a server that some other run
   * started on the same port is never taken for this one.
   */
  readonly instanceId: string;
  /** Stops wrangler dev (the whole process group) and removes the persist directory. */
  stop(): Promise<void>;
  /** Stops and starts again on the same port and persist directory: every WebSocket is dropped, data survives. */
  restart(): Promise<void>;
}

export interface StartAgoraOptions {
  vars?: Record<string, string>;
  startupTimeoutMs?: number;
  /** Port for the first attempt instead of a free one (tests of the port-collision handling). */
  firstPort?: number;
}

export function resolveAgoraDir(): string {
  return path.resolve(process.env.AGORA_DIR || path.join(REPO_ROOT, '..', 'agora'));
}

/** Throws with an actionable message when AGORA_DIR cannot run `wrangler dev`. */
export function assertAgoraDir(agoraDir: string): void {
  if (!existsSync(path.join(agoraDir, 'wrangler.toml'))) {
    throw new Error(
      `Cloud mode tests need the agora repository: no wrangler.toml in AGORA_DIR=${agoraDir} ` +
        `(set AGORA_DIR to a checkout of agora; default is ../agora)`,
    );
  }
  if (!existsSync(path.join(agoraDir, 'node_modules', '.bin', 'wrangler'))) {
    throw new Error(`Cloud mode tests need wrangler in ${agoraDir}/node_modules: run \`npm install\` there`);
  }
  // wrangler exits at once on an older Node.js (wrangler 4.x needs 22); say so instead of "did not become healthy".
  const wranglerManifest = path.join(agoraDir, 'node_modules', 'wrangler', 'package.json');
  const required = existsSync(wranglerManifest)
    ? (JSON.parse(readFileSync(wranglerManifest, 'utf8')) as { engines?: { node?: string } }).engines?.node
    : undefined;
  const problem = nodeVersionProblem(required, process.version);
  if (problem) throw new Error(problem);
}

/** Why this Node.js cannot run wrangler, given wrangler's `engines.node` (e.g. ">=22.0.0"), or undefined if it can. */
export function nodeVersionProblem(required: string | undefined, current: string): string | undefined {
  const requiredMajor = Number(/\d+/.exec(required ?? '')?.[0] ?? 0);
  const currentMajor = Number(/\d+/.exec(current)?.[0] ?? 0);
  if (currentMajor >= requiredMajor) return undefined;
  return `Cloud mode tests run wrangler dev, which needs Node.js ${required}; this is Node.js ${current}`;
}

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Already gone.
  }
}

/** Process groups started by this process; killed synchronously if the process exits without stopping them. */
const liveGroups = new Set<number>();
let exitHookInstalled = false;
function trackGroup(pgid: number): void {
  liveGroups.add(pgid);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const group of liveGroups) killGroup(group, 'SIGKILL');
  });
}

/** Whether `/health` on `url` is answered by the agora started with `--var API_VERSION:<instanceId>`. */
export async function probeHealth(url: string, instanceId: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    const body = (await response.json()) as { version?: unknown };
    return body.version === instanceId;
  } catch {
    return false;
  }
}

/** Whether anything answers HTTP on `url` (used to wait until a stopped instance released its port). */
async function portAnswers(url: string): Promise<boolean> {
  try {
    await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

export async function startAgora(options: StartAgoraOptions = {}): Promise<AgoraInstance> {
  const agoraDir = resolveAgoraDir();
  assertAgoraDir(agoraDir);

  const workDir = mkdtempSync(path.join(os.tmpdir(), 'agent-comm-agora-'));
  const persistDir = path.join(workDir, 'state');
  const logFile = path.join(workDir, 'wrangler.log');
  const instanceId = `test-${randomUUID()}`;
  const vars = { ...TEST_TOKEN_VARS, ...options.vars, API_VERSION: instanceId };
  let port = 0;
  let url = '';
  let pgid = 0;

  const launch = async (): Promise<void> => {
    const inspectorPort = await getFreePort();
    const args = [
      'wrangler',
      'dev',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--inspector-port',
      String(inspectorPort),
      '--persist-to',
      persistDir,
      '--show-interactive-dev-session=false',
      '--log-level',
      'warn',
      ...Object.entries(vars).flatMap(([key, value]) => ['--var', `${key}:${value}`]),
    ];
    const log = openSync(logFile, 'a');
    const child = spawn('npx', args, {
      cwd: agoraDir,
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    closeSync(log);
    if (!child.pid) throw new Error('Failed to spawn wrangler dev');
    pgid = child.pid;
    trackGroup(pgid);

    let exited = false;
    child.once('exit', () => {
      exited = true;
    });

    const deadline = Date.now() + (options.startupTimeoutMs ?? 90000);
    while (Date.now() < deadline) {
      // Our wrangler is gone (e.g. it could not bind the port): whatever answers on the port is not ours.
      if (exited) break;
      if (await probeHealth(url, instanceId)) return;
      await sleep(200);
    }
    // The port was never ours, so there is nothing to wait for once the process group is gone.
    await stopGroup(false);
    const tail = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').slice(-30).join('\n') : '';
    throw new Error(`wrangler dev did not become healthy on ${url} (AGORA_DIR=${agoraDir})\n${tail}`);
  };

  const stopGroup = async (releasePort = true): Promise<void> => {
    if (!pgid) return;
    const group = pgid;
    killGroup(group, 'SIGTERM');
    const deadline = Date.now() + 10000;
    while (groupAlive(group) && Date.now() < deadline) await sleep(100);
    if (groupAlive(group)) {
      killGroup(group, 'SIGKILL');
      while (groupAlive(group)) await sleep(50);
    }
    liveGroups.delete(group);
    pgid = 0;
    if (!releasePort) return;
    // The port has to be released before a restart can bind it again.
    const portDeadline = Date.now() + 10000;
    while ((await portAnswers(url)) && Date.now() < portDeadline) await sleep(100);
  };

  // Another process may take the free port before wrangler binds it: try again with a new port.
  for (let attempt = 1; ; attempt++) {
    port = attempt === 1 && options.firstPort ? options.firstPort : await getFreePort();
    url = `http://127.0.0.1:${port}`;
    try {
      await launch();
      break;
    } catch (error) {
      if (attempt >= 3) {
        rmSync(workDir, { recursive: true, force: true });
        throw error;
      }
    }
  }

  return {
    url,
    port,
    persistDir,
    instanceId,
    async stop() {
      await stopGroup();
      rmSync(workDir, { recursive: true, force: true });
    },
    async restart() {
      await stopGroup();
      await launch();
    },
  };
}

/** `POST /tokens` (no authentication). */
export async function issueToken(url: string, name: string): Promise<string> {
  const response = await fetch(`${url}/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const body = (await response.json()) as { token?: string };
  if (response.status !== 201 || !body.token) {
    throw new Error(`POST /tokens failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body.token;
}

/** Deletes every room of the token's user, so each test starts from an empty namespace. */
export async function deleteAllRooms(url: string, token: string): Promise<void> {
  const headers = { authorization: `Bearer ${token}` };
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(`${url}/rooms?limit=200`, { headers });
    if (!response.ok) throw new Error(`GET /rooms failed with HTTP ${response.status}`);
    const { rooms } = (await response.json()) as { rooms: Array<{ name: string }> };
    if (rooms.length === 0) return;
    await Promise.all(
      rooms.map((room) =>
        fetch(`${url}/rooms/${encodeURIComponent(room.name)}?confirm=true`, { method: 'DELETE', headers }).then((r) =>
          r.arrayBuffer(),
        ),
      ),
    );
  }
  throw new Error('Could not delete every room of the test user');
}
