// Agent Communication MCP Server - atomic JSON file updates for the file storage
// Readers of rooms.json / presence.json / read_status.json / waiting_agents.json do not take the lock, so a
// plain truncate-and-write can hand them an empty or half-written file ("Unexpected end of JSON input").
// Writing to a temporary file and renaming it over the target means a reader sees the old content or the new
// content, never something in between.
//
// The update keeps what a plain fs.writeFile kept: a symbolic link is followed and its target is updated (resolved
// the way the operating system resolves it), an existing file keeps its permission bits (and its owner, where the
// process may set it), and a new file gets the permissions fs.writeFile would give it. Where a rename cannot keep
// that (a file the process may not write, a file with several hard links, a directory the process may not create
// files in, an owner the process cannot restore), the file is written in place exactly as before, with the same
// result and error. A temporary file never outlives a failed update.

import { constants } from 'fs';
import path from 'path';

interface FileStats {
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/** The fs/promises functions used here; callers pass their own module so test mocks (memfs) keep applying. */
export interface AtomicFileSystem {
  writeFile(path: string, data: string, options?: unknown): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  stat(path: string): Promise<FileStats>;
  lstat(path: string): Promise<FileStats>;
  readlink(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  access(path: string, mode?: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  chown(path: string, uid: number, gid: number): Promise<void>;
}

const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** The directory does not let this process create the temporary file: keep writing in place, as before. */
const IN_PLACE_FALLBACK_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);
/** Same limit as the kernel's for following symbolic links (ELOOP). */
const MAX_SYMLINK_HOPS = 40;
const PERMISSION_BITS = 0o7777;
const IS_WINDOWS = process.platform === 'win32';
let sequence = 0;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function temporaryPath(filePath: string): string {
  sequence = (sequence + 1) % Number.MAX_SAFE_INTEGER;
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now().toString(36)}.${sequence.toString(36)}.tmp`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The file fs.writeFile would write: symbolic links in the last path component are followed (even dangling ones).
 * A relative link is resolved from the real directory that holds it: the operating system resolves links in the
 * directory part before it applies a `..` of the link, which `path.resolve` alone would drop against the link's name.
 */
async function resolveWriteTarget(fs: AtomicFileSystem, filePath: string): Promise<string | undefined> {
  let current = filePath;
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
    let directory: string;
    try {
      directory = await fs.realpath(path.dirname(current));
    } catch (error) {
      // The directory does not exist (or cannot be resolved): the write fails there the way fs.writeFile does.
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return current;
      throw error;
    }
    current = path.join(directory, path.basename(current));
    let stats: FileStats;
    try {
      stats = await fs.lstat(current);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return current;
      throw error;
    }
    if (!stats.isSymbolicLink()) return current;
    current = path.resolve(directory, await fs.readlink(current));
  }
  // A link loop: let the in-place write report it the way fs.writeFile does.
  return undefined;
}

/** Whether this process may write the existing file (fs.writeFile opens it for writing; a rename would not ask). */
async function mayWrite(fs: AtomicFileSystem, filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function statIfExists(fs: AtomicFileSystem, filePath: string): Promise<FileStats | undefined> {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

async function removeQuietly(fs: AtomicFileSystem, filePath: string): Promise<void> {
  await fs.unlink(filePath).catch(() => undefined);
}

/**
 * Gives the temporary file the permission bits and owner of the file it replaces. Returns false when the owner
 * cannot be restored (the caller then writes in place, which keeps it).
 */
async function copyAttributes(fs: AtomicFileSystem, tmp: string, existing: FileStats): Promise<boolean> {
  await fs.chmod(tmp, existing.mode & PERMISSION_BITS);
  if (IS_WINDOWS) return true;
  const created = await fs.stat(tmp);
  if (created.uid === existing.uid && created.gid === existing.gid) return true;
  try {
    await fs.chown(tmp, existing.uid, existing.gid);
    return true;
  } catch {
    return false;
  }
}

async function renameWithRetry(fs: AtomicFileSystem, tmp: string, target: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(tmp, target);
      return;
    } catch (error) {
      // Windows can refuse to replace a file that is being read for a moment.
      const code = errorCode(error);
      if (attempt < 5 && code && RENAME_RETRY_CODES.has(code)) {
        await sleep(10 * attempt);
        continue;
      }
      throw error;
    }
  }
}

/**
 * Replaces the content of `filePath` with `data` so that readers never see a partial file. Where the file is written
 * in place instead, it is written through `filePath` itself, so results and error messages are those of fs.writeFile.
 */
export async function writeFileAtomic(fs: AtomicFileSystem, filePath: string, data: string): Promise<void> {
  const target = await resolveWriteTarget(fs, filePath);
  const existing = target === undefined ? undefined : await statIfExists(fs, target);
  // A rename would replace a file the process may not write (fs.writeFile fails with EACCES / EPERM there), detach the
  // other hard links, or replace something that is not a regular file.
  if (target === undefined || (existing && (existing.nlink > 1 || !existing.isFile() || !(await mayWrite(fs, target))))) {
    await fs.writeFile(filePath, data, 'utf-8');
    return;
  }

  const tmp = temporaryPath(target);
  try {
    // Created exclusively with the mode fs.writeFile would use (0o666 before umask) or the existing file's bits.
    await fs.writeFile(tmp, data, { encoding: 'utf-8', flag: 'wx', mode: existing ? existing.mode & PERMISSION_BITS : 0o666 });
  } catch (error) {
    await removeQuietly(fs, tmp);
    const code = errorCode(error);
    if (code && IN_PLACE_FALLBACK_CODES.has(code)) {
      await fs.writeFile(filePath, data, 'utf-8');
      return;
    }
    throw error;
  }

  try {
    if (existing && !(await copyAttributes(fs, tmp, existing))) {
      await removeQuietly(fs, tmp);
      await fs.writeFile(filePath, data, 'utf-8');
      return;
    }
    await renameWithRetry(fs, tmp, target);
  } catch (error) {
    await removeQuietly(fs, tmp);
    throw error;
  }
}
