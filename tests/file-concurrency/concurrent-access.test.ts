// File mode: readers of the JSON files that do not take the file lock (real file system, no mocks).
// rooms.json, presence.json, waiting_agents.json and read_status.json are read without the lock while the locked
// writers update them. These tests fail on the storage code before src/utils/atomicFile.ts, where a write truncated
// the file first and a reader could see it empty or half written ("Unexpected end of JSON input", or a read status
// that silently counts as "nothing read yet").
//
// The writers of one file run one after another, so the file lock itself is never contended here: only the unlocked
// readers race with the writes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { MessageService } from '../../src/features/messaging/MessageService';
import { PresenceStorage } from '../../src/features/rooms/presence/PresenceStorage';
import { RoomStorage } from '../../src/features/rooms/room/RoomStorage';

/** Independent files written at the same time (rooms, or data directories for rooms.json). */
const PARALLEL = 10;
/** Writes per file, one after another. */
const WRITES = 8;
const READERS = 3;

interface MessageServiceFiles {
  addWaitingAgent(roomName: string, agentName: string, timeout: number): Promise<void>;
  getWaitingAgents(roomName: string): Promise<Array<{ agentName: string }>>;
  updateReadStatus(roomName: string, agentName: string, lastMessage: object): Promise<void>;
  getReadStatus(roomName: string, agentName: string): Promise<object | null>;
}

/** Runs `write` for 0..WRITES-1 in order while READERS loops run `read`; resolves with the errors the reads threw. */
async function writeWhileReading(write: (i: number) => Promise<unknown>, read: () => Promise<unknown>): Promise<string[]> {
  const errors: string[] = [];
  let done = false;
  const readers = Array.from({ length: READERS }, async () => {
    while (!done) {
      try {
        await read();
      } catch (error) {
        errors.push(String(error));
      }
    }
  });
  try {
    for (let i = 0; i < WRITES; i++) await write(i);
  } finally {
    done = true;
    await Promise.all(readers);
  }
  return errors;
}

describe('file storage: unlocked readers and locked writers', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-comm-concurrent-'));
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('presence.json: readers never see a partly written file, and every write is kept', async () => {
    const writer = new PresenceStorage(dataDir);
    const reader = new PresenceStorage(dataDir);

    const results = await Promise.all(
      Array.from({ length: PARALLEL }, async (_, room) => {
        const roomName = `room-${room}`;
        const errors = await writeWhileReading(
          (i) => writer.addUser(roomName, `agent-${i}`, { description: 'x'.repeat(20 * i) }),
          () => reader.getUsersInRoom(roomName),
        );
        return { errors, users: Object.keys(await reader.getAllUsersInRoom(roomName)).sort() };
      }),
    );

    const expectedUsers = Array.from({ length: WRITES }, (_, i) => `agent-${i}`).sort();
    expect(results.flatMap((result) => result.errors)).toEqual([]);
    expect(results.map((result) => result.users)).toEqual(results.map(() => expectedUsers));
  }, 60000);

  it('rooms.json: readers never see a partly written file, and every write is kept', async () => {
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, async (_, n) => {
        const dir = path.join(dataDir, `data-${n}`);
        const writer = new RoomStorage(dir);
        const reader = new RoomStorage(dir);
        const errors = await writeWhileReading(
          (i) => writer.createRoom(`room-${i}`, 'd'.repeat(20 * i)),
          () => reader.roomExists('room-0'),
        );
        return { errors, rooms: (await reader.getAllRoomNames()).sort() };
      }),
    );

    const expectedRooms = Array.from({ length: WRITES }, (_, i) => `room-${i}`).sort();
    expect(results.flatMap((result) => result.errors)).toEqual([]);
    expect(results.map((result) => result.rooms)).toEqual(results.map(() => expectedRooms));
    // No temporary files are left behind.
    const leftovers = await Promise.all(
      Array.from({ length: PARALLEL }, async (_, n) => (await fs.readdir(path.join(dataDir, `data-${n}`))).filter((name) => name.endsWith('.tmp'))),
    );
    expect(leftovers.flat()).toEqual([]);
  }, 60000);

  it('waiting_agents.json and read_status.json: readers never see a partly written file', async () => {
    // The private file helpers of MessageService: the unlocked readers and the locked writers of the two files.
    const writer = new MessageService(dataDir) as unknown as MessageServiceFiles;
    const reader = new MessageService(dataDir) as unknown as MessageServiceFiles;
    const message = (i: number) => ({ id: `message-${i}`, agentName: 'sender', message: `m${i}`, timestamp: new Date().toISOString(), mentions: [] });

    const results = await Promise.all(
      Array.from({ length: PARALLEL }, async (_, room) => {
        const roomName = `waiting-room-${room}`;
        await fs.mkdir(path.join(dataDir, 'rooms', roomName), { recursive: true });
        await writer.updateReadStatus(roomName, 'agent-0', message(0));
        const errors = await writeWhileReading(
          async (i) => {
            await writer.addWaitingAgent(roomName, `agent-${i}`, 60000);
            await writer.updateReadStatus(roomName, `agent-${i + 1}`, message(i + 1));
          },
          async () => {
            await reader.getWaitingAgents(roomName);
            // A read status that cannot be parsed counts as "nothing read yet" (every message unread again).
            if ((await reader.getReadStatus(roomName, 'agent-0')) === null) throw new Error('read status of agent-0 lost');
          },
        );
        return { errors, waiting: (await reader.getWaitingAgents(roomName)).map((entry) => entry.agentName).sort() };
      }),
    );

    const expectedWaiting = Array.from({ length: WRITES }, (_, i) => `agent-${i}`).sort();
    expect(results.flatMap((result) => result.errors)).toEqual([]);
    expect(results.map((result) => result.waiting)).toEqual(results.map(() => expectedWaiting));
  }, 60000);
});
