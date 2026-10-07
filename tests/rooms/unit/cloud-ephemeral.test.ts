// `ephemeral` on create_room (agora docs/api.yaml 0.11.0, D22).
//
// These checks stub the HTTP client to pin the exact wire body the client builds and the missing-server-field
// fallback in isolation. The live D22 wire contract (the real echo and the get_status boundary) is covered by
// tests/cloud/tool-contract.test.ts against the authorized agora 0.11.0 fixture; the two complement each other.

import { describe, expect, it, vi } from 'vitest';
import { CloudApiClient, type CloudRequestOptions } from '../../../src/cloud/CloudApiClient.js';
import { CloudRoomsService } from '../../../src/cloud/CloudRoomsService.js';
import type { CloudWaitService } from '../../../src/cloud/CloudWaitService.js';
import type { ApiRoom } from '../../../src/cloud/types.js';

const CONFIG = { apiUrl: 'http://127.0.0.1:1', token: 'agora_test_token' };

/** A CloudApiClient whose `request` records the options the client hands it and answers with a room. */
function captureCreateRoom(): { api: CloudApiClient; calls: CloudRequestOptions[] } {
  const api = new CloudApiClient(CONFIG);
  const calls: CloudRequestOptions[] = [];
  vi.spyOn(api, 'request').mockImplementation((async (_method: string, _path: string, options?: CloudRequestOptions) => {
    calls.push(options ?? {});
    return { success: true, roomName: 'scratch', createdAt: '2026-01-01T00:00:00.000Z', epoch: 'epoch-1' };
  }) as unknown as CloudApiClient['request']);
  return { api, calls };
}

/** A CloudRoomsService over a stubbed API; create_room / list_rooms never touch the wait service. */
function serviceWith(api: Partial<CloudApiClient>): CloudRoomsService {
  return new CloudRoomsService(api as unknown as CloudApiClient, {} as unknown as CloudWaitService);
}

describe('CloudApiClient.createRoom sends ephemeral only when true', () => {
  it('puts ephemeral: true in the POST /rooms body', async () => {
    const { api, calls } = captureCreateRoom();
    await api.createRoom('scratch', undefined, { ephemeral: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ roomName: 'scratch', ephemeral: true });
    // A resend after an ambiguous failure is still made idempotent by operationId.
    expect(calls[0]!.body).toHaveProperty('operationId', expect.any(String));
  });

  it('omits ephemeral for false and undefined, keeping description when present', async () => {
    const { api, calls } = captureCreateRoom();
    await api.createRoom('scratch');
    await api.createRoom('scratch', 'a description', { ephemeral: false });

    expect(calls[0]!.body).not.toHaveProperty('ephemeral');
    expect(calls[1]!.body).toMatchObject({ roomName: 'scratch', description: 'a description' });
    expect(calls[1]!.body).not.toHaveProperty('ephemeral');
  });
});

describe('CloudRoomsService.createRoom exposes ephemeral', () => {
  it('forwards the flag and returns the server value', async () => {
    const createRoom = vi.fn(async () => ({
      success: true,
      roomName: 'scratch',
      createdAt: '2026-01-01T00:00:00.000Z',
      epoch: 'epoch-1',
      ephemeral: true,
    }));
    const service = serviceWith({ createRoom });

    await expect(service.createRoom({ roomName: 'scratch', ephemeral: true })).resolves.toEqual({
      success: true,
      roomName: 'scratch',
      ephemeral: true,
    });
    expect(createRoom).toHaveBeenCalledWith('scratch', undefined, { ephemeral: true });
  });

  it('answers false when the server omits it (older than 0.11.0)', async () => {
    const createRoom = vi.fn(async () => ({
      success: true,
      roomName: 'plain',
      createdAt: '2026-01-01T00:00:00.000Z',
      epoch: 'epoch-1',
    }));
    const service = serviceWith({ createRoom });

    await expect(service.createRoom({ roomName: 'plain' })).resolves.toEqual({
      success: true,
      roomName: 'plain',
      ephemeral: false,
    });
  });
});

describe('CloudRoomsService.listRooms maps ephemeral', () => {
  it('uses the server value, and false when the server omits it', async () => {
    const rooms: ApiRoom[] = [
      { name: 'ephemeral-room', createdAt: '2026-01-01T00:00:00.000Z', epoch: 'epoch-1', ephemeral: true },
      { name: 'permanent-room', createdAt: '2026-01-01T00:00:00.000Z', epoch: 'epoch-1' },
      { name: 'plain-room', createdAt: '2026-01-01T00:00:00.000Z', epoch: 'epoch-1', ephemeral: false },
    ];
    const service = serviceWith({ listRooms: vi.fn(async () => rooms) });

    const result = await service.listRooms();
    expect(result.total).toBe(3);
    expect(result.rooms).toEqual([
      { name: 'ephemeral-room', createdAt: '2026-01-01T00:00:00.000Z', messageCount: 0, userCount: 0, ephemeral: true },
      { name: 'permanent-room', createdAt: '2026-01-01T00:00:00.000Z', messageCount: 0, userCount: 0, ephemeral: false },
      { name: 'plain-room', createdAt: '2026-01-01T00:00:00.000Z', messageCount: 0, userCount: 0, ephemeral: false },
    ]);
  });
});
