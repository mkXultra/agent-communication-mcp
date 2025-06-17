# MCP Server Tools Error Investigation Report

## Problem Description

When running `node dist/index.js`, the MCP server fails to start with the following error:

```
{"timestamp":"2025-06-17T03:27:59.248Z","context":"Server startup","error":{"name":"AppError","message":"Failed to register tools: Server does not support tools (required for tools/list)","stack":"..."}}
```

The error occurs in `ToolRegistry.registerAll()` when attempting to register the `tools/list` request handler, indicating that the server doesn't support tools capability.

## Root Cause Analysis

The root cause is that the MCP Server is not being initialized with the required capabilities configuration. According to the MCP documentation, servers must explicitly declare their capabilities during initialization to support tools.

### Current Implementation (Incorrect)

In `src/index.ts:11-14`:
```typescript
// Create MCP server
const server = new Server({
  name: 'agent-communication',
  version: '1.0.0'
});
```

### Required Implementation

The Server constructor accepts a second parameter for capabilities:
```typescript
const server = new Server({
  name: 'agent-communication',
  version: '1.0.0'
}, {
  capabilities: {
    tools: {}
  }
});
```

## Code Analysis

### Problematic Areas

1. **src/index.ts** - Missing capabilities in Server initialization
   - The Server is created without declaring tool support capability
   - This causes the server to reject tool-related request handlers

2. **src/server/ToolRegistry.ts:60-62** - Tool registration fails
   ```typescript
   // Register tools list handler
   server.setRequestHandler(listToolsRequestSchema, async () => ({
     tools: allTools
   }));
   ```
   - This registration fails because the server doesn't advertise tool support
   - The error "Server does not support tools (required for tools/list)" is thrown by the MCP SDK

## Proposed Solution

### 1. Update Server Initialization in src/index.ts

```typescript
// Create MCP server with tool capabilities
const server = new Server({
  name: 'agent-communication',
  version: '1.0.0'
}, {
  capabilities: {
    tools: {}  // Enable tool support
  }
});
```

### 2. Additional Improvements (Optional)

Consider adding other capabilities if needed:
```typescript
const server = new Server({
  name: 'agent-communication',
  version: '1.0.0'
}, {
  capabilities: {
    tools: {},
    // prompts: {},  // If prompt support is needed later
    // resources: {} // If resource support is needed later
  }
});
```

## Impact Assessment

### Minimal Impact
- This is a one-line fix that only affects server initialization
- No changes required to tool registration logic or tool implementations
- No breaking changes to existing functionality

### Benefits
- Enables the MCP server to properly advertise tool support
- Allows successful registration of all tool handlers
- Makes the server compliant with MCP protocol requirements

### Testing Requirements
- Verify server starts without errors
- Confirm `tools/list` endpoint returns the list of available tools
- Test that individual tools can be called successfully

## Implementation Steps

1. Add the capabilities parameter to the Server constructor in `src/index.ts`
2. Rebuild the project: `npm run build`
3. Run the server: `npm start` or `node dist/index.js`
4. Verify the server starts without the "Server does not support tools" error

## References

- [MCP Tools Documentation](https://modelcontextprotocol.io/docs/concepts/tools)
- MCP SDK Server class requires explicit capability declaration
- Similar issues found in community forums suggest this is a common initialization oversight