// Agent Communication MCP Server - cloud API shapes -> existing tool output shapes
// docs/cloud-architecture.md §5.2: the API responses are not one-to-one with the tool outputs.

import type { Message } from '../types/entities.js';
import type { ApiMessage } from './types.js';

/**
 * The message shape the file mode returns (no `seq` / `clientMessageId`), with `attachments` (§3.9) when the message
 * has any; like the other optional fields, it is left out otherwise.
 */
export function toToolMessage(message: ApiMessage): Message {
  return {
    id: message.id,
    agentName: message.agentName,
    roomName: message.roomName,
    message: message.message,
    timestamp: message.timestamp,
    mentions: message.mentions,
    ...(message.metadata !== undefined ? { metadata: message.metadata } : {}),
    ...(message.attachments && message.attachments.length > 0
      ? {
          attachments: message.attachments.map(({ id, name, size, contentType }) => ({ id, name, size, contentType })),
        }
      : {}),
  };
}

export interface WaitForMessagesResult {
  messages: Message[];
  hasNewMessages: boolean;
  timedOut: boolean;
  warning?: string;
  waitingAgents?: string[];
}

/** The warning the file mode returns (MessageService.waitForMessages), built from the other waiting agents. */
export function deadlockWarning(otherWaitingAgents: number): string {
  return `Potential deadlock detected: ${otherWaitingAgents} other agent(s) are also waiting for messages`;
}

/**
 * `hasNewMessages` is derived from `messages.length > 0`; the waiting agents come from the `waiting` frame (or the
 * long-poll response). Like the file mode, `waitingAgents` lists the *other* waiting agents, `warning` uses the
 * file-mode text, and both are omitted when nobody else is waiting.
 */
export function toWaitResult(
  agentName: string,
  messages: ApiMessage[],
  timedOut: boolean,
  waiting: { waitingAgents?: string[] } | undefined,
): WaitForMessagesResult {
  const others = (waiting?.waitingAgents ?? []).filter((name) => name !== agentName);
  return {
    messages: messages.map(toToolMessage),
    hasNewMessages: messages.length > 0,
    timedOut,
    warning: others.length > 0 ? deadlockWarning(others.length) : undefined,
    waitingAgents: others.length > 0 ? others : undefined,
  };
}
