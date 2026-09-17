// `token` (src/cli/token.ts) against a local HTTP server that stands in for agora's POST /tokens (docs/api.yaml
// `createToken`): the request it sends, and stdout / stderr / exit code for each outcome. The last block runs the bin
// from source (node --require tsx/cjs src/index.ts; the tsx executable adds Node 26's DEP0205 warning to stderr) to
// check what reaches the process's stdout and stderr. Nothing here contacts the default (production) API.

import { spawn } from 'child_process';
import { promises as fs, readFileSync } from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TokenOptions } from '../../src/cli/args.js';
import {
  formatJson,
  formatText,
  resolveTokenApiUrl,
  runTokenCommand,
  type TokenCommandSettings,
  type TokenResponse,
} from '../../src/cli/token.js';
import { DEFAULT_API_URL } from '../../src/cloud/config.js';

const REPO_ROOT = path.resolve(__dirname, '../..');

const TOKEN = `agora_${'0f'.repeat(32)}`;
/** The rest of agora's 201 response. */
const DETAILS = {
  tokenId: 'tk_00112233445566778899aabb',
  userId: `u_${'ab'.repeat(20)}`,
  createdAt: '2026-09-17T05:00:00.000Z',
  expiresAt: '2026-09-24T05:00:00.000Z',
};
const RATE_LIMITED = {
  code: 'RATE_LIMITED',
  message: 'Token issuance limit reached (5 per hour)',
  retryable: true,
  details: { scope: 'hour', limit: 5 },
};

interface ReceivedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
type Reply = (request: ReceivedRequest, response: http.ServerResponse) => void;

