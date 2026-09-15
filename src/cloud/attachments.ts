// Agent Communication MCP Server - local files of message attachments in cloud mode
// docs/cloud-architecture.md §3.9 / D13: send_message uploads local files and sends their IDs with the message, and
// download_attachment saves an attachment to a local path. This is the file system side of both: the checks made
// before anything is uploaded, reading a file for its upload, and writing a download without replacing a file.

import { randomUUID } from 'crypto';
import { constants, createWriteStream, promises as fs, type Stats } from 'fs';
import type { FileHandle } from 'fs/promises';
import path from 'path';
import { pipeline } from 'stream/promises';
import {
  AppError,
  AttachmentTooLargeError,
  FileAlreadyExistsError,
  FileNotFoundError,
  ValidationError,
} from '../errors/index.js';

/** docs/cloud-architecture.md §9 `MAX_ATTACHMENT_BYTES`: 10 MB per file. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** docs/api.yaml `sendMessage.attachments.maxItems`. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
/** The Content-Type of a file whose extension is not in {@link CONTENT_TYPES}. */
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

const READ_CHUNK_BYTES = 256 * 1024;

/** MIME types by lower-case file extension (a Map: an extension such as `constructor` must not find anything). */
const CONTENT_TYPES = new Map<string, string>(
  Object.entries({
    txt: 'text/plain',
    log: 'text/plain',
    md: 'text/markdown',
    markdown: 'text/markdown',
    csv: 'text/csv',
    tsv: 'text/tab-separated-values',
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    mjs: 'text/javascript',
    cjs: 'text/javascript',
    json: 'application/json',
    jsonl: 'application/x-ndjson',
    ndjson: 'application/x-ndjson',
    xml: 'application/xml',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    toml: 'application/toml',
    pdf: 'application/pdf',
    zip: 'application/zip',
    gz: 'application/gzip',
    tgz: 'application/gzip',
    tar: 'application/x-tar',
    wasm: 'application/wasm',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    ico: 'image/vnd.microsoft.icon',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    avif: 'image/avif',
    heic: 'image/heic',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
  }),
);

/** The Content-Type an upload declares for a file name: by extension, `application/octet-stream` when unknown. */
export function contentTypeFor(fileName: string): string {
  return CONTENT_TYPES.get(path.extname(fileName).slice(1).toLowerCase()) ?? DEFAULT_CONTENT_TYPE;
}

/** A local file that passed the checks for attaching it to a message. */
export interface LocalAttachment {
  /** The path as the tool was given it (named in errors). */
  path: string;
  absolutePath: string;
  /** The base name of the path, which becomes the attachment's name. */
  name: string;
  contentType: string;
}

/** A checked file opened for its upload. */
export interface AttachmentReader {
  /** The number of bytes the upload sends: the size of the file when it was opened. */
  size: number;
  /** Exactly `size` bytes from the start of the file. */
  chunks: AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}

/** Where download_attachment writes: into an existing directory under the attachment's name, or to a new file. */
export type SaveTarget = { directory: string } | { file: string };

/**
 * The checks send_message makes before it uploads anything, without calling the API: at most 10 paths, each a
 * readable regular file of 1 byte to 10 MB. Relative paths are resolved against the MCP server's working directory.
 */
export async function inspectAttachments(paths: unknown): Promise<LocalAttachment[]> {
  if (!Array.isArray(paths) || !paths.every((item): item is string => typeof item === 'string')) {
    throw new ValidationError('attachments', 'Attachments must be an array of file paths');
  }
  if (paths.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new ValidationError(
      'attachments',
      `At most ${MAX_ATTACHMENTS_PER_MESSAGE} files can be attached to a message (got ${paths.length})`,
    );
  }

  const files: LocalAttachment[] = [];
  for (const [index, given] of paths.entries()) {
    const field = `attachments[${index}]`;
    if (given === '') throw new ValidationError(field, 'File path must not be empty');
    const absolutePath = path.resolve(given);
    let stats: Stats;
    try {
      stats = await fs.stat(absolutePath);
    } catch (error) {
      throw readFailure(given, field, error);
    }
    assertAttachable(given, field, stats);
    try {
      await fs.access(absolutePath, constants.R_OK);
    } catch (error) {
      throw readFailure(given, field, error);
    }
    const name = path.basename(absolutePath);
    files.push({ path: given, absolutePath, name, contentType: contentTypeFor(name) });
  }
  return files;
}

