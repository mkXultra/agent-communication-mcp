# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an Agent Communication MCP Server - a Model Context Protocol (MCP) server that enables room-based messaging between multiple agents, similar to Slack channels. The project is in early development stage with only a specification document (spec.md) currently present.

## Important Project Documents

Please refer to these critical documents before implementation:

- **@implementation-policy.md**: Technical decisions prioritizing simplicity and testability
  - Error handling approach using custom error classes
  - Async processing patterns with Promise/async-await
  - Validation strategy (input-only validation)
  - Logging with structured JSON format
  - Testing strategies and conventions

- **@implementation-plan.md**: Phased implementation roadmap
  - Technology stack details (TypeScript, Node.js, Vitest)
  - Phase 1-4 breakdown with time estimates
  - Directory structure and file organization
  - Risk mitigation strategies
  - Success criteria and performance targets

## Architecture Overview

The planned architecture follows these key patterns:

### Data Storage
- Room-based JSONL files for messages: `data/rooms/{roomName}/messages.jsonl`
- JSON files for presence tracking: `data/rooms/{roomName}/presence.json`
- Central room registry: `data/rooms.json`
- File locking mechanism for concurrent access control

### Core Components (Planned)
- **Room Management**: Create, list, join/leave rooms
- **Messaging System**: Send/receive messages with @mentions support
- **Presence Tracking**: Track online/offline status per room
- **Management Tools**: Status monitoring, message clearing

### Directory Structure
```
src/
├── index.ts           # Entry point
├── tools/            # MCP tool definitions
│   ├── room.ts       # Room management tools
│   ├── messaging.ts  # Messaging tools
│   └── management.ts # Management tools
├── services/         # Business logic
│   ├── RoomService.ts
│   ├── MessageService.ts
│   └── StorageService.ts
├── utils/            # Utilities
│   └── filelock.ts   # File locking mechanism
└── types/            # Type definitions
    └── index.ts
```

## Development Setup

Since the project hasn't been initialized yet, you'll need to:

1. Initialize a TypeScript project:
```bash
npm init -y
npm install typescript @types/node --save-dev
npm install @modelcontextprotocol/sdk
npx tsc --init
```

2. Set up the basic npm scripts in package.json:
```json
{
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "node dist/index.js",
    "test": "jest",
    "lint": "eslint src/**/*.ts",
    "typecheck": "tsc --noEmit"
  }
}
```

## MCP Protocol Implementation

This server implements the Model Context Protocol with JSON-RPC 2.0 communication. All tools follow the standard MCP tool definition format with proper error handling and response structures.

## Key Implementation Considerations

1. **File Locking**: Implement proper file locking to handle concurrent access from multiple agents
2. **Input Validation**: Validate agent names, room names (alphanumeric, hyphens, underscores), and message content
3. **Error Handling**: Use specific error codes (ROOM_NOT_FOUND, AGENT_NOT_IN_ROOM, etc.)
4. **Performance**: Consider file size limits and implement rotation for message files
5. **Security**: Prevent directory traversal, validate all file paths

## Environment Variables

```bash
AGENT_COMM_DATA_DIR       # Data directory (default: ./data)
AGENT_COMM_LOCK_TIMEOUT   # Lock timeout (default: 5000ms)
AGENT_COMM_MAX_MESSAGES   # Max messages per room (default: 10000)
AGENT_COMM_MAX_ROOMS      # Max rooms (default: 100)
```