import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, '../../dist/index.js');
const testDataDir = path.join(__dirname, '../../test-data-e2e');

// Skip this test suite in unit test environment (requires built server)
const skipInUnitTests = process.env.VITEST_POOL_ID && !process.env.E2E_TESTS;

describe.skipIf(skipInUnitTests)('E2E: MCP Server', () => {
  let serverProcess: ChildProcess;
  let messageId = 1;
  /** Everything the server wrote to stdout, the MCP channel. */
  let stdout = '';

  beforeAll(async () => {
    // Clean and create test data directory
    await fs.rm(testDataDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(testDataDir, { recursive: true });

    // Check if server is built
    try {
      await fs.access(serverPath);
    } catch {
      throw new Error('Server not built. Run "npm run build" first.');
    }

    // Start MCP server
    serverProcess = spawn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AGENT_COMM_DATA_DIR: testDataDir
      }
    });
    serverProcess.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    // Wait for server to start
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Server startup timeout'));
      }, 5000);

      serverProcess.stderr?.on('data', (data) => {
        const output = data.toString();
        console.log('Server output:', output);
        if (output.includes('Agent Communication MCP Server started')) {
          clearTimeout(timeout);
          resolve();
        }
      });

      serverProcess.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  });

  afterAll(async () => {
    // Kill server process
    if (serverProcess) {
      serverProcess.kill();
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Clean up test data
    await fs.rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });

  // Helper to send JSON-RPC request
  async function sendRequest(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const request = {
        jsonrpc: '2.0',
        id: messageId++,
        method,
        params
      };

      const requestStr = JSON.stringify(request) + '\n';
      let responseData = '';

      const handleData = (data: Buffer) => {
        responseData += data.toString();
        try {
          const lines = responseData.split('\n');
          for (const line of lines) {
            if (line.trim()) {
              const response = JSON.parse(line);
              if (response.id === request.id) {
                serverProcess.stdout?.off('data', handleData);
                if (response.error) {
                  reject(new Error(response.error.message));
                } else {
                  resolve(response.result);
                }
                return;
              }
            }
          }
        } catch (e) {
          // Incomplete JSON, wait for more data
        }
      };

      serverProcess.stdout?.on('data', handleData);
      serverProcess.stdin?.write(requestStr);

      // Timeout after 5 seconds
      setTimeout(() => {
        serverProcess.stdout?.off('data', handleData);
        reject(new Error('Request timeout'));
      }, 5000);
    });
  }

  describe('Tool Discovery', () => {
    it('should list all available tools', async () => {
      const result = await sendRequest('tools/list');
      
      expect(result.tools).toBeDefined();
      expect(result.tools).toHaveLength(10);
      
      const toolNames = result.tools.map((t: any) => t.name);
      expect(toolNames).toContain('agent_communication_list_rooms');
      expect(toolNames).toContain('agent_communication_create_room');
      expect(toolNames).toContain('agent_communication_enter_room');
      expect(toolNames).toContain('agent_communication_leave_room');
      expect(toolNames).toContain('agent_communication_list_room_users');
      expect(toolNames).toContain('agent_communication_send_message');
      expect(toolNames).toContain('agent_communication_get_messages');
      expect(toolNames).toContain('agent_communication_wait_for_messages');
      expect(toolNames).toContain('agent_communication_get_status');
      expect(toolNames).toContain('agent_communication_clear_room_messages');
    });
  });

  describe('Room Management Flow', () => {
    const testRoomName = 'e2e-test-room';
    const testAgentName = 'e2e-test-agent';

    it('should complete full room lifecycle', async () => {
      // 1. Create room
      const createResult = await sendRequest('tools/call', {
        name: 'agent_communication_create_room',
        arguments: {
          roomName: testRoomName,
          description: 'E2E test room'
        }
      });
      
      expect(createResult.content[0].text).toContain('"success":true');
      expect(createResult.content[0].text).toContain(testRoomName);

      // 2. List rooms
      const listResult = await sendRequest('tools/call', {
        name: 'agent_communication_list_rooms',
        arguments: {}
      });
      
      const listData = JSON.parse(listResult.content[0].text);
      expect(listData.rooms).toHaveLength(1);
      expect(listData.rooms[0].name).toBe(testRoomName);

      // 3. Enter room
      const enterResult = await sendRequest('tools/call', {
        name: 'agent_communication_enter_room',
        arguments: {
          agentName: testAgentName,
          roomName: testRoomName
        }
      });
      
      expect(enterResult.content[0].text).toContain('"success":true');

      // 4. List room users
      const usersResult = await sendRequest('tools/call', {
        name: 'agent_communication_list_room_users',
        arguments: {
          roomName: testRoomName
        }
      });
      
      const usersData = JSON.parse(usersResult.content[0].text);
      expect(usersData.users).toHaveLength(1);
      expect(usersData.users[0].name).toBe(testAgentName);

      // 5. Send message
      const sendResult = await sendRequest('tools/call', {
        name: 'agent_communication_send_message',
        arguments: {
          agentName: testAgentName,
          roomName: testRoomName,
          message: 'Hello from E2E test!'
        }
      });
      
      const sendData = JSON.parse(sendResult.content[0].text);
      expect(sendData.success).toBe(true);
      expect(sendData.messageId).toBeDefined();

      // 6. Get messages
      const messagesResult = await sendRequest('tools/call', {
        name: 'agent_communication_get_messages',
        arguments: {
          roomName: testRoomName
        }
      });
      
      const messagesData = JSON.parse(messagesResult.content[0].text);
      expect(messagesData.messages).toHaveLength(1);
      expect(messagesData.messages[0].message).toBe('Hello from E2E test!');

      // 7. Get status
      const statusResult = await sendRequest('tools/call', {
        name: 'agent_communication_get_status',
        arguments: {}
      });
      
      const statusData = JSON.parse(statusResult.content[0].text);
      expect(statusData.totalRooms).toBe(1);
      expect(statusData.totalMessages).toBe(1);

      // 8. Leave room
      const leaveResult = await sendRequest('tools/call', {
        name: 'agent_communication_leave_room',
        arguments: {
          agentName: testAgentName,
          roomName: testRoomName
        }
      });
      
      expect(leaveResult.content[0].text).toContain('"success":true');

      // 9. Clear messages
      const clearResult = await sendRequest('tools/call', {
        name: 'agent_communication_clear_room_messages',
        arguments: {
          roomName: testRoomName,
          confirm: true
        }
      });
      
      const clearData = JSON.parse(clearResult.content[0].text);
      expect(clearData.success).toBe(true);
      expect(clearData.clearedCount).toBe(1);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid tool calls', async () => {
      await expect(
        sendRequest('tools/call', {
          name: 'agent_communication_invalid_tool',
          arguments: {}
        })
      ).rejects.toThrow(/Unknown tool/);
    });

    it('should handle validation errors', async () => {
      await expect(
        sendRequest('tools/call', {
          name: 'agent_communication_create_room',
          arguments: {
            roomName: 'invalid room name!', // Contains invalid characters
            description: 'Test'
          }
        })
      ).rejects.toThrow(/validation|must contain only/i);
    });
  });

  describe('stdout', () => {
    it('carries nothing but JSON-RPC messages', () => {
      const lines = stdout.split('\n').filter((line) => line.trim() !== '');
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
      }
    });
  });
});