/** Opens a checked file for its upload, checking it again: it may have changed since it was inspected. */
export async function openAttachment(file: LocalAttachment, field: string): Promise<AttachmentReader> {
  let handle: FileHandle;
  try {
    handle = await fs.open(file.absolutePath, 'r');
  } catch (error) {
    throw readFailure(file.path, field, error);
  }
  try {
    const stats = await handle.stat();
    assertAttachable(file.path, field, stats);
    return { size: stats.size, chunks: readChunks(handle, stats.size, file.path, field), close: () => handle.close() };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * download_attachment's `savePath`, checked before anything is downloaded: an existing directory, or a path that does
 * not exist yet inside an existing directory. An existing file (or anything else that is not a directory) is refused.
 */
export async function resolveSaveTarget(savePath: string): Promise<SaveTarget> {
  const absolute = path.resolve(savePath);
  const entry = await statIfExists(absolute, 'lstat');
  if (entry) {
    // A symbolic link to a directory is used as that directory; any other existing entry is never replaced.
    if (entry.isDirectory() || (entry.isSymbolicLink() && (await statIfExists(absolute, 'stat'))?.isDirectory())) {
      return { directory: absolute };
    }
    throw new FileAlreadyExistsError(absolute);
  }
  // A trailing separator names a directory, and that directory does not exist.
  if (savePath.endsWith('/') || savePath.endsWith(path.sep)) {
    throw new ValidationError('savePath', `Directory not found: ${absolute}`);
  }
  const parent = path.dirname(absolute);
  if (!(await statIfExists(parent, 'stat'))?.isDirectory()) {
    throw new ValidationError('savePath', `Directory not found: ${parent}`);
  }
  return { file: absolute };
}

/** A name the file can be saved under inside a directory: not empty, not `.` or `..`, no path separator or NUL. */
export function isUsableFileName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[/\\\0]/.test(name);
}

/** Throws FileAlreadyExistsError when something (a dangling symbolic link too) is at `target`. */
export async function assertNotExists(target: string): Promise<void> {
  if (await statIfExists(target, 'lstat')) throw new FileAlreadyExistsError(target);
}

/**
 * Writes a download to `target`, which must not exist, and returns the number of bytes written. The bytes go to a
 * temporary file in the same directory, which is then hard-linked to `target` (the link fails when something is there
 * by then, so nothing is ever replaced) and removed. Where hard links are not supported the temporary file is copied
 * with COPYFILE_EXCL instead. When the download or the write fails, nothing is left behind.
 */
export async function saveNewFile(target: string, chunks: AsyncIterable<Uint8Array>): Promise<number> {
  const temporary = path.join(path.dirname(target), `.agent-communication-${randomUUID()}.part`);
  let size = 0;
  try {
    try {
      await pipeline(
        chunks,
        async function* count(source: AsyncIterable<Uint8Array>) {
          for await (const chunk of source) {
            size += chunk.length;
            yield chunk;
          }
        },
        createWriteStream(temporary, { flags: 'wx' }),
      );
    } catch (error) {
      throw writeFailure(target, error);
    }
    await publish(temporary, target);
    return size;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Makes `temporary` appear at `target` without replacing anything that is there. */
async function publish(temporary: string, target: string): Promise<void> {
  try {
    await fs.link(temporary, target);
    return;
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'EEXIST') throw new FileAlreadyExistsError(target);
    if (code === undefined || !LINK_UNSUPPORTED.has(code)) throw writeFailure(target, error);
  }
  // No hard links on this file system (e.g. FAT, some network shares): a copy that still refuses to replace `target`.
  try {
    await fs.copyFile(temporary, target, constants.COPYFILE_EXCL);
  } catch (error) {
    if (errnoCode(error) === 'EEXIST') throw new FileAlreadyExistsError(target);
    throw writeFailure(target, error);
  }
}

const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']);

function assertAttachable(given: string, field: string, stats: Stats): void {
  if (!stats.isFile()) throw new ValidationError(field, `'${given}' is not a regular file`);
  if (stats.size > MAX_ATTACHMENT_BYTES) throw new AttachmentTooLargeError(given, MAX_ATTACHMENT_BYTES);
  if (stats.size === 0) throw new ValidationError(field, `'${given}' is empty (an empty file cannot be attached)`);
}

async function* readChunks(handle: FileHandle, size: number, given: string, field: string): AsyncGenerator<Uint8Array> {
  for (let position = 0; position < size; ) {
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, size - position));
    let bytesRead: number;
    try {
      ({ bytesRead } = await handle.read(buffer, 0, buffer.length, position));
    } catch (error) {
      throw readFailure(given, field, error);
    }
    if (bytesRead === 0) throw new ValidationError(field, `'${given}' became shorter while it was being uploaded`);
    position += bytesRead;
    yield bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
  }
}

/** `fs.lstat` / `fs.stat`, or null when nothing is there (ENOENT, or a path component that is not a directory). */
async function statIfExists(target: string, how: 'lstat' | 'stat'): Promise<Stats | null> {
  try {
    return await fs[how](target);
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new ValidationError('savePath', `Cannot access '${target}' (${code ?? String(error)})`);
  }
}

function readFailure(given: string, field: string, error: unknown): Error {
  if (error instanceof AppError) return error;
  const code = errnoCode(error);
  if (code === 'ENOENT' || code === 'ENOTDIR') return new FileNotFoundError(given);
  return new ValidationError(field, `Cannot read '${given}' (${code ?? String(error)})`);
}

function writeFailure(target: string, error: unknown): Error {
  // A failure of the download itself (an AppError from the API client) is reported as it is.
  if (error instanceof AppError) return error;
  const code = errnoCode(error);
  if (code === undefined) return error instanceof Error ? error : new Error(String(error));
  return new ValidationError('savePath', `Cannot write '${target}' (${code})`);
}

/** The Node.js error code of a file system error (AppError's `code` is not one: check for AppError first). */
function errnoCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : undefined;
}
