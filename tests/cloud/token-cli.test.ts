// `agent-communication-mcp token` (the bin from source: node --require tsx/cjs src/index.ts) against the real agora
// started by the harness: --json prints agora's response as it is, the token works for the API, and --label is stored
// as the token's name. A second agora that issues one token per hour (production: 5) answers the next issuance with
// 429 RATE_LIMITED and Retry-After, which the command reports.

import { spawn } from 'child_process';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cloudFetch } from '../../src/cloud/index.js';
import { startAgora, type AgoraInstance } from './harness/agora.js';

const REPO_ROOT = path.resolve(__dirname, '../..');
const agoraUrl = process.env.AGENT_COMM_API_URL!;
const harnessToken = process.env.AGENT_COMM_TOKEN!;

interface BinResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runBin(args: string[], env: Record<string, string | undefined>): Promise<BinResult> {
  // Not the tsx executable: on Node 26 it adds a deprecation warning (DEP0205) to stderr.
  const child = spawn(process.execPath, ['--require', 'tsx/cjs', 'src/index.ts', ...args], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function api(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return cloudFetch(`${agoraUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
}

describe('token command against agora', () => {
  it('token --json prints only the API response and apiUrl, with a new token that the API accepts', async () => {
    const result = await runBin(['token', '--json', '--label', 'cloud test'], { AGENT_COMM_API_URL: agoraUrl });

    expect(result).toMatchObject({ code: 0, stderr: '' });
    const issued = JSON.parse(result.stdout) as Record<string, string>;
    expect(result.stdout).toBe(`${JSON.stringify(issued, null, 2)}\n`);
    // agora's own response to the same request has the same fields in the same order: only apiUrl is added.
    const reference = (await (
      await cloudFetch(`${agoraUrl}/tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'cloud test' }),
      })
    ).json()) as Record<string, unknown>;
    expect(Object.keys(reference)).toEqual(
      expect.arrayContaining(['token', 'tokenId', 'userId', 'name', 'createdAt', 'expiresAt']),
    );
    expect(Object.keys(issued)).toEqual([...Object.keys(reference), 'apiUrl']);
    expect(issued).toMatchObject({
      token: expect.stringMatching(/^agora_[0-9a-f]{64}$/),
      tokenId: expect.stringMatching(/^tk_/),
      userId: expect.stringMatching(/^u_/),
      // agora stores the label as the token's `name` and returns it only then.
      name: 'cloud test',
      apiUrl: agoraUrl,
    });
    expect(Date.parse(issued.expiresAt!)).toBeGreaterThan(Date.parse(issued.createdAt!));
    expect(issued.token).not.toBe(harnessToken);
    expect(issued.token).not.toBe(reference.token);

    // A user of its own: no rooms yet, and a room it creates is not the harness user's.
    const rooms = await api('/rooms', issued.token!);
    expect(rooms.status).toBe(200);
    expect(await rooms.json()).toMatchObject({ rooms: [] });
    const created = await api('/rooms', issued.token!, {
      method: 'POST',
      body: JSON.stringify({ roomName: 'token-cli-room' }),
    });
    expect(created.status).toBe(201);
    const listed = (await (await api('/rooms', issued.token!)).json()) as { rooms: Array<{ name: string }> };
    expect(listed.rooms.map((room) => room.name)).toEqual(['token-cli-room']);
    const harnessRooms = (await (await api('/rooms', harnessToken)).json()) as { rooms: Array<{ name: string }> };
    expect(harnessRooms.rooms.map((room) => room.name)).not.toContain('token-cli-room');

    // The 200s above are the token's doing: an unknown token is refused.
    expect((await api('/rooms', `agora_${'0'.repeat(64)}`)).status).toBe(401);
  });

  it('token prints the token first and the settings for the API it was issued at (--api-url over the environment)', async () => {
    const result = await runBin(['token', '--api-url', `${agoraUrl}/`], { AGENT_COMM_API_URL: 'http://127.0.0.1:9' });

    expect(result).toMatchObject({ code: 0, stderr: '' });
    const token = result.stdout.split('\n')[0]!;
    expect(token).toMatch(/^agora_[0-9a-f]{64}$/);
    expect(result.stdout).toContain(`\n  -e AGENT_COMM_TOKEN=${token} \\\n  -e AGENT_COMM_API_URL=${agoraUrl} \\\n`);
    expect(result.stdout).toMatch(
      new RegExp(`\\nenv = \\{ AGENT_COMM_TOKEN = "${token}", AGENT_COMM_API_URL = "${agoraUrl}" \\}\\ntool_timeout_sec = 86400\\n$`),
    );
    expect(result.stdout).toContain('# Until a room is created with it, it expires at ');
    expect(result.stdout).not.toContain('label');
    expect((await api('/rooms', token)).status).toBe(200);
  });

  describe('with the issuance limit reached', () => {
    let limited: AgoraInstance;

    beforeAll(async () => {
      limited = await startAgora({ vars: { TOKEN_ISSUE_PER_HOUR: '1' } });
    }, 120000);

    afterAll(async () => {
      await limited?.stop();
    }, 60000);

    it('exits 1 with RATE_LIMITED and the time to wait on stderr, and nothing on stdout', async () => {
      // One token per hour: the second request is refused, unless the hour turned in between (then the third is).
      const runs: Array<BinResult & { before: number; after: number }> = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = Date.now();
        const result = await runBin(['token', '--json', '--api-url', limited.url], {});
        runs.push({ ...result, before, after: Date.now() });
        if (result.code !== 0) break;
      }
      expect(runs[0]!.code, runs[0]!.stderr).toBe(0);
      const refused = runs[runs.length - 1]!;
      expect(runs.length).toBeGreaterThanOrEqual(2);

      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe('');
      const match = new RegExp(
        `^error: POST ${limited.url}/tokens failed with RATE_LIMITED \\(HTTP 429\\): ` +
          `Token issuance limit reached \\(1 per hour\\)\\. Try again in (\\d+ s|\\d+ min|1 h) ` +
          `\\(after (\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ)\\)\\.\\n$`,
      ).exec(refused.stderr);
      expect(match, refused.stderr).not.toBeNull();
      // agora's Retry-After for the hourly limit is the rest of the current hour (whole seconds, rounded up).
      const nextHour = (Math.floor(refused.before / 3_600_000) + 1) * 3_600_000;
      const retryAt = Date.parse(match![2]!);
      expect(retryAt).toBeGreaterThan(refused.before);
      expect(retryAt).toBeGreaterThanOrEqual(nextHour - 2000);
      expect(retryAt).toBeLessThanOrEqual(nextHour + 1000 + (refused.after - refused.before));
    });
  });
});
