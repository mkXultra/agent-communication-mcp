// Agent Communication MCP Server - `token` subcommand
// Issues a token with the cloud API's self-service POST /tokens (docs/api.yaml `createToken`, agora D7: no
// authentication; the API limits it per IP address) and prints it with the MCP client settings that use it.
// The token is written to stdout only: never to stderr, and never to a file.

import { API_URL_ENV, DEFAULT_API_URL, TOKEN_ENV, normalizeApiUrl } from '../cloud/config.js';
import { parseApiErrorBody } from '../cloud/errors.js';
import { cloudFetch } from '../cloud/http.js';
import type { TokenOptions } from './args.js';

/** docs/api.yaml `createToken`: the `name` the label is sent as has at most 100 characters (code points). */
export const MAX_LABEL_LENGTH = 100;
export const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

/** The server name and the command of the README's setup examples. */
const SERVER_NAME = 'agent-communication';
const PACKAGE_NAME = 'agent-communication-mcp';
/**
 * The Codex tool call timeout of the README's Codex example (「クライアント側のタイムアウト」): long and indefinite
 * waits (wait_for_messages `timeout: 0`) are cut off at Codex's default.
 */
const CODEX_TOOL_TIMEOUT_SEC = 86400;

export interface CliOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}

/** The body of the POST /tokens response as the API returned it (docs/api.yaml `createToken`), with a checked token. */
export interface TokenResponse {
  token: string;
  [field: string]: unknown;
}

export interface IssuedToken {
  /** The API the token was issued at, and belongs to. */
  apiUrl: string;
  response: TokenResponse;
}

export interface TokenCommandSettings {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** `--api-url`, else AGENT_COMM_API_URL, else the default API. Throws when that is not an http(s) URL. */
export function resolveTokenApiUrl(options: Pick<TokenOptions, 'apiUrl'>, env: NodeJS.ProcessEnv = process.env): string {
  if (options.apiUrl !== undefined) return normalizeApiUrl(options.apiUrl, '--api-url');
  return normalizeApiUrl(env[API_URL_ENV]?.trim() || DEFAULT_API_URL);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Why a request produced no response: a timeout, or the network error behind fetch's "fetch failed". */
function transportFailure(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.name === 'TimeoutError') return `no response within ${timeoutMs / 1000} s`;
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error) return cause.message || (cause as NodeJS.ErrnoException).code || errorMessage(error);
  return errorMessage(error);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

/** agora sends `Retry-After` with every 429, in seconds (docs/api.yaml `responses.RateLimited`). */
function retryHint(retryAfter: string | null): string {
  const value = retryAfter?.trim() ?? '';
  const seconds = Number(value);
  const at = new Date(Date.now() + seconds * 1000);
  if (!/^\d+$/.test(value) || Number.isNaN(at.getTime())) return 'Try again later.';
  return `Try again in ${formatDuration(seconds)} (after ${at.toISOString().replace(/\.\d{3}Z$/, 'Z')}).`;
}

/** POST /tokens at `apiUrl`. Fails with an Error whose message is meant for stderr; it never contains the token. */
export async function issueToken(
  apiUrl: string,
  label: string | undefined,
  timeoutMs: number = TOKEN_REQUEST_TIMEOUT_MS,
): Promise<IssuedToken> {
  const url = `${apiUrl}/tokens`;
  const failed = (reason: string): Error => new Error(`POST ${url} failed: ${reason}`);

  let status: number;
  let retryAfter: string | null;
  let text: string;
  try {
    const response = await cloudFetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': PACKAGE_NAME },
      body: JSON.stringify(label === undefined ? {} : { name: label }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    retryAfter = response.headers.get('retry-after');
    text = await response.text();
  } catch (error) {
    throw failed(transportFailure(error, timeoutMs));
  }

  if (status < 200 || status > 299) {
    const { code, message } = parseApiErrorBody(status, text);
    const retry = code === 'RATE_LIMITED' ? `. ${retryHint(retryAfter)}` : '';
    throw new Error(`POST ${url} failed with ${code} (HTTP ${status}): ${message}${retry}`);
  }

  const notTheApi = `check that ${apiUrl} is the Agent Communication Cloud API`;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw failed(`the response (HTTP ${status}) is not JSON; ${notTheApi}`);
  }
  const response: Record<string, unknown> =
    body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const { token } = response;
  // Printed on a line of its own and pasted into shell, JSON and TOML: visible ASCII only (agora: `agora_<hex>`).
  if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token)) {
    throw failed(`the response (HTTP ${status}) has no valid token; ${notTheApi}`);
  }
  return { apiUrl, response: { ...response, token } };
}

