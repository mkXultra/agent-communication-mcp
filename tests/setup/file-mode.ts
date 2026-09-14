// vitest setupFiles of the `file` project.
// These tests exercise the local file storage. AGENT_COMM_TOKEN alone selects cloud mode (against the production API
// unless AGENT_COMM_API_URL points elsewhere), so drop both: a shell configured for cloud mode must not send the
// file-mode suite to a real API (tests that need cloud mode live in the cloud projects).
delete process.env.AGENT_COMM_API_URL;
delete process.env.AGENT_COMM_TOKEN;
