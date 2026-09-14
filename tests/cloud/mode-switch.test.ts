// Operating mode selection (docs/cloud-architecture.md §5.1)
// - AGENT_COMM_TOKEN set     -> cloud mode (also when AGENT_COMM_DATA_DIR is set), at AGENT_COMM_API_URL or else the
//                               default https://agora.omajinai.work
// - AGENT_COMM_TOKEN not set -> file mode (AGENT_COMM_API_URL alone is ignored), with one line about it on stderr
// The cloud side is checked against the agora started by the harness, the file side on disk. Nothing here contacts the
// default (production) URL: configurations without AGENT_COMM_API_URL are only resolved, never used for requests.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  DEFAULT_API_URL,
  cloudFetch,
  fileModeNotice,
  getCloudBackend,
  getOperatingMode,
  resolveCloudConfig,
} from '../../src/cloud/index.js';
import { createMcpClient, withEnv, type McpTestClient } from './harness/mcp.js';

const apiUrl = process.env.AGENT_COMM_API_URL!;
const token = process.env.AGENT_COMM_TOKEN!;

async function cloudRoomNames(): Promise<string[]> {
  const response = await cloudFetch(`${apiUrl}/rooms`, { headers: { authorization: `Bearer ${token}` } });
  const body = (await response.json()) as { rooms: Array<{ name: string }> };
  return body.rooms.map((room) => room.name);
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

describe('operating mode selection', () => {
  let dataDir: string;
  let client: McpTestClient | undefined;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-comm-mode-'));
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  describe('resolveCloudConfig', () => {
    it('uses cloud mode at the default API URL when only AGENT_COMM_TOKEN is set', () => {
      expect(DEFAULT_API_URL).toBe('https://agora.omajinai.work');
      const env = { AGENT_COMM_TOKEN: 'agora_x' };
      expect(resolveCloudConfig(env)).toEqual({ apiUrl: 'https://agora.omajinai.work', token: 'agora_x' });
      expect(getOperatingMode(env)).toBe('cloud');
      // An empty AGENT_COMM_API_URL does not override the default either.
      expect(resolveCloudConfig({ AGENT_COMM_API_URL: ' ', AGENT_COMM_TOKEN: 'agora_x' })?.apiUrl).toBe(DEFAULT_API_URL);
    });

    it('uses AGENT_COMM_API_URL when it is set together with the token', () => {
      const env = { AGENT_COMM_API_URL: 'http://localhost:8787', AGENT_COMM_TOKEN: 'agora_x' };
      expect(resolveCloudConfig(env)).toEqual({ apiUrl: 'http://localhost:8787', token: 'agora_x' });
      expect(getOperatingMode(env)).toBe('cloud');
    });

    it('uses file mode without AGENT_COMM_TOKEN: AGENT_COMM_DATA_DIR only, nothing at all, or an empty token', () => {
      for (const env of [{ AGENT_COMM_DATA_DIR: '/tmp/data' }, {}, { AGENT_COMM_TOKEN: '  ' }]) {
        expect(resolveCloudConfig(env)).toBeNull();
        expect(getOperatingMode(env)).toBe('file');
      }
    });

    it('ignores AGENT_COMM_API_URL without a token (file mode)', () => {
      const env = { AGENT_COMM_API_URL: 'http://localhost:8787' };
      expect(resolveCloudConfig(env)).toBeNull();
      expect(getOperatingMode(env)).toBe('file');
    });

    it('prefers cloud mode when the data directory is configured as well', () => {
      expect(getOperatingMode({ AGENT_COMM_DATA_DIR: '/tmp/data', AGENT_COMM_TOKEN: 't' })).toBe('cloud');
      expect(getOperatingMode({ AGENT_COMM_DATA_DIR: '/tmp/data', AGENT_COMM_API_URL: 'http://localhost:8787', AGENT_COMM_TOKEN: 't' })).toBe(
        'cloud',
      );
    });

    it('normalizes the API URL and rejects URLs that are not http(s)', () => {
      expect(resolveCloudConfig({ AGENT_COMM_API_URL: 'https://example.com/base/', AGENT_COMM_TOKEN: 't' })?.apiUrl).toBe(
        'https://example.com/base',
      );
      expect(() => resolveCloudConfig({ AGENT_COMM_API_URL: 'ftp://example.com', AGENT_COMM_TOKEN: 't' })).toThrow(/http or https/);
      expect(() => resolveCloudConfig({ AGENT_COMM_API_URL: 'not a url', AGENT_COMM_TOKEN: 't' })).toThrow(/not a valid URL/);
    });
  });

  describe('fileModeNotice (the stderr line at startup)', () => {
    it('says that the server starts in file mode because AGENT_COMM_TOKEN is not set', () => {
      expect(fileModeNotice({})).toBe('AGENT_COMM_TOKEN が未設定のためファイルモードで起動');
      expect(fileModeNotice({ AGENT_COMM_DATA_DIR: '/tmp/data' })).toBe('AGENT_COMM_TOKEN が未設定のためファイルモードで起動');
    });

    it('adds that AGENT_COMM_API_URL is ignored when it is set without a token', () => {
      expect(fileModeNotice({ AGENT_COMM_API_URL: 'http://localhost:8787' })).toBe(
        'AGENT_COMM_TOKEN が未設定のためファイルモードで起動（AGENT_COMM_API_URL は無視）',
      );
    });

    it('is not written in cloud mode', () => {
      expect(fileModeNotice({ AGENT_COMM_TOKEN: 't' })).toBeNull();
      expect(fileModeNotice({ AGENT_COMM_TOKEN: 't', AGENT_COMM_API_URL: 'http://localhost:8787' })).toBeNull();
    });
  });

  describe('MCP server', () => {
    it('stores rooms in the cloud in cloud mode and writes nothing to the data directory', async () => {
      client = await withEnv({ AGENT_COMM_DATA_DIR: dataDir }, () => createMcpClient(dataDir));
      expect(client.registry.mode).toBe('cloud');

      await client.call('create_room', { roomName: 'cloud-only-room' });
      await client.call('enter_room', { agentName: 'alice', roomName: 'cloud-only-room' });
      await client.call('send_message', { agentName: 'alice', roomName: 'cloud-only-room', message: 'hi' });

      expect(await cloudRoomNames()).toEqual(['cloud-only-room']);
      expect(await fs.readdir(dataDir)).toEqual([]);
    });

    it('stores rooms on disk in file mode and never calls the cloud API', async () => {
      client = await withEnv(
        { AGENT_COMM_DATA_DIR: dataDir, AGENT_COMM_API_URL: undefined, AGENT_COMM_TOKEN: undefined },
        () => createMcpClient(dataDir),
      );
      expect(client.registry.mode).toBe('file');

      await client.call('create_room', { roomName: 'file-only-room' });
      await client.call('enter_room', { agentName: 'alice', roomName: 'file-only-room' });

      const rooms = JSON.parse(await fs.readFile(path.join(dataDir, 'rooms.json'), 'utf8'));
      expect(Object.keys(rooms.rooms)).toEqual(['file-only-room']);
      expect(await exists(path.join(dataDir, 'rooms', 'file-only-room', 'presence.json'))).toBe(true);
      expect(await cloudRoomNames()).toEqual([]);
    });

    it('keeps file mode when only AGENT_COMM_API_URL is set', async () => {
      client = await withEnv(
        { AGENT_COMM_DATA_DIR: dataDir, AGENT_COMM_API_URL: apiUrl, AGENT_COMM_TOKEN: undefined },
        () => createMcpClient(dataDir),
      );
      expect(client.registry.mode).toBe('file');

      await client.call('create_room', { roomName: 'still-file-room' });
      expect(await exists(path.join(dataDir, 'rooms.json'))).toBe(true);
      expect(await cloudRoomNames()).toEqual([]);
    });

    it('runs in cloud mode at the default API URL with only a token, without contacting it on start', async () => {
      const onlyToken = { AGENT_COMM_DATA_DIR: dataDir, AGENT_COMM_API_URL: undefined, AGENT_COMM_TOKEN: 'agora_mode_switch_token' };
      client = await withEnv(onlyToken, () => createMcpClient(dataDir));
      expect(client.registry.mode).toBe('cloud');
      // The backend the adapters share points at the default URL (no tool is called: that would reach production).
      expect(getCloudBackend({ AGENT_COMM_TOKEN: 'agora_mode_switch_token' })!.config).toEqual({
        apiUrl: DEFAULT_API_URL,
        token: 'agora_mode_switch_token',
      });
      expect(await fs.readdir(dataDir)).toEqual([]);
    });

    it('lets file mode and cloud mode run side by side without sharing data', async () => {
      const cloud = await createMcpClient(dataDir);
      client = await withEnv(
        { AGENT_COMM_DATA_DIR: dataDir, AGENT_COMM_API_URL: undefined, AGENT_COMM_TOKEN: undefined },
        () => createMcpClient(dataDir),
      );
      try {
        await cloud.call('create_room', { roomName: 'shared-name' });
        await client.call('create_room', { roomName: 'shared-name' });

        expect((await cloud.call('list_rooms')).rooms.map((r: { name: string }) => r.name)).toEqual(['shared-name']);
        expect((await client.call('list_rooms')).rooms.map((r: { name: string }) => r.name)).toEqual(['shared-name']);
        await cloud.call('enter_room', { agentName: 'cloud-agent', roomName: 'shared-name' });
        expect((await client.call('list_room_users', { roomName: 'shared-name' })).users).toEqual([]);
      } finally {
        await cloud.close();
      }
    });
  });
});