/**
 * The `--json` output: the API's response as returned (the label is its `name`; fields this client does not know are
 * kept), followed by the API it came from as `apiUrl`.
 */
export function formatJson({ apiUrl, response }: IssuedToken): string {
  return `${JSON.stringify({ ...response, apiUrl }, null, 2)}\n`;
}

/** Quotes `value` for a POSIX shell unless it only has characters that need no quoting. */
function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The default output: the token on the first line, then the settings for Claude Code (command and JSON) and
 * Codex CLI in the README's shapes. AGENT_COMM_API_URL is added when the token is not for the default API.
 */
export function formatText({ apiUrl, response }: IssuedToken): string {
  const { token, name, expiresAt } = response;
  const env: Array<[string, string]> = [[TOKEN_ENV, token]];
  if (apiUrl !== DEFAULT_API_URL) env.push([API_URL_ENV, apiUrl]);

  const envOptions = env.map(([key, value]) => `-e ${shellQuote(`${key}=${value}`)}`);
  const claudeCommand =
    envOptions.length === 1
      ? `claude mcp add ${SERVER_NAME} ${envOptions[0]} -- npx ${PACKAGE_NAME}`
      : [`claude mcp add ${SERVER_NAME}`, ...envOptions, `-- npx ${PACKAGE_NAME}`].join(' \\\n  ');

  const label = typeof name === 'string' ? ` (label ${JSON.stringify(name)})` : '';
  const lines = [
    token,
    '',
    `# Agent Communication Cloud token for ${apiUrl}${label}.`,
    '# It is shown only this once and is not saved anywhere: keep it in the MCP client settings below.',
  ];
  if (typeof expiresAt === 'string') {
    lines.push(`# Until a room is created with it, it expires at ${expiresAt}; the first room makes it permanent.`);
  }
  lines.push(
    '',
    '# Claude Code',
    claudeCommand,
    '',
    '# JSON settings (Claude Code .mcp.json, Claude Desktop claude_desktop_config.json)',
    '{',
    '  "mcpServers": {',
    `    "${SERVER_NAME}": {`,
    '      "command": "npx",',
    `      "args": ["${PACKAGE_NAME}"],`,
    '      "env": {',
    env.map(([key, value]) => `        "${key}": ${JSON.stringify(value)}`).join(',\n'),
    '      }',
    '    }',
    '  }',
    '}',
    '',
    '# Codex CLI (~/.codex/config.toml)',
    `[mcp_servers.${SERVER_NAME}]`,
    'command = "npx"',
    `args = ["${PACKAGE_NAME}"]`,
    `env = { ${env.map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(', ')} }`,
    `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`,
  );
  return `${lines.join('\n')}\n`;
}

/** `token`: issues a token and prints it. Resolves with the exit code (2: invalid option value, 1: not issued). */
export async function runTokenCommand(
  options: TokenOptions,
  out: CliOutput,
  settings: TokenCommandSettings = {},
): Promise<number> {
  if (options.label !== undefined && [...options.label].length > MAX_LABEL_LENGTH) {
    // Checked here: the API counts a request it refuses for its body against the issuance limit as well.
    out.stderr(`error: --label must be at most ${MAX_LABEL_LENGTH} characters\n`);
    return 2;
  }
  let apiUrl: string;
  try {
    apiUrl = resolveTokenApiUrl(options, settings.env);
  } catch (error) {
    out.stderr(`error: ${errorMessage(error)}\n`);
    return 2;
  }

  let issued: IssuedToken;
  try {
    issued = await issueToken(apiUrl, options.label, settings.timeoutMs);
  } catch (error) {
    out.stderr(`error: ${errorMessage(error)}\n`);
    return 1;
  }
  out.stdout(options.json ? formatJson(issued) : formatText(issued));
  return 0;
}
