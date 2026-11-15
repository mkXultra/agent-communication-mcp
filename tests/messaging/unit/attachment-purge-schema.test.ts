// The attachment range deletion's MCP input schema and cloud mapping/API client, without agora:
// the one tool input covers a non-mutating preview and an explicitly confirmed execution, the message mapping exposes
// the additive `seq` used as the boundary, and the client sends the inclusive range (202 is a result).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { CloudApiClient } from '../../../src/cloud/index.js';
import { toToolMessage } from '../../../src/cloud/mappers.js';
import type { ApiAttachmentPurgePreview, ApiAttachmentPurgeResult, ApiMessage } from '../../../src/cloud/types.js';
import { deleteAttachmentsThroughPostInputSchema, deleteAttachmentsThroughPostOutputSchema } from '../../../src/schemas/index.js';

const PREVIEW: ApiAttachmentPurgePreview = {
  dryRun: true,
  roomName: 'room',
  throughSeq: 7,
  latestSeq: 9,
  boundaryMessageExists: true,
  boundaryMessageId: 'message-7',
  attachmentCount: 2,
  attachmentBytes: 14,
  messagesThroughBoundary: 7,
  unpostedAttachmentCount: 1,
  unpostedAttachmentBytes: 3,
  retainedDisplayMetadataCount: 0,
  afterBoundaryAttachmentCount: 1,
  afterBoundaryAttachmentBytes: 5,
  previewedAt: '2026-11-11T00:00:00.000Z',
};

const RESULT: ApiAttachmentPurgeResult = {
  success: true,
  roomName: 'room',
  throughSeq: 7,
  deletionStatus: 'pending',
  deletedAttachmentCount: 2,
  deletedAttachmentBytes: 14,
  pendingAttachments: 2,
  executedAt: '2026-11-11T00:00:01.000Z',
};

interface Recorded {
  method: string | undefined;
  url: string | undefined;
  body: string;
  headers: http.IncomingHttpHeaders;
}

describe('delete_attachments_through_post input schema', () => {
  it('accepts a preview and an explicitly confirmed execution without any generation input', () => {
    expect(deleteAttachmentsThroughPostInputSchema.parse({ roomName: 'room', throughSeq: 7 })).toEqual({
      roomName: 'room',
      throughSeq: 7,
      confirm: false,
    });
    expect(
      deleteAttachmentsThroughPostInputSchema.parse({ roomName: 'room', throughSeq: 7, confirm: false }),
    ).toEqual({ roomName: 'room', throughSeq: 7, confirm: false });
    expect(
      deleteAttachmentsThroughPostInputSchema.parse({ roomName: 'room', throughSeq: 7, confirm: true }),
    ).toEqual({ roomName: 'room', throughSeq: 7, confirm: true });
    // No epoch/token input: a confirmed execution needs only the room name and the inclusive boundary.
    expect(deleteAttachmentsThroughPostInputSchema.keyof().options).toEqual(['roomName', 'throughSeq', 'confirm']);
  });

  it('requires a safe positive integer post position', () => {
    for (const throughSeq of [0, -1, 1.5, '7', Number.MAX_SAFE_INTEGER + 1, null]) {
      const result = deleteAttachmentsThroughPostInputSchema.safeParse({ roomName: 'room', throughSeq });
      expect(result.success).toBe(false);
      expect(result.error!.issues[0]!.path).toEqual(['throughSeq']);
    }
  });
});

describe('delete_attachments_through_post output contract', () => {
  it('accepts the preview and complete/pending results, including pending with no new deletion', () => {
    expect(deleteAttachmentsThroughPostOutputSchema.safeParse(PREVIEW).success).toBe(true);
    expect(PREVIEW).not.toHaveProperty('epoch');
    expect(RESULT).not.toHaveProperty('epoch');
    // The preview-only display-metadata count has its own name; deletedAttachmentCount stays
    // exclusive to the execute result (live rows newly deleted by this request).
    expect(PREVIEW).not.toHaveProperty('deletedAttachmentCount');
    const { retainedDisplayMetadataCount: _omitted, ...withoutDisplayCount } = PREVIEW;
    expect(deleteAttachmentsThroughPostOutputSchema.safeParse(withoutDisplayCount).success).toBe(false);
    expect(
      deleteAttachmentsThroughPostOutputSchema.safeParse({
        ...RESULT,
        deletionStatus: 'complete',
        pendingAttachments: 0,
        retryAfterMs: undefined,
      }).success,
    ).toBe(true);
    // A conservative legacy-ledger retry: no new deletion, physical cleanup still pending, so never complete.
    expect(
      deleteAttachmentsThroughPostOutputSchema.safeParse({
        ...RESULT,
        deletedAttachmentCount: 0,
        deletedAttachmentBytes: 0,
        pendingAttachments: 3,
      }).success,
    ).toBe(true);
  });
});

