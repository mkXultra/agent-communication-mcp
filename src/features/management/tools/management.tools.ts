import { CallToolRequest, CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { ManagementService } from '../ManagementService';
import { getStatusInputSchema as getStatusSchema, clearRoomMessagesInputSchema as clearRoomMessagesSchema } from '../../../schemas/management.schema';
import { toMCPError } from '../../../errors/AppError';
import { ZodError } from 'zod';

const managementService = new ManagementService();

// get_status tool implementation
const getStatusTool: Tool = {
  name: 'agent_communication/get_status',
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

// clear_room_messages tool implementation
const clearRoomMessagesTool: Tool = {
  name: 'agent_communication/clear_room_messages',
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

// Tool handlers
export async function handleGetStatus(request: CallToolRequest): Promise<CallToolResult> {
  try {
    // Validate input parameters
    const params = getStatusSchema.parse(request.params || {});
    
    // Get system status (with optional room filter)
    const result = await managementService.getStatus(params.roomName);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'Invalid parameters',
              details: error.errors
            }, null, 2)
          }
        ],
        isError: true
      };
    }
    
    const mcpError = toMCPError(error instanceof Error ? error : new Error('Unknown error'));
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(mcpError, null, 2)
        }
      ],
      isError: true
    };
  }
}

export async function handleClearRoomMessages(request: CallToolRequest): Promise<CallToolResult> {
  try {
    // Validate input parameters
    const params = clearRoomMessagesSchema.parse(request.params || {});
    
    // Clear room messages
    const result = await managementService.clearRoomMessages(params.roomName, params.confirm);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'Invalid parameters',
              details: error.errors
            }, null, 2)
          }
        ],
        isError: true
      };
    }
    
    const mcpError = toMCPError(error instanceof Error ? error : new Error('Unknown error'));
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(mcpError, null, 2)
        }
      ],
      isError: true
    };
  }
}

// Export management tools array
export const managementTools: Tool[] = [
  getStatusTool,
  clearRoomMessagesTool
];

// Export tool handlers map
export const managementToolHandlers = {
  'agent_communication/get_status': handleGetStatus,
  'agent_communication/clear_room_messages': handleClearRoomMessages
};