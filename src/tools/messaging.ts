import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { sendMessageSchema, getMessagesSchema } from '../schemas/index.js';

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
        maximum: 100
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

export async function handleSendMessage(
  args: any,
  messagingAdapter: any
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const validatedArgs = sendMessageSchema.parse(args);
  const result = await messagingAdapter.sendMessage(validatedArgs);
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