describe('cloud message mapping for the boundary', () => {
  it('adds seq (and keeps attachments when present)', () => {
    const message: ApiMessage = {
      id: 'm1',
      seq: 12,
      agentName: 'alice',
      roomName: 'room',
      message: 'with a file',
      timestamp: '2026-11-11T00:00:00.000Z',
      mentions: [],
      attachments: [{ id: 'a1', name: 'a.txt', size: 3, contentType: 'text/plain' }],
    };
    expect(toToolMessage(message)).toEqual({
      id: 'm1',
      seq: 12,
      agentName: 'alice',
      roomName: 'room',
      message: 'with a file',
      timestamp: '2026-11-11T00:00:00.000Z',
      mentions: [],
      attachments: [{ id: 'a1', name: 'a.txt', size: 3, contentType: 'text/plain' }],
    });
  });
});

describe('CloudApiClient attachment range requests', () => {
  let server: http.Server;
  let client: CloudApiClient;
  const requests: Recorded[] = [];
  let response: { status: number; headers: Record<string, string>; body: unknown };
  // One-shot responses for the retry tests; consumed before `response`.
  const queued: Array<{ status: number; headers: Record<string, string>; body: unknown }> = [];

  beforeAll(async () => {
    server = http.createServer((request, res) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requests.push({
          method: request.method,
          url: request.url,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: request.headers,
        });
        const current = queued.shift() ?? response;
        res.writeHead(current.status, { 'content-type': 'application/json', ...current.headers });
        res.end(JSON.stringify(current.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    client = new CloudApiClient({ apiUrl: `http://127.0.0.1:${port}`, token: 'test-token' });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('previews with throughSeq and no confirmation, and returns the fixed scope', async () => {
    requests.length = 0;
    response = { status: 200, headers: {}, body: PREVIEW };
    await expect(client.previewAttachmentPurge('room', 7)).resolves.toEqual(PREVIEW);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: '/rooms/room/attachments/purge/preview',
      body: JSON.stringify({ throughSeq: 7 }),
    });
    expect(requests[0]!.headers.authorization).toBe('Bearer test-token');
  });

  it('executes with confirm=true and only throughSeq, treating 202 as a pending success', async () => {
    requests.length = 0;
    response = { status: 202, headers: { 'retry-after': '60' }, body: RESULT };
    const result = await client.executeAttachmentPurge('room', { throughSeq: 7 });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: '/rooms/room/attachments/purge/execute?confirm=true',
      body: JSON.stringify({ throughSeq: 7 }),
    });
    expect(requests[0]!.body).not.toContain('epoch');
    // The Retry-After header is propagated when the body does not carry retryAfterMs.
    expect(result).toEqual({ ...RESULT, retryAfterMs: 60000 });
  });

  it('keeps the body retryAfterMs when both the body and the header carry it', async () => {
    response = { status: 202, headers: { 'retry-after': '30' }, body: { ...RESULT, retryAfterMs: 45000 } };
    await expect(client.executeAttachmentPurge('room', { throughSeq: 7 })).resolves.toMatchObject({
      deletionStatus: 'pending',
      retryAfterMs: 45000,
    });
  });

  it('keeps a pending result with zero new deletions pending (legacy ledger retry)', async () => {
    // The backend can have same-generation cleanup rows whose post position cannot be proven; it counts and retries
    // them conservatively. Reporting them as complete because no row was newly deleted would be a false completion.
    response = {
      status: 202,
      headers: { 'retry-after': '120' },
      body: { ...RESULT, deletedAttachmentCount: 0, deletedAttachmentBytes: 0, pendingAttachments: 3 },
    };
    await expect(client.executeAttachmentPurge('room', { throughSeq: 7 })).resolves.toMatchObject({
      deletionStatus: 'pending',
      deletedAttachmentCount: 0,
      deletedAttachmentBytes: 0,
      pendingAttachments: 3,
      retryAfterMs: 120000,
    });
  });

  it('retries a transient failure with the identical range, never a re-read boundary', async () => {
    const transient = { status: 503, headers: {}, body: { code: 'SERVICE_UNAVAILABLE', message: 'try later' } };

    // Preview: the retry repeats the caller's throughSeq.
    requests.length = 0;
    queued.push({ ...transient }, { status: 200, headers: {}, body: PREVIEW });
    await expect(client.previewAttachmentPurge('room', 7)).resolves.toEqual(PREVIEW);
    expect(requests.map((record) => record.body)).toEqual([
      JSON.stringify({ throughSeq: 7 }),
      JSON.stringify({ throughSeq: 7 }),
    ]);

    // Execute: the retry repeats the same throughSeq (it never asks agora for the current latest).
    requests.length = 0;
    queued.push({ ...transient }, { status: 202, headers: { 'retry-after': '60' }, body: RESULT });
    await expect(client.executeAttachmentPurge('room', { throughSeq: 7 })).resolves.toMatchObject({
      deletionStatus: 'pending',
      pendingAttachments: 2,
      retryAfterMs: 60000,
    });
    expect(requests.map((record) => record.url)).toEqual([
      '/rooms/room/attachments/purge/execute?confirm=true',
      '/rooms/room/attachments/purge/execute?confirm=true',
    ]);
    expect(requests.map((record) => record.body)).toEqual([
      JSON.stringify({ throughSeq: 7 }),
      JSON.stringify({ throughSeq: 7 }),
    ]);
  });
});
