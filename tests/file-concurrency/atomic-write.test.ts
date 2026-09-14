// File mode: the atomic JSON writes (src/utils/atomicFile.ts) keep what the plain fs.writeFile they replace kept.
// Real file system in a temporary directory; failures are injected by wrapping the real fs functions.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { writeFileAtomic, type AtomicFileSystem } from '../../src/utils/atomicFile';
import { RoomStorage } from '../../src/features/rooms/room/RoomStorage';

const realFs: AtomicFileSystem = {
  writeFile: (file, data, options) => fs.writeFile(file, data, options as Parameters<typeof fs.writeFile>[2]),
  rename: fs.rename,
  unlink: fs.unlink,
  stat: fs.stat,
  lstat: fs.lstat,
  readlink: (file) => fs.readlink(file),
  realpath: (file) => fs.realpath(file),
  access: (file, mode) => fs.access(file, mode),
  chmod: fs.chmod,
  chown: fs.chown,
};

function errnoError(code: string, syscall: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected failure, ${syscall}`), { code, syscall });
}

const isTemporary = (file: string): boolean => path.basename(file).endsWith('.tmp');

/** The error code of a write, or 'ok'. */
function outcome(write: Promise<unknown>): Promise<string> {
  return write.then(
    () => 'ok',
    (error: NodeJS.ErrnoException) => error.code ?? String(error),
  );
}

/**
 * <root>/physical/data/rooms.json -> ../rooms.json (a relative link), and <root>/data-link -> <root>/physical/data.
 * Through <root>/data-link/rooms.json the operating system reaches <root>/physical/rooms.json: the link's `..` is
 * applied in physical/data, not next to data-link.
 */
async function linkedDataDirectory(root: string, withTarget: boolean): Promise<string> {
  await fs.mkdir(path.join(root, 'physical', 'data'), { recursive: true });
  if (withTarget) await fs.writeFile(path.join(root, 'physical', 'rooms.json'), JSON.stringify({ rooms: {} }));
  await fs.symlink('../rooms.json', path.join(root, 'physical', 'data', 'rooms.json'));
  await fs.symlink(path.join(root, 'physical', 'data'), path.join(root, 'data-link'));
  return path.join(root, 'data-link');
}

/** Every file below `root` with its content; links are listed as links (not followed), their targets relative to `root`. */
async function snapshot(root: string, dir = root): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const name = path.relative(root, full);
    if (entry.isSymbolicLink()) files[name] = `-> ${(await fs.readlink(full)).replace(root, '<root>')}`;
    else if (entry.isDirectory()) Object.assign(files, await snapshot(root, full));
    else files[name] = await fs.readFile(full, 'utf8');
  }
  return files;
}

describe('writeFileAtomic keeps what fs.writeFile kept', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-comm-atomic-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function temporaryFiles(directory = dir): Promise<string[]> {
    return (await fs.readdir(directory)).filter(isTemporary);
  }

  it('keeps the permission bits of an existing file', async () => {
    const storage = new RoomStorage(dir);
    const roomsFile = path.join(dir, 'rooms.json');
    await storage.createRoom('first');

    await fs.chmod(roomsFile, 0o600);
    await storage.createRoom('second');
    expect((await fs.stat(roomsFile)).mode & 0o777).toBe(0o600);

    // Bits that the umask would take away from a newly created file are kept too.
    await fs.chmod(roomsFile, 0o666);
    await storage.createRoom('third');
    expect((await fs.stat(roomsFile)).mode & 0o777).toBe(0o666);

    expect((await storage.getAllRoomNames()).sort()).toEqual(['first', 'second', 'third']);
    expect(await temporaryFiles()).toEqual([]);
  });

  it('gives a new file the permissions fs.writeFile gives it', async () => {
    await fs.writeFile(path.join(dir, 'plain.json'), '{}');
    await writeFileAtomic(realFs, path.join(dir, 'atomic.json'), '{}');
    const plain = await fs.stat(path.join(dir, 'plain.json'));
    const atomic = await fs.stat(path.join(dir, 'atomic.json'));
    expect(atomic.mode & 0o7777).toBe(plain.mode & 0o7777);
  });

  it('writes through a symbolic link: the link stays and its target gets the update', async () => {
    const shared = path.join(dir, 'shared');
    const dataDir = path.join(dir, 'data');
    await fs.mkdir(shared);
    await fs.mkdir(dataDir);
    await fs.writeFile(path.join(shared, 'rooms.json'), JSON.stringify({ rooms: {} }));
    await fs.symlink(path.join(shared, 'rooms.json'), path.join(dataDir, 'rooms.json'));

    await new RoomStorage(dataDir).createRoom('linked');

    expect((await fs.lstat(path.join(dataDir, 'rooms.json'))).isSymbolicLink()).toBe(true);
    const viaLink = JSON.parse(await fs.readFile(path.join(dataDir, 'rooms.json'), 'utf8'));
    const viaTarget = JSON.parse(await fs.readFile(path.join(shared, 'rooms.json'), 'utf8'));
    expect(Object.keys(viaLink.rooms)).toEqual(['linked']);
    expect(viaTarget).toEqual(viaLink);
    expect(await temporaryFiles(dataDir)).toEqual([]);
    expect(await temporaryFiles(shared)).toEqual([]);
  });

  it('follows a chain of relative links, also to a file that does not exist yet', async () => {
    await fs.symlink('b', path.join(dir, 'a'));
    await fs.symlink('c', path.join(dir, 'b'));

    await writeFileAtomic(realFs, path.join(dir, 'a'), 'one');
    expect(await fs.readFile(path.join(dir, 'c'), 'utf8')).toBe('one');
    await writeFileAtomic(realFs, path.join(dir, 'a'), 'two');

    expect((await fs.lstat(path.join(dir, 'a'))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(dir, 'b'))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(dir, 'a'), 'utf8')).toBe('two');
    expect(await temporaryFiles()).toEqual([]);
  });

  it('fails like fs.writeFile, and leaves the file as it was, when the existing file may not be written', async () => {
    // A read-only file: fs.writeFile opens it for writing and fails (EACCES), a rename would have replaced it.
    // The comparison with fs.writeFile keeps the test right for any user (root may write it; both then succeed).
    const control = path.join(dir, 'control.json');
    const file = path.join(dir, 'rooms.json');
    for (const target of [control, file]) {
      await fs.writeFile(target, JSON.stringify({ rooms: { first: {} } }));
      await fs.chmod(target, 0o444);
    }

    const plain = await outcome(fs.writeFile(control, '{"v":2}'));
    const atomic = await outcome(writeFileAtomic(realFs, file, '{"v":2}'));
    expect(atomic).toBe(plain);
    expect(await fs.readFile(file, 'utf8')).toBe(await fs.readFile(control, 'utf8'));
    expect((await fs.stat(file)).mode & 0o777).toBe(0o444);
    expect(await temporaryFiles()).toEqual([]);

    // Through the storage: creating a room fails exactly when the plain write fails, and the rooms stay as they were.
    const storage = new RoomStorage(dir);
    const created = await outcome(storage.createRoom('second'));
    expect(created === 'ok').toBe(plain === 'ok');
    if (plain !== 'ok') expect(await storage.getAllRoomNames()).toEqual(['first']);
    await fs.chmod(file, 0o644);
    await fs.chmod(control, 0o644);
  });

  it('follows a relative link from the real directory when a parent directory is itself a link', async () => {
    const atomicRoot = path.join(dir, 'atomic');
    const plainRoot = path.join(dir, 'plain');
    const atomicData = await linkedDataDirectory(atomicRoot, true);
    const plainData = await linkedDataDirectory(plainRoot, true);

    await new RoomStorage(atomicData).createRoom('linked');
    const storage = new RoomStorage(atomicData);
    expect(await storage.getAllRoomNames()).toEqual(['linked']);

    // The same content reached the same files as a plain fs.writeFile through the same logical path.
    const written = await fs.readFile(path.join(atomicRoot, 'physical', 'rooms.json'), 'utf8');
    await fs.writeFile(path.join(plainData, 'rooms.json'), written);
    expect(await snapshot(atomicRoot)).toEqual(await snapshot(plainRoot));
    // No other rooms.json appeared next to the directory link, and the link itself is still a link.
    await expect(fs.access(path.join(atomicRoot, 'rooms.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.lstat(path.join(atomicRoot, 'physical', 'data', 'rooms.json'))).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(atomicData, 'rooms.json'), 'utf8'))).toEqual(JSON.parse(written));
  });

  it('creates the target of such a link where fs.writeFile creates it, when it does not exist yet', async () => {
    const atomicRoot = path.join(dir, 'atomic');
    const plainRoot = path.join(dir, 'plain');
    const atomicData = await linkedDataDirectory(atomicRoot, false);
    const plainData = await linkedDataDirectory(plainRoot, false);

    await writeFileAtomic(realFs, path.join(atomicData, 'rooms.json'), 'first write');
    await fs.writeFile(path.join(plainData, 'rooms.json'), 'first write');

    expect(await snapshot(atomicRoot)).toEqual(await snapshot(plainRoot));
    expect(await fs.readFile(path.join(atomicRoot, 'physical', 'rooms.json'), 'utf8')).toBe('first write');
  });

  it('updates a file with several hard links in place, so every link sees the update', async () => {
    const file = path.join(dir, 'presence.json');
    const otherLink = path.join(dir, 'presence-backup.json');
    await fs.writeFile(file, 'one');
    await fs.link(file, otherLink);
    const inode = (await fs.stat(file)).ino;

    await writeFileAtomic(realFs, file, 'two');

    expect(await fs.readFile(otherLink, 'utf8')).toBe('two');
    expect((await fs.stat(file)).ino).toBe(inode);
  });

  it('removes the temporary file and reports the original error when writing it fails part way', async () => {
    const file = path.join(dir, 'failure.json');
    await fs.writeFile(file, 'old content');
    const failing: AtomicFileSystem = {
      ...realFs,
      async writeFile(target, data, options) {
        if (!isTemporary(target)) return realFs.writeFile(target, data, options);
        // Two bytes reach the disk, then the disk is full.
        await fs.writeFile(target, String(data).slice(0, 2));
        throw errnoError('ENOSPC', 'write');
      },
    };

    await expect(writeFileAtomic(failing, file, 'new content')).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(await temporaryFiles()).toEqual([]);
    expect(await fs.readFile(file, 'utf8')).toBe('old content');
  });

  it('removes the temporary file and reports the original error when the rename fails', async () => {
    const file = path.join(dir, 'failure.json');
    await fs.writeFile(file, 'old content');
    const failing: AtomicFileSystem = {
      ...realFs,
      async rename() {
        throw errnoError('EIO', 'rename');
      },
    };

    await expect(writeFileAtomic(failing, file, 'new content')).rejects.toMatchObject({ code: 'EIO' });
    expect(await temporaryFiles()).toEqual([]);
    expect(await fs.readFile(file, 'utf8')).toBe('old content');
  });

  it('writes in place, as before, when the directory does not let it create the temporary file', async () => {
    const file = path.join(dir, 'rooms.json');
    await fs.writeFile(file, 'old content');
    const inode = (await fs.stat(file)).ino;
    const noCreate: AtomicFileSystem = {
      ...realFs,
      async writeFile(target, data, options) {
        if (isTemporary(target)) throw errnoError('EACCES', 'open');
        return realFs.writeFile(target, data, options);
      },
    };

    await writeFileAtomic(noCreate, file, 'new content');
    expect(await fs.readFile(file, 'utf8')).toBe('new content');
    expect((await fs.stat(file)).ino).toBe(inode);
    expect(await temporaryFiles()).toEqual([]);
  });

  it('writes in place, as before, when the owner of the file cannot be given to the replacement', async () => {
    const file = path.join(dir, 'rooms.json');
    await fs.writeFile(file, 'old content');
    const inode = (await fs.stat(file)).ino;
    const otherOwner: AtomicFileSystem = {
      ...realFs,
      async stat(target) {
        const stats = await realFs.stat(target);
        // The existing file belongs to another user; this process may not hand the replacement to it.
        return isTemporary(target) ? stats : Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { uid: stats.uid + 1 });
      },
      async chown() {
        throw errnoError('EPERM', 'chown');
      },
    };

    await writeFileAtomic(otherOwner, file, 'new content');
    expect(await fs.readFile(file, 'utf8')).toBe('new content');
    expect((await fs.stat(file)).ino).toBe(inode);
    expect(await temporaryFiles()).toEqual([]);
  });
});
