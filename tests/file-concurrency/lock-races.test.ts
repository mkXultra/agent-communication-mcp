// File mode: the file lock (src/services/LockService.ts) and the readers of presence.json / rooms.json that do not take
// it. The races behind issue #7: "should safely handle concurrent file writes" lost a line and "should handle concurrent
// join/leave operations" lost a user, now and then, on CI.
// Real file system. Each test holds a file system call of one caller until the test lets it go on, so the interleaving
// does not depend on the speed of the machine:
// - A caller that finds the lock file taken reads it to see whether its holder is gone. A lock file that is gone by then
//   (released) or still empty (fs.writeFile creates it before it writes the PID) counted as stale, and removing it
//   removed the lock file of the caller that had taken the lock in the meantime: two callers inside the lock.
// - A caller that timed out removed the lock file of the holder.
// - The callers of one process relied on the lock file to keep each other out.
// - Reading presence.json / rooms.json while the file did not exist wrote the empty initial data, outside the lock, over
//   what a locked writer had written in the meantime.

import { AsyncLocalStorage } from 'async_hooks';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LockService, LockTimeoutError } from '../../src/services/LockService';
import { RoomsAdapter } from '../../src/adapters/RoomsAdapter';

type FsCall = (...args: any[]) => Promise<any>;

const hooks = vi.hoisted(() => {
  const state: { intercept?: (call: string, args: any[], original: FsCall) => Promise<any> } = {};
  /** The fs promise API with the calls below going through `state.intercept` (when set). */
  const wrap = <T extends object>(api: T): T => {
    const wrapped = { ...api } as Record<string, unknown>;
    for (const call of ['readFile', 'writeFile', 'unlink', 'stat']) {
      const original = (api as Record<string, FsCall>)[call];
      wrapped[call] = (...args: any[]) => (state.intercept ? state.intercept(call, args, original) : original(...args));
    }
    return wrapped as T;
  };
  return { state, wrap };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const promises = hooks.wrap(actual.promises);
  return { ...actual, promises, default: { ...actual, promises } };
});

vi.mock('fs/promises', async (importOriginal) => {
  const wrapped = hooks.wrap(await importOriginal<typeof import('fs/promises')>());
  return { ...wrapped, default: wrapped };
});

/** Which caller a file system call belongs to. */
const caller = new AsyncLocalStorage<string>();
const as = <T>(name: string, run: () => Promise<T>): Promise<T> => caller.run(name, run);

function latch() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Takes the lock file the way another process does; resolves whether it got it. */
const takeLockFile = (lockPath: string) => fs.writeFile(lockPath, String(process.pid), { flag: 'wx' }).then(() => true, () => false);

