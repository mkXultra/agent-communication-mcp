// vitest setupFiles of the `file` project.
// These tests exercise the local file storage. Cloud mode wins whenever AGENT_COMM_API_URL and
// AGENT_COMM_TOKEN are both set, so drop them: a shell configured for cloud mode must not send the
// file-mode suite to a real API (tests that need cloud mode live in the `cloud` project).
delete process.env.AGENT_COMM_API_URL;
delete process.env.AGENT_COMM_TOKEN;