// The built bin with arguments (src/cli): it prints and exits instead of starting the server.
describe.skipIf(skipInUnitTests)('E2E: bin command line', () => {
  const packageJsonPath = path.join(__dirname, '../../package.json');

  function runBin(args: string[], env: Record<string, string | undefined> = {}) {
    const child = spawn('node', [serverPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGENT_COMM_DATA_DIR: testDataDir, ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (data) => (out += data.toString()));
    child.stderr.on('data', (data) => (err += data.toString()));
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`node dist/index.js ${args.join(' ')} did not exit`));
      }, 10000);
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(timeout);
        resolve({ code, stdout: out, stderr: err });
      });
    });
  }

  it('--version prints the package version and exits 0', async () => {
    const { version } = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
    for (const flag of ['--version', '-v']) {
      expect(await runBin([flag])).toEqual({ code: 0, stdout: `${version}\n`, stderr: '' });
    }
  });

  it('--help and token --help print the usage and exit 0', async () => {
    const help = await runBin(['--help']);
    expect(help).toMatchObject({ code: 0, stderr: '' });
    expect(help.stdout).toMatch(/^Usage: agent-communication-mcp \[command\]\n/);

    const tokenHelp = await runBin(['token', '--help']);
    expect(tokenHelp).toMatchObject({ code: 0, stderr: '' });
    expect(tokenHelp.stdout).toMatch(/^Usage: agent-communication-mcp token \[--label <text>\] \[--api-url <url>\] \[--json\]\n/);
  });

  it('an unknown command prints the usage on stderr and exits 2', async () => {
    const result = await runBin(['serve']);
    expect(result).toMatchObject({ code: 2, stdout: '' });
    expect(result.stderr).toMatch(/^error: unknown command: serve\n\nUsage: agent-communication-mcp \[command\]\n/);
  });

  it('token --json prints only the API response as returned, with apiUrl added', async () => {
    const issued = { token: 'agora_e2e', tokenId: 'tk_e2e', userId: 'u_e2e', name: 'e2e', notYetKnown: [1] };
    const api = http.createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify(issued));
      });
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    try {
      const result = await runBin(['token', '--json', '--label', 'e2e'], { AGENT_COMM_API_URL: apiUrl });
      expect(result).toEqual({ code: 0, stdout: `${JSON.stringify({ ...issued, apiUrl }, null, 2)}\n`, stderr: '' });
    } finally {
      api.closeAllConnections();
      await new Promise((resolve) => api.close(resolve));
    }
  });
});