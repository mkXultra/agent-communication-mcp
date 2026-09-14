// vitest setupFiles of the `cloud` project: runs before every test file of that project.
//
// - Fails the file when agora is not running (never skips).
// - Issues a token for this file with POST /tokens, so files running in parallel get separate users.
// - Switches the process to cloud mode (AGENT_COMM_API_URL + AGENT_COMM_TOKEN win over AGENT_COMM_DATA_DIR).
// - Deletes the user's rooms before each test, the cloud counterpart of the fresh data directory the
//   file-mode tests start from.

import { randomUUID } from 'crypto';
import { beforeEach, inject } from 'vitest';
import { deleteAllRooms, issueToken } from './agora';

const agoraUrl = inject('agoraUrl');
if (!agoraUrl) {
  throw new Error(`Cloud mode tests could not start agora with wrangler dev: ${inject('agoraError') || 'unknown error'}`);
}

const token = await issueToken(agoraUrl, `agent-communication-mcp vitest ${randomUUID()}`);

process.env.AGENT_COMM_API_URL = agoraUrl;
process.env.AGENT_COMM_TOKEN = token;

beforeEach(async () => {
  await deleteAllRooms(agoraUrl, token);
});