describe('file lock and unlocked readers: forced interleavings', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-comm-lock-races-'));
  });

  afterEach(async () => {
    hooks.state.intercept = undefined;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  describe('stale lock files', () => {
    it('a lock file released before its holder is checked is not stale: the lock file taken next is kept', async () => {
      const lockPath = path.join(dataDir, 'file.txt.lock');
      const service = new LockService(dataDir, 10000);
      const atCheck = latch();
      const check = latch();
      const atRemoval = latch();
      const removal = latch();
      const entered = latch();
      const leave = latch();
      let checked = false;
      let inside = false;
      hooks.state.intercept = async (call, args, original) => {
        if (caller.getStore() === 'service' && args[0] === lockPath) {
          if (call === 'readFile' && !checked) {
            checked = true;
            atCheck.open();
            await check.promise;
          } else if (call === 'unlink' && !inside) {
            atRemoval.open();
            await removal.promise;
          }
        }
        return original(...args);
      };

      // Another process holds the lock; the service finds the lock file taken and is about to read it.
      expect(await takeLockFile(lockPath)).toBe(true);
      const locked = as('service', () =>
        service.withLock('file.txt', async () => {
          inside = true;
          entered.open();
          await leave.promise;
        }),
      );
      await atCheck.promise;
      // The holder releases the lock before the service reads the lock file.
      await fs.unlink(lockPath);
      check.open();
      // Before the fix the service removes the lock file (gone, so "stale") and is held before it does; after the fix
      // it takes the free lock.
      const removing = await Promise.race([atRemoval.promise.then(() => true), entered.promise.then(() => false)]);
      // A third process takes the lock if it is free.
      const thirdTookTheLock = await takeLockFile(lockPath);
      removal.open();
      await entered.promise;
      leave.open();
      await locked;

      // Before the fix the service removed the third process's lock file and entered while that process held the lock.
      expect({ removing, thirdTookTheLock }).toEqual({ removing: false, thirdTookTheLock: false });
    });

    it('a lock file whose creator has not written its PID yet is not stale', async () => {
      const lockPath = path.join(dataDir, 'file.txt.lock');
      const service = new LockService(dataDir, 10000);
      const secondCheck = latch();
      const entered = latch();
      let checks = 0;
      hooks.state.intercept = async (call, args, original) => {
        const result = await original(...args);
        if (caller.getStore() === 'service' && call === 'readFile' && args[0] === lockPath && ++checks === 2) secondCheck.open();
        return result;
      };

      // Another process is taking the lock: fs.writeFile has created the lock file (O_EXCL) but not written the PID.
      const creating = await fs.open(lockPath, 'wx');
      const locked = as('service', () => service.withLock('file.txt', async () => entered.open()));
      // Before the fix the empty lock file counts as stale, is removed, and the service enters; after the fix the
      // service checks the lock file again later.
      const enteredWhileTheLockWasTaken = await Promise.race([entered.promise.then(() => true), secondCheck.promise.then(() => false)]);
      // A live PID, told apart from the service's own lock file content by the newline.
      const creatorsContent = `${process.pid}\n`;
      await creating.writeFile(creatorsContent);
      await creating.close();
      const creatorsLockFileKept = (await fs.readFile(lockPath, 'utf8').catch(() => '')) === creatorsContent;
      await fs.unlink(lockPath).catch(() => undefined);
      await locked;

      expect({ enteredWhileTheLockWasTaken, creatorsLockFileKept }).toEqual({ enteredWhileTheLockWasTaken: false, creatorsLockFileKept: true });
    });

    it('an empty lock file left behind long ago is still removed', async () => {
      const lockPath = path.join(dataDir, 'file.txt.lock');
      await fs.writeFile(lockPath, '');
      const longAgo = new Date(Date.now() - 60000);
      await fs.utimes(lockPath, longAgo, longAgo);

      await expect(new LockService(dataDir, 10000).withLock('file.txt', async () => 'entered')).resolves.toBe('entered');
    });

    it('a lock file whose process is gone is still removed', async () => {
      const lockPath = path.join(dataDir, 'file.txt.lock');
      // PID above the maximum on Linux (4194304) and macOS (99998): no such process.
      await fs.writeFile(lockPath, '2147483646');

      await expect(new LockService(dataDir, 10000).withLock('file.txt', async () => 'entered')).resolves.toBe('entered');
    });
  });

  describe('lock timeout', () => {
    it('a caller that times out leaves the lock file of the holder alone', async () => {
      const lockPath = path.join(dataDir, 'file.txt.lock');
      // Another process holds the lock.
      expect(await takeLockFile(lockPath)).toBe(true);

      await expect(new LockService(dataDir, 100).withLock('file.txt', async () => 'entered')).rejects.toBeInstanceOf(LockTimeoutError);

      // Before the fix the timed-out caller removed it, and the next caller entered while the holder held the lock.
      expect(await takeLockFile(lockPath)).toBe(false);
    });
  });

  describe('callers of one process', () => {
    /** The lock file lets every caller in (as the stale checks above did): only the callers themselves take turns. */
    function lockFileKeepsNobodyOut(): void {
      hooks.state.intercept = async (call, args, original) =>
        call === 'writeFile' && String(args[0]).endsWith('.lock') ? undefined : original(...args);
    }

    it('take turns across LockService instances even when the lock file does not keep them apart', async () => {
      lockFileKeepsNobodyOut();
      // The body of ConcurrencyTests "should safely handle concurrent file writes".
      const services = [new LockService(dataDir, 10000), new LockService(dataDir, 10000), new LockService(dataDir, 10000)];
      const filePath = 'concurrent-writes.txt';
      let inside = 0;
      let maxInside = 0;

      await Promise.all(
        Array.from({ length: 10 }, (_, n) => {
          const service = services[n % 3];
          return service.withLock(filePath, async () => {
            maxInside = Math.max(maxInside, ++inside);
            const current = await service.readFile(filePath);
            await sleep(10);
            await service.writeFile(filePath, `${current}Line ${n + 1}\n`);
            inside--;
          });
        }),
      );

      const lines = (await fs.readFile(path.join(dataDir, filePath), 'utf8')).trim().split('\n');
      expect(maxInside).toBe(1);
      expect(lines.sort()).toEqual(Array.from({ length: 10 }, (_, n) => `Line ${n + 1}`).sort());
    });

    it('a caller that times out waiting for its turn does not let the callers behind it in early', async () => {
      lockFileKeepsNobodyOut();
      const holderLeaves = latch();
      const events: string[] = [];
      const holding = new LockService(dataDir, 10000).withLock('file.txt', async () => {
        events.push('holder in');
        await holderLeaves.promise;
        events.push('holder out');
      });

      await expect(new LockService(dataDir, 100).withLock('file.txt', async () => events.push('timed-out caller in'))).rejects.toBeInstanceOf(LockTimeoutError);
      const next = new LockService(dataDir, 10000).withLock('file.txt', async () => {
        events.push('next caller in');
      });
      // Time for the next caller to go in if it could.
      await sleep(200);
      holderLeaves.open();
      await Promise.all([holding, next]);

      expect(events).toEqual(['holder in', 'holder out', 'next caller in']);
    });
  });

  describe('readers of a JSON file that does not exist yet', () => {
    /** Holds the first read of `filePath` by `name` that finds no file, until `go` opens. */
    function holdMissingRead(name: string, filePath: string, missing: () => void, go: Promise<void>): void {
      let held = false;
      hooks.state.intercept = async (call, args, original) => {
        if (call !== 'readFile' || caller.getStore() !== name || args[0] !== filePath || held) return original(...args);
        try {
          return await original(...args);
        } catch (error) {
          held = true;
          missing();
          await go;
          throw error;
        }
      };
    }

    it('presence.json: an enterRoom that found no file does not overwrite the users that entered meanwhile', async () => {
      // "should handle concurrent join/leave operations"
      const rooms = new RoomsAdapter(new LockService(dataDir, 10000));
      await rooms.initialize();
      const roomName = 'join-leave-test';
      await rooms.createRoom({ roomName });
      const missing = latch();
      const go = latch();
      holdMissingRead('agent-0', path.join(dataDir, 'rooms', roomName, 'presence.json'), missing.open, go.promise);

      // agent-0 checks whether it is in the room already: no presence.json yet.
      const first = as('agent-0', () => rooms.enterRoom({ agentName: 'agent-0', roomName }));
      await missing.promise;
      await rooms.enterRoom({ agentName: 'agent-1', roomName });
      go.open();
      await first;

      const users = (await rooms.listRoomUsers({ roomName })).users.map((user) => user.name);
      expect(users).toEqual(['agent-0', 'agent-1']);
    });

    it('rooms.json: a createRoom that found no file does not overwrite the rooms created meanwhile', async () => {
      // "should handle concurrent room creation attempts"
      const rooms = new RoomsAdapter(new LockService(dataDir, 10000));
      await rooms.initialize();
      const missing = latch();
      const go = latch();
      holdMissingRead('creator-0', path.join(dataDir, 'rooms.json'), missing.open, go.promise);

      // The first createRoom checks whether the room exists: no rooms.json yet.
      const first = as('creator-0', () => rooms.createRoom({ roomName: 'room-0' }));
      await missing.promise;
      await rooms.createRoom({ roomName: 'room-1' });
      go.open();
      await first;

      expect((await rooms.listRooms()).rooms.map((room) => room.name)).toEqual(['room-0', 'room-1']);
    });
  });
});