function sendJson(response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

/** agora's 201 body, in its field order: `name` only when the request had one. */
function agoraResponse(name?: string): TokenResponse {
  const { tokenId, userId, createdAt, expiresAt } = DETAILS;
  return { token: TOKEN, tokenId, userId, ...(name !== undefined ? { name } : {}), createdAt, expiresAt };
}

const issue: Reply = (request, response) => {
  const { name } = JSON.parse(request.body) as { name?: string };
  sendJson(response, 201, agoraResponse(name));
};

/** The bin run from source with arguments, the way `npx agent-communication-mcp …` runs dist/index.js. */
function spawnBin(args: string[], env: Record<string, string | undefined> = {}) {
  return spawn(process.execPath, ['--require', 'tsx/cjs', 'src/index.ts', ...args], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
}

/**
 * The bin run from source without arguments: the MCP server. It loads its adapters with import(), which needs tsx's
 * ESM hook as well; tsx registers that hook with module.register(), which Node 26 reports on stderr (DEP0205).
 */
function spawnServer(env: Record<string, string | undefined>) {
  const quiet = process.allowedNodeEnvironmentFlags.has('--disable-warning') ? ['--disable-warning=DEP0205'] : [];
  return spawn(process.execPath, [...quiet, '--require', 'tsx/cjs', '--import', 'tsx/esm', 'src/index.ts'], {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
}

let server: http.Server;
let apiUrl: string;
let reply: Reply;
const requests: ReceivedRequest[] = [];

beforeAll(async () => {
  server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (body += chunk));
    request.on('end', () => {
      const received = { method: request.method!, url: request.url!, headers: request.headers, body };
      requests.push(received);
      reply(received, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  requests.length = 0;
  reply = issue;
});

async function token(options: Partial<TokenOptions> = {}, settings: TokenCommandSettings = {}) {
  let stdout = '';
  let stderr = '';
  const exitCode = await runTokenCommand(
    { json: false, apiUrl, ...options },
    { stdout: (text) => void (stdout += text), stderr: (text) => void (stderr += text) },
    { env: {}, ...settings },
  );
  return { exitCode, stdout, stderr };
}

async function closedPortUrl(): Promise<string> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return `http://127.0.0.1:${port}`;
}

/** The time `error:` names for Retry-After, checked against the clock around the call. */
function expectRetryAt(stderr: string, before: number, after: number, seconds: number): void {
  const at = /\(after (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)\)\.\n$/.exec(stderr)?.[1];
  expect(at, stderr).toBeDefined();
  const time = Date.parse(at!);
  expect(time).toBeGreaterThanOrEqual(Math.floor((before + seconds * 1000) / 1000) * 1000);
  expect(time).toBeLessThanOrEqual(after + seconds * 1000);
}

describe('token: issuing', () => {
  it('sends POST /tokens without a name and prints the token, then the client settings', async () => {
    const result = await token();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/tokens', body: '{}' });
    expect(requests[0]!.headers).toMatchObject({
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'agent-communication-mcp',
    });
    expect(requests[0]!.headers.authorization).toBeUndefined();

    expect(result).toEqual({ exitCode: 0, stderr: '', stdout: expect.any(String) });
    expect(result.stdout.split('\n')[0]).toBe(TOKEN);
    expect(result.stdout).toBe(`${TOKEN}

# Agent Communication Cloud token for ${apiUrl}.
# It is shown only this once and is not saved anywhere: keep it in the MCP client settings below.
# Until a room is created with it, it expires at 2026-09-24T05:00:00.000Z; the first room makes it permanent.

# Claude Code
claude mcp add agent-communication \\
  -e AGENT_COMM_TOKEN=${TOKEN} \\
  -e AGENT_COMM_API_URL=${apiUrl} \\
  -- npx agent-communication-mcp

# JSON settings (Claude Code .mcp.json, Claude Desktop claude_desktop_config.json)
{
  "mcpServers": {
    "agent-communication": {
      "command": "npx",
      "args": ["agent-communication-mcp"],
      "env": {
        "AGENT_COMM_TOKEN": "${TOKEN}",
        "AGENT_COMM_API_URL": "${apiUrl}"
      }
    }
  }
}

# Codex CLI (~/.codex/config.toml)
[mcp_servers.agent-communication]
command = "npx"
args = ["agent-communication-mcp"]
env = { AGENT_COMM_TOKEN = "${TOKEN}", AGENT_COMM_API_URL = "${apiUrl}" }
tool_timeout_sec = 86400
`);
  });

  it('sends --label as the API field `name` and names the label it got back', async () => {
    const result = await token({ label: 'my "laptop"' });

    expect(requests.map((request) => JSON.parse(request.body))).toEqual([{ name: 'my "laptop"' }]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.split('\n').slice(0, 3)).toEqual([
      TOKEN,
      '',
      `# Agent Communication Cloud token for ${apiUrl} (label "my \\"laptop\\"").`,
    ]);
  });

  it('prints the settings without AGENT_COMM_API_URL for the default API, in the shapes of the README', () => {
    const placeholder = 'agora_xxxxxxxxxxxxxxxx';
    const text = formatText({ apiUrl: DEFAULT_API_URL, response: { token: placeholder, name: 'my-laptop' } });
    const claudeCommand = `claude mcp add agent-communication -e AGENT_COMM_TOKEN=${placeholder} -- npx agent-communication-mcp`;
    const json = `{
  "mcpServers": {
    "agent-communication": {
      "command": "npx",
      "args": ["agent-communication-mcp"],
      "env": {
        "AGENT_COMM_TOKEN": "${placeholder}"
      }
    }
  }
}`;
    const toml = `[mcp_servers.agent-communication]
command = "npx"
args = ["agent-communication-mcp"]
env = { AGENT_COMM_TOKEN = "${placeholder}" }
tool_timeout_sec = 86400`;
    expect(text).toBe(`${placeholder}

# Agent Communication Cloud token for https://agora.omajinai.work (label "my-laptop").
# It is shown only this once and is not saved anywhere: keep it in the MCP client settings below.

# Claude Code
${claudeCommand}

# JSON settings (Claude Code .mcp.json, Claude Desktop claude_desktop_config.json)
${json}

# Codex CLI (~/.codex/config.toml)
${toml}
`);
    expect(JSON.parse(json)).toEqual({
      mcpServers: {
        'agent-communication': { command: 'npx', args: ['agent-communication-mcp'], env: { AGENT_COMM_TOKEN: placeholder } },
      },
    });

    // The README shows these outputs (「トークンの発行」), and the same command, JSON and TOML in its cloud mode setup
    // and Codex example: each as a whole fenced block.
    const readme = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
    const fenced = (language: string, body: string): string => `\n\`\`\`${language}\n${body}\n\`\`\`\n`;
    const multiLineCommand = [
      'claude mcp add agent-communication',
      `-e AGENT_COMM_TOKEN=${placeholder}`,
      '-e AGENT_COMM_API_URL=http://127.0.0.1:8787',
      '-- npx agent-communication-mcp',
    ].join(' \\\n  ');
    const readmeResponse: TokenResponse = {
      token: placeholder,
      tokenId: `tk_${'x'.repeat(24)}`,
      userId: `u_${'x'.repeat(40)}`,
      name: 'my-laptop',
      createdAt: DETAILS.createdAt,
      expiresAt: DETAILS.expiresAt,
    };
    const issuedExample = { apiUrl: DEFAULT_API_URL, response: readmeResponse };
    expect(readme).toContain(fenced('text', formatText(issuedExample).replace(/\n$/, '')));
    expect(readme).toContain(fenced('json', formatJson(issuedExample).replace(/\n$/, '')));
    expect(readme).toContain(fenced('bash', claudeCommand));
    expect(readme).toContain(fenced('json', json));
    expect(readme).toContain(fenced('toml', toml));
    expect(readme).toContain(fenced('bash', multiLineCommand));
    expect(formatText({ apiUrl: 'http://127.0.0.1:8787', response: { token: placeholder } })).toContain(
      `\n# Claude Code\n${multiLineCommand}\n\n`,
    );
  });

  it('quotes an API URL for the shell and escapes it for JSON and TOML', () => {
    const url = "http://127.0.0.1:8787/it's";
    const text = formatText({ apiUrl: url, response: { token: TOKEN } });
    expect(text).toContain(`  -e 'AGENT_COMM_API_URL=http://127.0.0.1:8787/it'\\''s' \\\n`);
    expect(text).toContain(`"AGENT_COMM_API_URL": "http://127.0.0.1:8787/it's"`);
    expect(text).toContain(`AGENT_COMM_API_URL = "http://127.0.0.1:8787/it's" }\n`);
    expect(formatText({ apiUrl: 'http://h/a"b\\c', response: { token: TOKEN } })).toContain(
      `AGENT_COMM_API_URL = "http://h/a\\"b\\\\c" }\n`,
    );
  });

  it('--json prints nothing but the API response as returned (the label as `name`), then apiUrl', async () => {
    const result = await token({ json: true, label: 'my-laptop' });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`${JSON.stringify({ ...agoraResponse('my-laptop'), apiUrl }, null, 2)}\n`);
    expect(result.stdout).toBe(`{
  "token": "${TOKEN}",
  "tokenId": "${DETAILS.tokenId}",
  "userId": "${DETAILS.userId}",
  "name": "my-laptop",
  "createdAt": "${DETAILS.createdAt}",
  "expiresAt": "${DETAILS.expiresAt}",
  "apiUrl": "${apiUrl}"
}
`);
  });

  it('--json passes on whatever the API returned: no name without --label, other fields and values as they are', async () => {
    const result = await token({ json: true });
    expect(result).toEqual({
      exitCode: 0,
      stderr: '',
      stdout: `${JSON.stringify({ ...agoraResponse(), apiUrl }, null, 2)}\n`,
    });
    expect(JSON.parse(result.stdout)).not.toHaveProperty('name');
    expect(JSON.parse(result.stdout)).not.toHaveProperty('label');

    // Only `token` is checked: fields this client does not know, and values of any type, are passed on.
    const unusual = { token: TOKEN, tokenId: 42, name: null, scopes: ['rooms'], quota: { rooms: 50, nested: [true, null] } };
    reply = (_request, response) => sendJson(response, 201, unusual);
    const passedOn = await token({ json: true });
    expect(passedOn).toEqual({ exitCode: 0, stderr: '', stdout: `${JSON.stringify({ ...unusual, apiUrl }, null, 2)}\n` });

    // The API URL is the one the token was issued at, also if the response names one.
    reply = (_request, response) => sendJson(response, 201, { token: TOKEN, apiUrl: 'https://elsewhere.example' });
    expect(JSON.parse((await token({ json: true })).stdout)).toEqual({ token: TOKEN, apiUrl });
  });

  it('the text output takes the label and the expiry from the response only when they are strings', async () => {
    reply = (_request, response) => sendJson(response, 201, { token: TOKEN, name: 42, expiresAt: null });
    const result = await token();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.split('\n').slice(0, 5)).toEqual([
      TOKEN,
      '',
      `# Agent Communication Cloud token for ${apiUrl}.`,
      '# It is shown only this once and is not saved anywhere: keep it in the MCP client settings below.',
      '',
    ]);
  });

  it('sends to /tokens under the path of --api-url, without its query, fragment or trailing slash', async () => {
    const result = await token({ json: true, apiUrl: `${apiUrl}/base/?x=1#y` });
    expect(requests.map((request) => request.url)).toEqual(['/base/tokens']);
    expect(JSON.parse(result.stdout).apiUrl).toBe(`${apiUrl}/base`);
  });

  it('uses AGENT_COMM_API_URL without --api-url, and --api-url over it', async () => {
    const fromEnv = await token({ json: true, apiUrl: undefined }, { env: { AGENT_COMM_API_URL: ` ${apiUrl}/ ` } });
    expect(fromEnv.exitCode).toBe(0);
    expect(JSON.parse(fromEnv.stdout).apiUrl).toBe(apiUrl);

    const fromOption = await token({ json: true }, { env: { AGENT_COMM_API_URL: 'not a url' } });
    expect(fromOption.exitCode).toBe(0);
    expect(JSON.parse(fromOption.stdout).apiUrl).toBe(apiUrl);
    expect(requests).toHaveLength(2);
  });

  it('resolves the API URL: --api-url, AGENT_COMM_API_URL, then the default (with or without a token)', () => {
    expect(resolveTokenApiUrl({}, {})).toBe(DEFAULT_API_URL);
    expect(resolveTokenApiUrl({}, { AGENT_COMM_API_URL: '  ' })).toBe(DEFAULT_API_URL);
    expect(resolveTokenApiUrl({}, { AGENT_COMM_TOKEN: 'agora_x' })).toBe(DEFAULT_API_URL);
    expect(resolveTokenApiUrl({}, { AGENT_COMM_API_URL: 'http://localhost:8787/' })).toBe('http://localhost:8787');
    expect(resolveTokenApiUrl({ apiUrl: 'https://example.com/x/?q=1' }, { AGENT_COMM_API_URL: 'http://localhost:8787' })).toBe(
      'https://example.com/x',
    );
    expect(() => resolveTokenApiUrl({ apiUrl: 'ftp://example.com' }, {})).toThrow('--api-url must use http or https: ftp://example.com');
    expect(() => resolveTokenApiUrl({}, { AGENT_COMM_API_URL: 'nope' })).toThrow('AGENT_COMM_API_URL is not a valid URL: nope');
  });
});

describe('token: refused before sending (exit 2)', () => {
  it.each<[Partial<TokenOptions>, NodeJS.ProcessEnv, string]>([
    [{ label: '🙂'.repeat(101) }, {}, '--label must be at most 100 characters'],
    [{ label: 'x'.repeat(101), json: true }, {}, '--label must be at most 100 characters'],
    [{ apiUrl: 'ftp://example.com' }, {}, '--api-url must use http or https: ftp://example.com'],
    [{ apiUrl: 'not a url' }, {}, '--api-url is not a valid URL: not a url'],
    [{ apiUrl: undefined }, { AGENT_COMM_API_URL: 'nope' }, 'AGENT_COMM_API_URL is not a valid URL: nope'],
    [{ apiUrl: undefined }, { AGENT_COMM_API_URL: 'file:///tmp/x' }, 'AGENT_COMM_API_URL must use http or https: file:///tmp/x'],
  ])('%j with %j: %s', async (options, env, message) => {
    const result = await token(options, { env });
    expect(result).toEqual({ exitCode: 2, stdout: '', stderr: `error: ${message}\n` });
    expect(requests).toHaveLength(0);
  });

  it('counts the label in characters, as the API does: 100 emoji are sent', async () => {
    const label = '🙂'.repeat(100);
    const result = await token({ json: true, label });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(requests[0]!.body)).toEqual({ name: label });
    expect(JSON.parse(result.stdout).name).toBe(label);
  });
});

describe('token: not issued (exit 1, nothing on stdout)', () => {
  it.each<[string, number, string]>([
    ['2520', 2520, '42 min'],
    ['30', 30, '30 s'],
    ['60', 60, '1 min'],
    ['3600', 3600, '1 h'],
    [' 5400 ', 5400, '1 h 30 min'],
    // Minutes are rounded up: a retry at the time named is never early (agora sends the rest of the hour, e.g. 2519).
    ['61', 61, '2 min'],
    ['2519', 2519, '42 min'],
    ['3599', 3599, '1 h'],
    ['3601', 3601, '1 h 1 min'],
  ])('RATE_LIMITED with Retry-After %j: says when to try again', async (header, seconds, wait) => {
    reply = (_request, response) => sendJson(response, 429, RATE_LIMITED, { 'retry-after': header });
    const before = Date.now();
    const result = await token({ label: 'my-laptop' });
    const after = Date.now();

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(
      new RegExp(
        `^error: POST ${apiUrl}/tokens failed with RATE_LIMITED \\(HTTP 429\\): ` +
          `Token issuance limit reached \\(5 per hour\\)\\. Try again in ${wait} \\(after [^)]+\\)\\.\\n$`,
      ),
    );
    expectRetryAt(result.stderr, before, after, seconds);
    expect(requests).toHaveLength(1);
  });

  it.each([[undefined], ['soon'], ['1.5'], ['-5'], [''], ['99999999999999999999']])(
    'RATE_LIMITED with Retry-After %j: says to try again later',
    async (header) => {
      reply = (_request, response) =>
        sendJson(response, 429, RATE_LIMITED, header === undefined ? {} : { 'retry-after': header });
      const result = await token();
      expect(result).toEqual({
        exitCode: 1,
        stdout: '',
        stderr: `error: POST ${apiUrl}/tokens failed with RATE_LIMITED (HTTP 429): Token issuance limit reached (5 per hour). Try again later.\n`,
      });
    },
  );

  it('a 429 that is not the API JSON is RATE_LIMITED as well', async () => {
    reply = (_request, response) => {
      response.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '120' });
      response.end('Too Many Requests');
    };
    const result = await token({ json: true });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(
      new RegExp(`^error: POST ${apiUrl}/tokens failed with RATE_LIMITED \\(HTTP 429\\): Cloud API responded with HTTP 429\\. Try again in 2 min \\(after `),
    );
  });

  it.each<[number, unknown, string]>([
    [503, { code: 'SIGNUP_DISABLED', message: 'Token issuance is currently disabled', retryable: false }, 'SIGNUP_DISABLED (HTTP 503): Token issuance is currently disabled'],
    [400, { code: 'VALIDATION_ERROR', message: 'name must be a string', retryable: false }, 'VALIDATION_ERROR (HTTP 400): name must be a string'],
    [500, { code: 'STORAGE_ERROR', message: 'Storage error', retryable: true, details: { correlationId: 'c' } }, 'STORAGE_ERROR (HTTP 500): Storage error'],
  ])('HTTP %i from the API: its code and message', async (status, body, reason) => {
    reply = (_request, response) => sendJson(response, status, body);
    const result = await token({ json: true });
    expect(result).toEqual({ exitCode: 1, stdout: '', stderr: `error: POST ${apiUrl}/tokens failed with ${reason}\n` });
  });

  it('an error page that is not JSON: the HTTP status', async () => {
    reply = (_request, response) => {
      response.writeHead(502, { 'content-type': 'text/html' });
      response.end('<html><body>Bad gateway</body></html>');
    };
    const result = await token();
    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: `error: POST ${apiUrl}/tokens failed with SERVICE_UNAVAILABLE (HTTP 502): Cloud API responded with HTTP 502\n`,
    });
  });

  it('a successful response that is not JSON', async () => {
    reply = (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>Some other site</title>');
    };
    const result = await token({ json: true });
    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr:
        `error: POST ${apiUrl}/tokens failed: the response (HTTP 200) is not JSON; ` +
        `check that ${apiUrl} is the Agent Communication Cloud API\n`,
    });
  });

  it.each<[string, string]>([
    ['no token', JSON.stringify({ tokenId: 'tk_1' })],
    ['an empty token', JSON.stringify({ token: '' })],
    ['a token that is not a string', JSON.stringify({ token: 42 })],
    ['a token with a space', JSON.stringify({ token: 'agora_ab cd' })],
    ['a token with a line break', JSON.stringify({ token: 'agora_ab\ncd' })],
    ['a token with a non-ASCII character', JSON.stringify({ token: 'agora_abé' })],
    ['null', 'null'],
    ['an array', JSON.stringify([TOKEN])],
    ['a string', JSON.stringify(TOKEN)],
  ])('a successful JSON response with %s', async (_case, body) => {
    reply = (_request, response) => {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(body);
    };
    const result = await token();
    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr:
        `error: POST ${apiUrl}/tokens failed: the response (HTTP 201) has no valid token; ` +
        `check that ${apiUrl} is the Agent Communication Cloud API\n`,
    });
    expect(result.stderr).not.toContain('agora_');
  });

  it('a network error: the reason', async () => {
    const url = await closedPortUrl();
    const result = await token({ json: true, apiUrl: url });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(new RegExp(`^error: POST ${url}/tokens failed: .*ECONNREFUSED.*\\n$`));
  });

  it('no response in time: gives up after the timeout (10 s by default)', async () => {
    reply = () => undefined; // Never answers.
    const started = Date.now();
    const result = await token({ json: true }, { timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: `error: POST ${apiUrl}/tokens failed: no response within 0.3 s\n`,
    });
  });

  it('a response body that stops coming: gives up after the timeout', async () => {
    reply = (_request, response) => {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.write(`{"token":"${TOKEN}",`); // ... and nothing more.
    };
    const result = await token({ json: true }, { timeoutMs: 300 });
    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: `error: POST ${apiUrl}/tokens failed: no response within 0.3 s\n`,
    });
  });
});

