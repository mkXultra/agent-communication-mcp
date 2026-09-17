// Agent Communication MCP Server - command line arguments
// Without arguments the package is the MCP server on stdio (what MCP clients start). `token` issues a cloud token
// and exits; `--help` and `--version` print and exit. Anything else is a usage error.

export interface TokenOptions {
  /** `--label`: the token's display name (the API's `name`). */
  label?: string;
  /** `--api-url`: the API to issue the token at, instead of AGENT_COMM_API_URL or the default. */
  apiUrl?: string;
  /** `--json`: print the issued token as JSON only. */
  json: boolean;
}

export type CliCommand =
  | { command: 'server' }
  | { command: 'help' }
  | { command: 'version' }
  | { command: 'token'; options: TokenOptions }
  | { command: 'token-help' }
  /** Printed with the usage of `usage` on stderr; exit code 2. */
  | { command: 'usage-error'; message: string; usage: 'main' | 'token' };

const HELP_FLAGS = ['--help', '-h'];
const VERSION_FLAGS = ['--version', '-v'];

export function parseArgs(argv: readonly string[]): CliCommand {
  const [first, ...rest] = argv;
  if (first === undefined) return { command: 'server' };
  if (first === 'token') return parseTokenArgs(rest);
  if (HELP_FLAGS.includes(first) || VERSION_FLAGS.includes(first)) {
    if (rest.length > 0) return { command: 'usage-error', message: `unexpected argument: ${rest[0]}`, usage: 'main' };
    return { command: HELP_FLAGS.includes(first) ? 'help' : 'version' };
  }
  const message = first.startsWith('-') ? `unknown option: ${first}` : `unknown command: ${first}`;
  return { command: 'usage-error', message, usage: 'main' };
}

function parseTokenArgs(args: readonly string[]): CliCommand {
  if (args.some((arg) => HELP_FLAGS.includes(arg))) return { command: 'token-help' };
  const usageError = (message: string): CliCommand => ({ command: 'usage-error', message, usage: 'token' });

  const options: TokenOptions = { json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    // `--label <text>` or `--label=<text>`; only the second form takes a value that starts with "-".
    const [name, inlineValue] = arg.startsWith('--') && arg.includes('=') ? splitAtEquals(arg) : [arg, undefined];
    if (name === '--json') return usageError('--json does not take a value');
    if (name !== '--label' && name !== '--api-url') {
      return usageError(arg.startsWith('-') ? `unknown option: ${name}` : `unexpected argument: ${arg}`);
    }
    let value = inlineValue;
    if (value === undefined) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        value = next;
        i++;
      }
    }
    if (!value) return usageError(`${name} needs a value`);
    if (name === '--label') options.label = value;
    else options.apiUrl = value;
  }
  return { command: 'token', options };
}

function splitAtEquals(arg: string): [string, string] {
  const index = arg.indexOf('=');
  return [arg.slice(0, index), arg.slice(index + 1)];
}
