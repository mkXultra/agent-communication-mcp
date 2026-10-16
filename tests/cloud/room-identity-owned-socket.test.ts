// Owned cloud socket release after a failed owned leave (round-2 accepted fix:
// failed-owned-leave-clears-binding-and-orphans-cloud-socket). Kept in its own file so the shared per-token
// WebSocket backend for these tests starts fresh: the WebSocket-retry cooldown left by the longer
// room-identity.test.ts run would otherwise keep the socket on the long-poll fallback and make these assertions
// vacuous.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CloudApiClient, getCloudBackend } from '../../src/cloud/index.js';
import { createMcpClient, waitUntil, type McpTestClient } from './harness/mcp.js';

const agoraUrl = process.env.AGENT_COMM_API_URL!;
const token = process.env.AGENT_COMM_TOKEN!;

describe('room identity owned-socket release', () => {
  let client: McpTestClient;
  let api: CloudApiClient;

  /** The member rows of a room, by name. */
  const membersOf = async (roomName: string) => {
    const list = await api.listMembers(roomName);
    return Object.fromEntries(list.members.map((member) => [member.agentName, member]));
  };

  beforeEach(async () => {
    client = await createMcpClient();
    api = new CloudApiClient({ apiUrl: agoraUrl, token });
  });

  afterEach(async () => {
    await client.close();
  });

  it('releases only the instance-owned socket when a selected-name leave takes effect but rejects before disconnect', async () => {
    const roomName = 'owned-socket-selected-leave';
    await client.call('create_room', { roomName });
    await client.call('enter_room', { agentName: 'alice', roomName });
    const other = await createMcpClient();
    try {
      await other.call('enter_room', { agentName: 'bob', roomName });

      const backend = getCloudBackend()!;
      const aliceWait = client.call('wait_for_messages', { roomName, timeout: 0 });
      aliceWait.catch(() => undefined);
      const bobWait = other.call('wait_for_messages', { roomName, timeout: 0 });
      bobWait.catch(() => undefined);
      await waitUntil(() => backend.waits.hasOpenSocket(roomName, 'alice'), 5000, 'alice socket');
      await waitUntil(() => backend.waits.hasOpenSocket(roomName, 'bob'), 5000, 'bob socket');

      // The real HTTP leave takes effect on the server, then the call rejects before CloudRoomsService disconnects.
      const cloudApi = (client.registry as any).roomsAdapter.cloud.api;
      const realLeave = cloudApi.leaveRoom.bind(cloudApi);
      let injected = false;
      cloudApi.leaveRoom = async (room: string, name: string) => {
        const result = await realLeave(room, name);
        if (!injected && name === 'alice') {
          injected = true;
          throw new Error('injected: leave response lost after its effect');
        }
        return result;
      };
      try {
        await expect(client.call('leave_room', { agentName: 'alice', roomName })).rejects.toThrow(
          /leave response lost after its effect/,
        );
      } finally {
        cloudApi.leaveRoom = realLeave;
      }
      expect(injected).toBe(true);

      // The server applied the leave; the local binding is cleared and this instance's socket is released with it.
      expect((await membersOf(roomName)).alice?.status).toBe('offline');
      await expect(client.call('send_message', { roomName, message: 'x' })).rejects.toThrow(/has not entered room/);
      await waitUntil(() => !backend.waits.hasOpenSocket(roomName, 'alice'), 5000, 'alice socket released');
      expect((client.registry as any).identity.ownedIdentities()).toEqual([]);
      await expect(aliceWait).rejects.toThrow(/Waiting for messages ended without a result/);

      // The other same-token connection is untouched, and repeated shutdown cannot orphan anything.
      expect(backend.waits.hasOpenSocket(roomName, 'bob')).toBe(true);
      expect((await membersOf(roomName)).bob?.status).toBe('online');
      await client.registry.shutdown();
      await client.registry.shutdown();
      expect(backend.waits.hasOpenSocket(roomName, 'alice')).toBe(false);
      expect(backend.waits.hasOpenSocket(roomName, 'bob')).toBe(true);
      expect((await other.call('send_message', { roomName, message: 'from bob' })).success).toBe(true);
    } finally {
      await other.close();
    }
  });

  it('releases the old-name socket when a switch old-name leave takes effect but rejects before disconnect', async () => {
    const roomName = 'owned-socket-switch-leave';
    await client.call('create_room', { roomName });
    await client.call('enter_room', { agentName: 'alice', roomName });

    const backend = getCloudBackend()!;
    const aliceWait = client.call('wait_for_messages', { roomName, timeout: 0 });
    aliceWait.catch(() => undefined);
    await waitUntil(() => backend.waits.hasOpenSocket(roomName, 'alice'), 5000, 'alice socket');

    const cloudApi = (client.registry as any).roomsAdapter.cloud.api;
    const realLeave = cloudApi.leaveRoom.bind(cloudApi);
    let injected = false;
    cloudApi.leaveRoom = async (room: string, name: string) => {
      const result = await realLeave(room, name);
      if (!injected && name === 'alice') {
        injected = true;
        throw new Error('injected: leave response lost after its effect');
      }
      return result;
    };
    try {
      await expect(client.call('enter_room', { agentName: 'bob', roomName })).rejects.toThrow(
        /leave response lost after its effect/,
      );
    } finally {
      cloudApi.leaveRoom = realLeave;
    }
    expect(injected).toBe(true);

    expect((await membersOf(roomName)).alice?.status).toBe('offline');
    await expect(client.call('send_message', { roomName, message: 'x' })).rejects.toThrow(/has not entered room/);
    await waitUntil(() => !backend.waits.hasOpenSocket(roomName, 'alice'), 5000, 'alice socket released');

    await client.registry.shutdown();
    await client.registry.shutdown();
    expect(backend.waits.hasOpenSocket(roomName, 'alice')).toBe(false);
  });
});