describe('token: the bin', () => {
  function runBin(args: string[], env: Record<string, string | undefined> = {}) {
    const child = spawnBin(args, env);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
  }

  it('token --json writes the API response and apiUrl to stdout, and nothing else anywhere', async () => {
    const result = await runBin(['token', '--json', '--label', 'bin'], { AGENT_COMM_API_URL: apiUrl });
    expect(result).toEqual({
      code: 0,
      stdout: `${JSON.stringify({ ...agoraResponse('bin'), apiUrl }, null, 2)}\n`,
      stderr: '',
    });
    expect(requests).toHaveLength(1);
  });

  it('token prints the token on the first line of stdout', async () => {
    const result = await runBin(['token', '--api-url', apiUrl]);
    expect(result).toEqual({ code: 0, stdout: formatText({ apiUrl, response: agoraResponse() }), stderr: '' });
    expect(result.stdout.split('\n')[0]).toBe(TOKEN);
  });

  it('token exits 1 with the reason on stderr and nothing on stdout when the token is not issued', async () => {
    reply = (_request, response) => sendJson(response, 429, RATE_LIMITED, { 'retry-after': '60' });
    const limited = await runBin(['token', '--json', '--api-url', apiUrl]);
    expect(limited).toMatchObject({ code: 1, stdout: '' });
    expect(limited.stderr).toMatch(
      new RegExp(
        `^error: POST ${apiUrl}/tokens failed with RATE_LIMITED \\(HTTP 429\\): ` +
          `Token issuance limit reached \\(5 per hour\\)\\. Try again in 1 min \\(after [^)]+\\)\\.\\n$`,
      ),
    );

    const unreachable = await runBin(['token', '--json', '--api-url', await closedPortUrl()]);
    expect(unreachable).toMatchObject({ code: 1, stdout: '' });
    expect(unreachable.stderr).toMatch(/^error: POST http:\/\/127\.0\.0\.1:\d+\/tokens failed: [^\n]*ECONNREFUSED[^\n]*\n$/);
  });

  it('--version, token --help and an unknown command exit with 0, 0 and 2', async () => {
    const { version } = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string };
    expect(await runBin(['--version'])).toEqual({ code: 0, stdout: `${version}\n`, stderr: '' });
    const help = await runBin(['token', '--help']);
    expect(help).toMatchObject({ code: 0, stderr: '' });
    expect(help.stdout).toMatch(/^Usage: agent-communication-mcp token /);
    const unknown = await runBin(['tokens']);
    expect(unknown).toMatchObject({ code: 2, stdout: '' });
    expect(unknown.stderr).toMatch(/^error: unknown command: tokens\n\nUsage: agent-communication-mcp \[command\]\n/);
    expect(requests).toHaveLength(0);
  });

  it('without arguments it is still the MCP server: only JSON-RPC on stdout, the usual two lines on stderr', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-comm-cli-'));
    try {
      const child = spawnServer({ AGENT_COMM_DATA_DIR: dataDir, AGENT_COMM_TOKEN: undefined, AGENT_COMM_API_URL: undefined });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'cli-test', version: '1.0.0' } },
        })}\n`,
      );
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
      const deadline = Date.now() + 15000;
      while (!stdout.includes('"id":2') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      child.stdin.end();
      const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('timeout'), 10000))]);
      if (code === 'timeout') child.kill('SIGKILL');

      const lines = stdout.split('\n').filter((line) => line !== '');
      expect(lines.map((line) => JSON.parse(line))).toEqual([
        expect.objectContaining({ jsonrpc: '2.0', id: 1, result: expect.objectContaining({ serverInfo: expect.anything() }) }),
        expect.objectContaining({ jsonrpc: '2.0', id: 2, result: { tools: expect.any(Array) } }),
      ]);
      expect(lines[1] && JSON.parse(lines[1]).result.tools).toHaveLength(10);
      expect(stderr).toBe('Agent Communication MCP Server started on stdio\nAGENT_COMM_TOKEN が未設定のためファイルモードで起動\n');
      expect(code).toBe(0);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
