export const WAIT_CONSTANTS = {
  DEFAULT_TIMEOUT: 30000, // 30 seconds (the tool default)
  MIN_TIMEOUT: 1000, // 1 second
  MAX_TIMEOUT: 300000, // 5 minutes (the tool maximum)
  NO_TIMEOUT: 0, // wait until a message arrives (docs/cloud-architecture.md §5.4)
  INITIAL_POLL_INTERVAL: 100, // 100ms
  MAX_POLL_INTERVAL: 1000, // 1 second
  BACKOFF_FACTOR: 1.5
};

export const READ_STATUS_FILENAME = 'read_status.json';
export const WAITING_AGENTS_FILENAME = 'waiting_agents.json';
