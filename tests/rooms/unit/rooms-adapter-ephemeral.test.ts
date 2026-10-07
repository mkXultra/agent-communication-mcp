// `ephemeral` is an agora cloud feature (docs/api.yaml 0.11.0, D22). This file runs in the file-mode project only
// (tests/rooms/** is not part of cloud-compat), so it checks the file-mode rejection directly.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { LockService } from '../../../src/services/LockService.js';
import { RoomsAdapter } from '../../../src/adapters/RoomsAdapter.js';
import { ValidationError } from '../../../src/errors/index.js';
import { handleCreateRoom } from '../../../src/tools/room.js';

describe('create_room ephemeral in file mode', () => {
  let dataDir: string;
  let adapter: RoomsAdapter;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-comm-ephemeral-'));
    adapter = new RoomsAdapter(new LockService(dataDir));
    await adapter.initialize();
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('rejects ephemeral: true with the normal validation error and creates nothing', async () => {
    await expect(adapter.createRoom({ roomName: 'scratch', ephemeral: true })).rejects.toThrow(ValidationError);
    await expect(adapter.createRoom({ roomName: 'scratch', ephemeral: true })).rejects.toThrow(
      'ephemeral rooms are only available in cloud mode',
    );
    expect((await adapter.listRooms()).rooms).toEqual([]);
  });

  it('accepts ephemeral: false and an omitted flag as today', async () => {
    await expect(adapter.createRoom({ roomName: 'with-false', ephemeral: false })).resolves.toEqual({
      success: true,
      roomName: 'with-false',
    });
    await expect(adapter.createRoom({ roomName: 'without' })).resolves.toEqual({ success: true, roomName: 'without' });

    const rooms = (await adapter.listRooms()).rooms;
    expect(rooms.map((room) => room.name)).toEqual(['with-false', 'without']);
    // File mode does not gain the cloud-only field.
    expect(rooms.every((room) => room.ephemeral === undefined)).toBe(true);
  });

  it('rejects ephemeral: true through the MCP tool handler before creating the room', async () => {
    await expect(handleCreateRoom({ roomName: 'scratch', ephemeral: true }, adapter)).rejects.toThrow(
      /ephemeral rooms are only available in cloud mode/,
    );
    expect((await adapter.listRooms()).rooms).toEqual([]);
  });
});
