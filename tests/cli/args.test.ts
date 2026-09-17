// The command line of the package's bin (src/index.ts -> src/cli/main.ts): what runs for which arguments, what is
// written where, and the exit code. The MCP server and the token command are stand-ins: nothing is started or sent.

import { describe, expect, it, vi } from 'vitest';
import type { TokenOptions } from '../../src/cli/args.js';
import { runCli, TOKEN_USAGE, USAGE } from '../../src/cli/main.js';
import type { CliOutput } from '../../src/cli/token.js';

function cli(tokenExitCode = 0) {
  let stdout = '';
  let stderr = '';
  const out: CliOutput = {
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const startServer = vi.fn(async () => undefined);
  const runToken = vi.fn(async (_options: TokenOptions, _out: CliOutput) => tokenExitCode);
  return {
    run: (...argv: string[]) => runCli(argv, { version: '9.8.7', startServer, runToken, out }),
    out,
    startServer,
    runToken,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe('command line', () => {
  describe('without arguments', () => {
    it('starts the MCP server, writes nothing and leaves the exit code to the server', async () => {
      const c = cli();
      const result = c.run();
      // Started right away, while the bin module is being loaded, as before the command line existed.
      expect(c.startServer).toHaveBeenCalledTimes(1);
      expect(await result).toBeUndefined();
      expect(c.startServer).toHaveBeenCalledWith();
      expect(c.runToken).not.toHaveBeenCalled();
      expect(c.stdout()).toBe('');
      expect(c.stderr()).toBe('');
    });

    it('resolves only once the server has started', async () => {
      const c = cli();
      let started!: () => void;
      c.startServer.mockImplementation(() => new Promise<undefined>((resolve) => (started = () => resolve(undefined))));
      let settled = false;
      const result = c.run().then((code) => {
        settled = true;
        return code;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);
      started();
      expect(await result).toBeUndefined();
    });
  });

  describe('token', () => {
    it.each<[string[], TokenOptions]>([
      [[], { json: false }],
      [['--label', 'my-laptop'], { label: 'my-laptop', json: false }],
      [['--label=my laptop'], { label: 'my laptop', json: false }],
      [['--label=--json'], { label: '--json', json: false }],
      [['--label=a=b'], { label: 'a=b', json: false }],
      [['--api-url', 'http://127.0.0.1:8787'], { apiUrl: 'http://127.0.0.1:8787', json: false }],
      [['--api-url=http://127.0.0.1:8787/?a=b'], { apiUrl: 'http://127.0.0.1:8787/?a=b', json: false }],
      [['--json'], { json: true }],
      [
        ['--json', '--api-url', 'https://example.com', '--label', 'ci'],
        { label: 'ci', apiUrl: 'https://example.com', json: true },
      ],
      [['--label', 'first', '--label', 'second', '--json', '--json'], { label: 'second', json: true }],
    ])('token %j runs the token command with %j', async (args, options) => {
      const c = cli();
      expect(await c.run('token', ...args)).toBe(0);
      expect(c.runToken).toHaveBeenCalledTimes(1);
      expect(c.runToken.mock.calls[0]![0]).toStrictEqual(options);
      expect(c.runToken.mock.calls[0]![1]).toBe(c.out);
      expect(c.startServer).not.toHaveBeenCalled();
      expect(c.stdout()).toBe('');
      expect(c.stderr()).toBe('');
    });

    it('exits with the exit code of the token command', async () => {
      const c = cli(1);
      expect(await c.run('token', '--json')).toBe(1);
    });

    it.each<[string[]]>([[['--help']], [['-h']], [['--json', '--help']], [['--label', 'x', '-h']], [['--bogus', '--help']]])(
      'token %j prints the usage of token on stdout and exits 0',
      async (args) => {
        const c = cli();
        expect(await c.run('token', ...args)).toBe(0);
        expect(c.stdout()).toBe(TOKEN_USAGE);
        expect(c.stderr()).toBe('');
        expect(c.runToken).not.toHaveBeenCalled();
        expect(c.startServer).not.toHaveBeenCalled();
      },
    );

    it.each<[string[], string]>([
      [['--label'], '--label needs a value'],
      [['--label', '--json'], '--label needs a value'],
      [['--label', '-x'], '--label needs a value'],
      [['--label='], '--label needs a value'],
      [['--api-url'], '--api-url needs a value'],
      [['--api-url', '--label', 'x'], '--api-url needs a value'],
      [['--api-url='], '--api-url needs a value'],
      [['--json=true'], '--json does not take a value'],
      [['--bogus'], 'unknown option: --bogus'],
      [['--bogus=1'], 'unknown option: --bogus'],
      [['-l', 'x'], 'unknown option: -l'],
      [['--LABEL', 'x'], 'unknown option: --LABEL'],
      [['my-laptop'], 'unexpected argument: my-laptop'],
      [['--label', 'a', 'b'], 'unexpected argument: b'],
      [['--json', 'token'], 'unexpected argument: token'],
    ])('token %j is a usage error: %s (exit 2)', async (args, message) => {
      const c = cli();
      expect(await c.run('token', ...args)).toBe(2);
      expect(c.stderr()).toBe(`error: ${message}\n\n${TOKEN_USAGE}`);
      expect(c.stdout()).toBe('');
      expect(c.runToken).not.toHaveBeenCalled();
      expect(c.startServer).not.toHaveBeenCalled();
    });
  });

  describe('--help and --version', () => {
    it.each([['--help'], ['-h']])('%s prints the usage on stdout and exits 0', async (flag) => {
      const c = cli();
      expect(await c.run(flag)).toBe(0);
      expect(c.stdout()).toBe(USAGE);
      expect(c.stderr()).toBe('');
      expect(c.startServer).not.toHaveBeenCalled();
      expect(c.runToken).not.toHaveBeenCalled();
    });

    it.each([['--version'], ['-v']])('%s prints the version on stdout and exits 0', async (flag) => {
      const c = cli();
      expect(await c.run(flag)).toBe(0);
      expect(c.stdout()).toBe('9.8.7\n');
      expect(c.stderr()).toBe('');
      expect(c.startServer).not.toHaveBeenCalled();
      expect(c.runToken).not.toHaveBeenCalled();
    });

    it('describes the commands and options', () => {
      expect(USAGE).toMatch(/^Usage: agent-communication-mcp \[command\]\n/);
      for (const text of ['token', '-h, --help', '-v, --version', 'agent-communication-mcp token --help']) {
        expect(USAGE).toContain(text);
      }
      expect(TOKEN_USAGE).toMatch(/^Usage: agent-communication-mcp token \[--label <text>\] \[--api-url <url>\] \[--json\]\n/);
      for (const text of [
        'AGENT_COMM_API_URL',
        'https://agora.omajinai.work',
        '5 per hour and 20 per day',
        '100 characters',
        "the API's response as returned",
        'name = the label',
        'with apiUrl added',
      ]) {
        expect(TOKEN_USAGE).toContain(text);
      }
    });
  });

  describe('anything else', () => {
    it.each<[string[], string]>([
      [['bogus'], 'unknown command: bogus'],
      [['Token'], 'unknown command: Token'],
      [['help'], 'unknown command: help'],
      [['tokens', '--json'], 'unknown command: tokens'],
      [['--bogus'], 'unknown option: --bogus'],
      [['-x'], 'unknown option: -x'],
      [['--json'], 'unknown option: --json'],
      [['--help', 'token'], 'unexpected argument: token'],
      [['--version', '--json'], 'unexpected argument: --json'],
    ])('%j prints the usage on stderr and exits 2 (%s)', async (argv, message) => {
      const c = cli();
      expect(await c.run(...argv)).toBe(2);
      expect(c.stderr()).toBe(`error: ${message}\n\n${USAGE}`);
      expect(c.stdout()).toBe('');
      expect(c.startServer).not.toHaveBeenCalled();
      expect(c.runToken).not.toHaveBeenCalled();
    });
  });
});
