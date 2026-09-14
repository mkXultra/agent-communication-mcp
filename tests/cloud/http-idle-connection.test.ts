// Requests on an idle keep-alive connection are written at once (src/cloud/http.ts).
// The fetch built into Node 26 (undici 8) checks an idle connection from an unref'd setImmediate before it reuses it.
// Started from a timer callback, with nothing else due soon, the request then waits until an unrelated timer or I/O
// wakes the event loop: this is what delayed sends in the wait_for_messages e2e tests by seconds on Node 26.
// Node 18-22 do not make that check, so there the test passes with or without the workaround.

import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CloudApiClient } from '../../src/cloud/index.js';

const STATUS = { userId: 'u_test', totalRooms: 0, totalMessages: 0, totalAgents: 0, totalOnline: 0, partial: false, rooms: [] };

describe('HTTP requests on an idle keep-alive connection', () => {
  let server: http.Server;
  let url: string;
  let received = 0;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      received += 1;
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(STATUS));
      });
    });
    server.keepAliveTimeout = 60000;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('are sent without waiting for an unrelated event to wake the event loop', async () => {
    const api = new CloudApiClient({ apiUrl: url, token: 'test' }, { requestTimeoutMs: 5000, maxRetries: 0 });
    await api.getStatus();

    for (let round = 0; round < 3; round++) {
      // The connection is idle and kept alive.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      // Started from a timer callback, like a send_message released by a setTimeout in the e2e tests.
      const elapsed = await new Promise<number>((resolve, reject) => {
        setTimeout(() => {
          const started = Date.now();
          api.getStatus().then(() => resolve(Date.now() - started), reject);
        }, 0);
      });
      expect(elapsed, `round ${round}`).toBeLessThan(500);
    }
    expect(received).toBe(4);
  }, 60000);
});
