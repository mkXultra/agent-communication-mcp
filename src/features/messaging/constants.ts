export const WAIT_CONSTANTS = {
  DEFAULT_TIMEOUT: 120000, // 2 minutes
  MIN_TIMEOUT: 1000, // 1 second
  MAX_TIMEOUT: 120000, // 2 minutes
  INITIAL_POLL_INTERVAL: 100, // 100ms
  MAX_POLL_INTERVAL: 1000, // 1 second
  BACKOFF_FACTOR: 1.5
};

export const READ_STATUS_FILENAME = 'read_status.json';
export const WAITING_AGENTS_FILENAME = 'waiting_agents.json';