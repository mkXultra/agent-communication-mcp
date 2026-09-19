// `profile` on enter_room in cloud mode (0.7.0), against the real agora: the profile reaches
// POST /rooms/{roomName}/join and comes back from GET /rooms/{roomName}/members (list_room_users).
// agora keeps the stored profile when a join omits it (`profile = COALESCE(excluded.profile, members.profile)`),
// which is what the file mode does as well (tests/rooms/integration/enter-room-profile.test.ts).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CloudApiClient } from '../../src/cloud/index.js';
import { createMcpClient, withEnv, type McpTestClient } from './harness/mcp.js';
import { AgoraProxy } from './harness/proxy.js';

const agoraUrl = process.env.AGENT_COMM_API_URL!;
const token = process.env.AGENT_COMM_TOKEN!;

const REVIEWER = { role: 'reviewer', description: 'claude-opus / mac-mini, reviews PRs' };

describe('enter_room profile in cloud mode', () => {
  let client: McpTestClient;
  const api = new CloudApiClient({ apiUrl: agoraUrl, token });

  beforeEach(async () => {
    client = await createMcpClient();
    await client.call('create_room', { roomName: 'profiles' });
  });

  afterEach(async () => {
    await client.close();
  });

  /** The member row agora stores, straight from GET /rooms/profiles/members. */
  async function member(agentName: string) {
    const list = await api.listMembers('profiles', true);
    return list.members.find((m) => m.agentName === agentName);
  }

  it('sends the profile to agora and returns it from list_room_users', async () => {
    const profile = { ...REVIEWER, capabilities: ['review', 'typescript'], metadata: { host: 'mac-mini' } };
    expect(await client.call('enter_room', { agentName: 'alice', roomName: 'profiles', profile })).toEqual({ success: true });

    expect((await member('alice'))?.profile).toEqual(profile);
    expect(await client.call('list_room_users', { roomName: 'profiles' })).toEqual({
      roomName: 'profiles',
      users: [{ name: 'alice', status: 'online', messageCount: 0, profile }],
      onlineCount: 1,
    });
  });

  it('keeps the previous profile when re-entering without one, and replaces it with a new one', async () => {
    await client.call('enter_room', { agentName: 'alice', roomName: 'profiles', profile: REVIEWER });

    await client.call('enter_room', { agentName: 'alice', roomName: 'profiles' });
    expect((await member('alice'))?.profile).toEqual(REVIEWER);

    // Also after leaving: the member row stays and keeps the profile.
    await client.call('leave_room', { agentName: 'alice', roomName: 'profiles' });
    await client.call('enter_room', { agentName: 'alice', roomName: 'profiles' });
    expect((await member('alice'))?.profile).toEqual(REVIEWER);

    await client.call('enter_room', { agentName: 'alice', roomName: 'profiles', profile: { role: 'builder' } });
    expect((await member('alice'))?.profile).toEqual({ role: 'builder' });
  });

  it('accepts a profile at the limits of agora AgentProfile', async () => {
    const profile = {
      role: 'r'.repeat(100),
      description: 'd'.repeat(500),
      capabilities: Array.from({ length: 50 }, () => 'c'.repeat(100)),
      metadata: { nested: { team: 'frontend' } },
    };
    expect(await client.call('enter_room', { agentName: 'alice', roomName: 'profiles', profile })).toEqual({ success: true });
    expect((await member('alice'))?.profile).toEqual(profile);
  });

  it('measures the limits in code points, so it does not refuse a profile agora accepts', async () => {
    const emoji = String.fromCodePoint(0x1f600);
    // 60 emoji are 60 code points but 120 UTF-16 code units: agora counts code points and takes this profile.
    const profile = { role: emoji.repeat(60), description: emoji.repeat(300), capabilities: [emoji.repeat(100)] };
    expect(await client.call('enter_room', { agentName: 'alice', roomName: 'profiles', profile })).toEqual({ success: true });
    expect((await member('alice'))?.profile).toEqual(profile);

    // 101 code points is over the limit for both.
    await expect(
      client.call('enter_room', { agentName: 'alice', roomName: 'profiles', profile: { role: emoji.repeat(101) } }),
    ).rejects.toThrow(/Validation error: .*Profile role cannot exceed 100 characters/s);
  });
});

describe('an oversized profile is rejected without a join request', () => {
  let proxy: AgoraProxy;
  let client: McpTestClient;

  beforeAll(async () => {
    proxy = await AgoraProxy.start(agoraUrl);
  });

  afterAll(async () => {
    await proxy.close();
  });

  beforeEach(async () => {
    client = await withEnv({ AGENT_COMM_API_URL: proxy.url, AGENT_COMM_TOKEN: token }, () => createMcpClient());
    await client.call('create_room', { roomName: 'profiles' });
  });

  afterEach(async () => {
    await client.close();
  });

  it('checks the profile locally: nothing is posted to /rooms/profiles/join', async () => {
    proxy.requests.length = 0;

    // Both are refused by the zod schema of the handler, before the adapter sends anything.
    await expect(
      client.call('enter_room', { agentName: 'alice', roomName: 'profiles', profile: { role: 'r'.repeat(101) } }),
    ).rejects.toThrow(/Validation error: .*Profile role cannot exceed 100 characters/s);
    await expect(
      client.call('enter_room', { agentName: 'alice', roomName: 'profiles', profile: { role: 'r', nickname: 'al' } }),
    ).rejects.toThrow(/Validation error: .*Unrecognized key\(s\) in object: 'nickname'/s);

    expect(proxy.countRequests('POST', '/rooms/profiles/join')).toBe(0);
    expect((await client.call('list_room_users', { roomName: 'profiles' })).users).toEqual([]);
  });
});
