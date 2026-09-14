// The test harness itself: an agora instance is only used when it is the one this run started.
// Test runs in parallel (e.g. several reviewers) pick free ports independently; when another run takes the port
// before our wrangler dev binds it, our wrangler exits and the other run's agora answers on that port.

import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import { describe, expect, inject, it } from 'vitest';
import { nodeVersionProblem, probeHealth, startAgora } from './harness/agora.js';

describe('agora test harness', () => {
  it('names the Node.js version wrangler needs instead of failing to start it', () => {
    expect(nodeVersionProblem('>=22.0.0', 'v20.20.2')).toBe(
      'Cloud mode tests run wrangler dev, which needs Node.js >=22.0.0; this is Node.js v20.20.2',
    );
    expect(nodeVersionProblem('>=22.0.0', 'v22.17.0')).toBeUndefined();
    expect(nodeVersionProblem('>=22.0.0', 'v26.7.0')).toBeUndefined();
    expect(nodeVersionProblem(undefined, 'v18.20.0')).toBeUndefined();
  });

  it('recognizes the agora it started by the instance id that /health reports', async () => {
    const url = inject('agoraUrl');
    expect(await probeHealth(url, inject('agoraInstanceId'))).toBe(true);
    expect(await probeHealth(url, `test-${randomUUID()}`)).toBe(false);
  });

  it('does not take another agora on the chosen port for its own and starts on a new port', async () => {
    // Stands in for the agora of another test run: it answers /health, with that run's instance id.
    const foreign = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, version: `test-${randomUUID()}` }));
    });
    await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve));
    const foreignPort = (foreign.address() as AddressInfo).port;

    try {
      const instance = await startAgora({ firstPort: foreignPort });
      try {
        expect(instance.port).not.toBe(foreignPort);
        expect(await probeHealth(instance.url, instance.instanceId)).toBe(true);
        expect(await probeHealth(`http://127.0.0.1:${foreignPort}`, instance.instanceId)).toBe(false);
      } finally {
        await instance.stop();
      }
      expect(await probeHealth(instance.url, instance.instanceId)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => foreign.close(() => resolve()));
    }
  }, 120000);
});
