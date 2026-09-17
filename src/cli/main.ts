// Agent Communication MCP Server - command line (src/index.ts is the package's bin)

import { DEFAULT_API_URL } from '../cloud/config.js';
import { parseArgs, type TokenOptions } from './args.js';
import { MAX_LABEL_LENGTH, runTokenCommand, type CliOutput } from './token.js';

export const USAGE = `Usage: agent-communication-mcp [command]

Without a command, runs the MCP server on stdio (the way MCP clients start it).

Commands:
  token           Issue an Agent Communication Cloud token (AGENT_COMM_TOKEN) and print the MCP client settings

Options:
  -h, --help      Show this help
  -v, --version   Show the version

Run "agent-communication-mcp token --help" for the options of token.
`;

export const TOKEN_USAGE = `Usage: agent-communication-mcp token [--label <text>] [--api-url <url>] [--json]

Issues a token with POST /tokens of the Agent Communication Cloud (no sign-up needed; ${DEFAULT_API_URL}
issues 5 per hour and 20 per day per IP address) and prints it, followed by the settings for Claude Code and
Codex CLI. The token is shown only once and is not saved anywhere.

Options:
  --label <text>    A name to recognize the token by (up to ${MAX_LABEL_LENGTH} characters;
                    use --label=<text> for text that starts with "-")
  --api-url <url>   The API to issue the token at
                    (default: AGENT_COMM_API_URL, or else ${DEFAULT_API_URL})
  --json            Print only JSON: the API's response as returned (token, tokenId, userId,
                    name = the label, createdAt, expiresAt) with apiUrl added
  -h, --help        Show this help
`;

export interface CliDeps {
  /** The package version, printed by `--version`. */
  version: string;
  /** Starts the MCP server on stdio. */
  startServer: () => unknown;
  /** Runs `token` (default: {@link runTokenCommand}). */
  runToken?: (options: TokenOptions, out: CliOutput) => Promise<number>;
  /** Default: process.stdout and process.stderr. */
  out?: CliOutput;
}

const processOutput: CliOutput = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
};

/**
 * Runs the command line `argv` (the arguments after the script). Resolves with the exit code, or with `undefined`
 * once it has started the MCP server, which keeps the process running and must be the only writer to stdout.
 */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number | undefined> {
  const out = deps.out ?? processOutput;
  const parsed = parseArgs(argv);
  switch (parsed.command) {
    case 'server':
      await deps.startServer();
      return undefined;
    case 'help':
      out.stdout(USAGE);
      return 0;
    case 'version':
      out.stdout(`${deps.version}\n`);
      return 0;
    case 'token-help':
      out.stdout(TOKEN_USAGE);
      return 0;
    case 'token':
      return (deps.runToken ?? runTokenCommand)(parsed.options, out);
    case 'usage-error':
      out.stderr(`error: ${parsed.message}\n\n${parsed.usage === 'token' ? TOKEN_USAGE : USAGE}`);
      return 2;
  }
}
