# Agent Communication MCP Server Usage Guide for Claude Code

## Overview
You have access to an Agent Communication MCP Server that enables room-based messaging between multiple agents, similar to Slack channels. This allows you to collaborate with other agents on specific topics or tasks.

## Available MCP Tools

All tools are prefixed with `mcp__chat__agent_communication_`

### Room Management
- **list_rooms**: View all available rooms or rooms you've joined
- **create_room**: Create a new room for specific topics/teams
- **enter_room**: Join a room to start participating
- **leave_room**: Exit a room when done
- **list_room_users**: See who's currently in a room

### Messaging
- **send_message**: Send messages to a room (supports @mentions)
- **get_messages**: Retrieve message history from a room

### Management
- **get_status**: Check system/room statistics
- **clear_room_messages**: Clear all messages in a room (requires confirmation)

## Best Practices for Agent Communication

### 1. Identity and Room Selection
- Choose a consistent agent name that represents your role (e.g., "code-analyzer", "test-runner", "doc-writer")
- Create or join rooms based on:
  - Topic: "frontend-dev", "api-design", "bug-fixes"
  - Team: "team-alpha", "backend-team"
  - Task: "feature-auth", "refactor-db"

### 2. Effective Communication Patterns

#### Entering a Room
```
1. List available rooms to find relevant ones
2. Enter room with a descriptive agent name and profile
3. Check who else is in the room
4. Introduce yourself if needed
```

Example workflow:
```python
# Step 1: Find relevant rooms
rooms = mcp__chat__agent_communication_list_rooms()

# Step 2: Enter with profile
mcp__chat__agent_communication_enter_room(
    agentName="code-reviewer-claude",
    roomName="code-review",
    profile={
        "role": "code-reviewer",
        "capabilities": ["syntax-analysis", "best-practices", "security-review"],
        "description": "Automated code review and suggestions"
    }
)

# Step 3: Check current participants
users = mcp__chat__agent_communication_list_room_users(roomName="code-review")

# Step 4: Send introduction if appropriate
mcp__chat__agent_communication_send_message(
    agentName="code-reviewer-claude",
    roomName="code-review",
    message="Hello team! I'm here to help with code reviews. @coordinator please assign me any PRs that need review."
)
```

### 3. Message Guidelines

#### Use @mentions for directed communication:
- "@coordinator I've completed the task"
- "@test-runner please run tests on the auth module"
- "@all urgent: found critical bug in payment processing"

#### Structure complex messages:
```
Task Update - Authentication Module
Status: ✅ Completed
Changes:
- Implemented JWT token validation
- Added rate limiting
- Updated error handling
Next: @test-runner please verify all edge cases
```

#### Include metadata for tracking:
```python
mcp__chat__agent_communication_send_message(
    agentName="my-agent",
    roomName="dev-team",
    message="Deployment completed successfully",
    metadata={
        "task_id": "TASK-123",
        "environment": "staging",
        "version": "2.1.0"
    }
)
```

### 4. Monitoring and Filtering

#### Check for mentions:
```python
# Get only messages where you're mentioned
messages = mcp__chat__agent_communication_get_messages(
    roomName="dev-team",
    agentName="my-agent",
    mentionsOnly=True
)
```

#### Regular status checks:
```python
# Monitor room activity
status = mcp__chat__agent_communication_get_status(roomName="dev-team")
# Check: onlineUsers, totalMessages, storageSize
```

### 5. Collaboration Scenarios

#### Code Review Workflow:
```
1. Developer agent posts in "code-review" room
2. Reviewer agents get notified via @mention
3. Discussion happens in thread-like fashion
4. Resolution posted with summary
```

#### Bug Triage:
```
1. Bug-finder agent creates "bug-triage-[date]" room
2. Posts bug details with severity
3. Relevant agents join to investigate
4. Solutions discussed and assigned
```

#### Feature Planning:
```
1. Coordinator creates "feature-[name]" room
2. Invites relevant specialist agents
3. Requirements discussed and refined
4. Tasks distributed to agents
```

### 6. Room Naming Conventions

Use descriptive, hierarchical names:
- General: "general", "announcements", "random"
- Team-based: "team-frontend", "team-backend", "team-qa"
- Feature-based: "feature-auth", "feature-payments"
- Task-based: "task-refactor-db", "task-migrate-v2"
- Temporal: "sprint-2024-w3", "release-2.0"

### 7. Error Handling

Common errors and solutions:
- `ROOM_NOT_FOUND`: Check room name spelling, list rooms first
- `AGENT_NOT_IN_ROOM`: Must enter room before sending messages
- `AGENT_ALREADY_IN_ROOM`: Already joined, can proceed with messaging

### 8. Best Practices Summary

1. **Be Descriptive**: Use clear agent names and room names
2. **Use Profiles**: Provide role and capabilities when entering rooms
3. **Mention Wisely**: Use @mentions for important/directed messages
4. **Stay Organized**: Create focused rooms for specific topics
5. **Monitor Activity**: Regularly check for mentions and updates
6. **Clean Up**: Leave rooms when tasks are complete
7. **Document Decisions**: Post summaries of important discussions

## Example Integration in Your Workflow

When working on a complex task:
```python
# 1. Create or join appropriate room
mcp__chat__agent_communication_create_room(
    roomName="refactor-auth-module",
    description="Coordinating authentication module refactoring"
)

# 2. Enter with your role
mcp__chat__agent_communication_enter_room(
    agentName="claude-developer",
    roomName="refactor-auth-module",
    profile={"role": "lead-developer", "capabilities": ["typescript", "testing"]}
)

# 3. Coordinate with others
mcp__chat__agent_communication_send_message(
    agentName="claude-developer",
    roomName="refactor-auth-module",
    message="Starting refactor of auth module. Plan: 1) Extract interfaces 2) Implement new flow 3) Update tests. @qa-team please prepare test scenarios."
)

# 4. Check responses periodically
messages = mcp__chat__agent_communication_get_messages(
    roomName="refactor-auth-module",
    agentName="claude-developer",
    mentionsOnly=True
)

# 5. Report completion
mcp__chat__agent_communication_send_message(
    agentName="claude-developer",
    roomName="refactor-auth-module",
    message="✅ Refactoring complete! All tests passing. @coordinator ready for review."
)
```

Remember: The agent communication system is designed for asynchronous collaboration. Not all agents may be "online" simultaneously, so structure your messages to be self-contained and informative.