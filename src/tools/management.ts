import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { getStatusSchema, clearRoomMessagesSchema } from '../schemas/index.js';

export const getStatusTool: Tool = {
  name: 'agent_communication_get_status',
  description: 'Get system status or specific room status with statistics including online users, message counts, and storage usage',
  inputSchema: {
    type: 'object',
    properties: {
      roomName: {
        type: 'string',
        description: 'Optional room name to get specific room status. If omitted, returns system-wide status for all rooms',
        pattern: '^[a-zA-Z0-9-_]+$'
      }
    },
    additionalProperties: false
  }
};

export const clearRoomMessagesTool: Tool = {
  name: 'agent_communication_clear_room_messages',
  description: 'Clear all messages in a specified room. Requires explicit confirmation to prevent accidental data loss',
  inputSchema: {
    type: 'object',
    properties: {
      roomName: {
        type: 'string',
        description: 'Name of the room to clear messages from',
        pattern: '^[a-zA-Z0-9-_]+$'
      },
      confirm: {
        type: 'boolean',
        description: 'Must be set to true to confirm the message clearing operation'
      }
    },
    required: ['roomName', 'confirm'],
    additionalProperties: false
  }
};

export async function handleGetStatus(
  args: any,
  managementAdapter: any
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const validatedArgs = getStatusSchema.parse(args);
  const result = await managementAdapter.getStatus(validatedArgs);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result, null, 2)
    }]
  };
}

export async function handleClearRoomMessages(
  args: any,
  managementAdapter: any
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const validatedArgs = clearRoomMessagesSchema.parse(args);
  const result = await managementAdapter.clearRoomMessages(validatedArgs);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result, null, 2)
    }]
  };
}