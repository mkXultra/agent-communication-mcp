// vitest globalSetup of the cloud projects (`cloud-compat` and `cloud`): the agora instances for the whole run.
//
// - `agoraUrl`: the agora every cloud test file talks to (a token per file keeps their data apart).
// - `faultAgoraUrl`: a second agora with FAULT_INJECTION=1 for tests that inject server faults or shrink limits
//   with agora's test headers. It is started here, before any test runs, so that starting wrangler dev does not
//   load the machine while timing-sensitive tests are running.
//
// Both cloud projects list this file; vitest runs every project's globalSetup before the first test. The instances
// are started once per run and stopped by the last project's teardown.
//
// A missing or broken AGORA_DIR must not skip the cloud tests. The error is handed to every cloud test file
// (tests/cloud/harness/setup.ts throws it), so they all fail with the reason while the file-mode project still runs.

import type { TestProject } from 'vitest/node';
import { startAgora, type AgoraInstance } from './agora';

declare module 'vitest' {
  export interface ProvidedContext {
    agoraUrl: string;
    agoraInstanceId: string;
    faultAgoraUrl: string;
    agoraError: string;
  }
}

interface SharedAgora {
  started: Promise<{ main: AgoraInstance; fault: AgoraInstance } | { error: string }>;
  users: number;
}

const SHARED_KEY = Symbol.for('agent-communication-mcp.tests.agora');

async function startBoth(): Promise<{ main: AgoraInstance; fault: AgoraInstance } | { error: string }> {
  const results = await Promise.allSettled([startAgora(), startAgora({ vars: { FAULT_INJECTION: '1' } })]);
  const [main, fault] = results;
  if (main.status === 'fulfilled' && fault.status === 'fulfilled') return { main: main.value, fault: fault.value };
  await Promise.all(results.map((result) => (result.status === 'fulfilled' ? result.value.stop() : undefined)));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')!;
  return { error: failure.reason instanceof Error ? failure.reason.message : String(failure.reason) };
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const registry = globalThis as { [SHARED_KEY]?: SharedAgora };
  const shared = (registry[SHARED_KEY] ??= { started: startBoth(), users: 0 });
  shared.users += 1;

  const started = await shared.started;
  if ('error' in started) {
    project.provide('agoraUrl', '');
    project.provide('agoraInstanceId', '');
    project.provide('faultAgoraUrl', '');
    project.provide('agoraError', started.error);
  } else {
    project.provide('agoraUrl', started.main.url);
    project.provide('agoraInstanceId', started.main.instanceId);
    project.provide('faultAgoraUrl', started.fault.url);
    project.provide('agoraError', '');
  }

  return async () => {
    shared.users -= 1;
    if (shared.users > 0) return;
    delete registry[SHARED_KEY];
    if (!('error' in started)) await Promise.all([started.main.stop(), started.fault.stop()]);
  };
}
