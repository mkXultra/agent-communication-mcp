import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { sendMessageSchema, getMessagesSchema, downloadAttachmentSchema, waitForMessagesInputSchema } from '../schemas/index.js';

export const sendMessageTool: Tool = {
  name: 'agent_communication_send_message',
  description: 'Send a message to a room',
  inputSchema: {
    type: 'object',
    properties: {
      agentName: {
        type: 'string',
        description: 'Name of the agent sending the message'
      },
      roomName: {
        type: 'string',
        description: 'Name of the room to send the message to'
      },
      message: {
        type: 'string',
        description: 'The message content to send'
      }
    },
    required: ['agentName', 'roomName', 'message'],
    additionalProperties: false
  }
};

// Cloud mode: send_message also takes local files to attach (docs/cloud-architecture.md §3.9)
export const cloudSendMessageTool: Tool = {
  ...sendMessageTool,
  inputSchema: {
    ...sendMessageTool.inputSchema,
    properties: {
      ...sendMessageTool.inputSchema.properties,
      attachments: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 10,
        description: 'Paths of local files to attach (up to 10 files, 10 MB each). Relative paths are resolved from the working directory of the MCP server'
      }
    }
  }
};

// Cloud mode only: saves an attachment to a local file; the file content is not part of the response
export const downloadAttachmentTool: Tool = {
  name: 'agent_communication_download_attachment',
  description: 'Download a file attached to a message and save it to a local path. Returns the saved path, name, size and content type (not the file content)',
  inputSchema: {
    type: 'object',
    properties: {
      roomName: {
        type: 'string',
        description: 'Name of the room of the message the file is attached to'
      },
      attachmentId: {
        type: 'string',
        description: 'ID of the attachment (attachments[].id of a message returned by get_messages or wait_for_messages)'
      },
      savePath: {
        type: 'string',
        description: 'An existing directory (the file is saved in it under its original name) or the path of a new file in an existing directory. An existing file is never overwritten. Relative paths are resolved from the working directory of the MCP server'
      }
    },
    required: ['roomName', 'attachmentId', 'savePath'],
    additionalProperties: false
  }
};

export const getMessagesTool: Tool = {
  name: 'agent_communication_get_messages',
  description: 'Get messages from a room',
  inputSchema: {
    type: 'object',
    properties: {
      agentName: {
        type: 'string',
        description: 'Name of the agent requesting the messages'
      },
      roomName: {
        type: 'string',
        description: 'Name of the room to get messages from'
      },
      limit: {
        type: 'number',
        description: 'Maximum number of messages to retrieve',
        minimum: 1,
        maximum: 100,
        default: 20
      },
      before: {
        type: 'string',
        description: 'Message ID to get messages before (for pagination)'
      }
    },
    required: ['agentName', 'roomName'],
    additionalProperties: false
  }
};

export const waitForMessagesTool: Tool = {
  name: 'agent_communication_wait_for_messages',
  description: 'Wait for new messages in a room using long-polling. This tool will block until new messages are available or the timeout is reached. Returns immediately if new messages are already available since the last check.',
  inputSchema: {
    type: 'object',
    properties: {
      agentName: {
        type: 'string',
        description: 'Name of the agent waiting for messages'
      },
      roomName: {
        type: 'string',
        description: 'Name of the room to wait for messages in'
      },
      timeout: {
        type: 'number',
        description: 'Maximum time to wait for new messages in seconds (1-300). 0 = メッセージが届くまで無期限に待つ（常駐エージェント向け）',
        minimum: 0,
        maximum: 300,
        default: 30
      },
      mentionsOnly: {
        type: 'boolean',
        description: 'Only return messages that mention agentName; other new messages are marked read without being returned',
        default: false
      }
    },
    required: ['agentName', 'roomName'],
    additionalProperties: false
  }
};

// Cloud mode: agora posts server notices as agent `system` and returns them to every reader and waiter (agora D18)
const SERVER_NOTICES =
  'Server notices from agentName "system" (e.g. every online member has been waiting for 30+ minutes) are always returned, also with mentionsOnly.';

export const cloudGetMessagesTool: Tool = {
  ...getMessagesTool,
  description: `${getMessagesTool.description}. ${SERVER_NOTICES}`
};

export const cloudWaitForMessagesTool: Tool = {
  ...waitForMessagesTool,
  description: `${waitForMessagesTool.description} ${SERVER_NOTICES}`
};

export async function handleSendMessage(
  args: any,
  messagingAdapter: any,
  signal?: AbortSignal
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const validatedArgs = sendMessageSchema.parse(args);
  const result = await messagingAdapter.sendMessage(validatedArgs, signal);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result)
    }]
  };
}

export async function handleDownloadAttachment(
  args: any,
  messagingAdapter: any,
  signal?: AbortSignal
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const validatedArgs = downloadAttachmentSchema.parse(args);
  const result = await messagingAdapter.downloadAttachment(validatedArgs, signal);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result)
    }]
  };
}

export async function handleGetMessages(
  args: any,
  messagingAdapter: any
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const validatedArgs = getMessagesSchema.parse(args);
  const result = await messagingAdapter.getMessages(validatedArgs);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result)
    }]
  };
}

export async function handleWaitForMessages(
  args: any,
  messagingAdapter: any,
  signal?: AbortSignal
): Promise<{ content: Array<{ type: string; text: string }> }> {
  // mentionsOnly is parsed here like the arguments of the other tools (a boolean, false when left out). The schema's
  // timeout is in milliseconds, so the other arguments are checked behind the adapter, after the room and the membership
  const { mentionsOnly } = waitForMessagesInputSchema.pick({ mentionsOnly: true }).parse(args);
  // Convert timeout from seconds to milliseconds; 0 (wait until a message arrives) stays 0
  const timeoutMs = args.timeout === 0 ? 0 : args.timeout ? args.timeout * 1000 : undefined;

  const result = await messagingAdapter.waitForMessages({
    agentName: args.agentName,
    roomName: args.roomName,
    timeout: timeoutMs,
    mentionsOnly
  }, signal);
  
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result)
    }]
  };
}