// Agent Communication MCP Server - Presence Management MCP Tools
// エージェントB担当：プレゼンス管理MCPツール実装

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { PresenceService } from '../presence/PresenceService';
import { enterRoomInputSchema, leaveRoomInputSchema, listRoomUsersInputSchema } from '../../../schemas/room.schema';
import { toMCPError } from '../../../errors';

const presenceService = new PresenceService();

export const enterRoomTool: Tool = {
  name: 'agent_communication/enter_room',
  description: 'Enter a room and set presence status to online',
  inputSchema: {
    type: 'object',
    properties: {
      agentName: {
        type: 'string',
        description: 'Name of the agent entering the room',
        minLength: 1,
        maxLength: 50
      },
      roomName: {
        type: 'string',
        description: 'Name of the room to enter',
        pattern: '^[a-zA-Z0-9-_]+$',
        minLength: 1,
        maxLength: 50
      },
      profile: {
        type: 'object',
        description: 'Optional agent profile information',
        properties: {
          role: {
            type: 'string',
            description: 'Role of the agent (e.g., "coordinator", "analyzer")',
            maxLength: 50
          },
          description: {
            type: 'string',
            description: 'Description of the agent',
            maxLength: 200
          },
          capabilities: {
            type: 'array',
            description: 'List of agent capabilities',
            items: {
              type: 'string',
              maxLength: 50
            },
            maxItems: 20
          },
          metadata: {
            type: 'object',
            description: 'Additional metadata'
          }
        }
      }
    },
    required: ['agentName', 'roomName']
  }
};

export const leaveRoomTool: Tool = {
  name: 'agent_communication/leave_room',
  description: 'Leave a room and set presence status to offline',
  inputSchema: {
    type: 'object',
    properties: {
      agentName: {
        type: 'string',
        description: 'Name of the agent leaving the room',
        minLength: 1,
        maxLength: 50
      },
      roomName: {
        type: 'string',
        description: 'Name of the room to leave',
        pattern: '^[a-zA-Z0-9-_]+$',
        minLength: 1,
        maxLength: 50
      }
    },
    required: ['agentName', 'roomName']
  }
};

export const listRoomUsersTool: Tool = {
  name: 'agent_communication/list_room_users',
  description: 'List all users in a room with their status and profile information',
  inputSchema: {
    type: 'object',
    properties: {
      roomName: {
        type: 'string',
        description: 'Name of the room to list users from',
        pattern: '^[a-zA-Z0-9-_]+$',
        minLength: 1,
        maxLength: 50
      }
    },
    required: ['roomName']
  }
};

// ツール実行ハンドラー
export async function handleEnterRoom(args: any): Promise<any> {
  try {
    // 入力バリデーション
    const validatedInput = enterRoomInputSchema.parse(args);
    
    // サービス実行
    const result = await presenceService.enterRoom(
      validatedInput.agentName,
      validatedInput.roomName,
      validatedInput.profile
    );
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  } catch (error: any) {
    if (error.name && error.code) {
      // カスタムエラーの場合
      throw toMCPError(error);
    }
    
    // その他のエラー
    throw {
      code: -32603,
      message: `Internal error: ${error.message}`,
      data: { errorType: error.constructor.name }
    };
  }
}

export async function handleLeaveRoom(args: any): Promise<any> {
  try {
    // 入力バリデーション
    const validatedInput = leaveRoomInputSchema.parse(args);
    
    // サービス実行
    const result = await presenceService.leaveRoom(
      validatedInput.agentName,
      validatedInput.roomName
    );
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  } catch (error: any) {
    if (error.name && error.code) {
      // カスタムエラーの場合
      throw toMCPError(error);
    }
    
    // その他のエラー
    throw {
      code: -32603,
      message: `Internal error: ${error.message}`,
      data: { errorType: error.constructor.name }
    };
  }
}

export async function handleListRoomUsers(args: any): Promise<any> {
  try {
    // 入力バリデーション
    const validatedInput = listRoomUsersInputSchema.parse(args);
    
    // サービス実行
    const result = await presenceService.listRoomUsers(validatedInput.roomName);
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  } catch (error: any) {
    if (error.name && error.code) {
      // カスタムエラーの場合
      throw toMCPError(error);
    }
    
    // その他のエラー
    throw {
      code: -32603,
      message: `Internal error: ${error.message}`,
      data: { errorType: error.constructor.name }
    };
  }
}

// ツールとハンドラーのマッピング
export const presenceTools = {
  tools: [enterRoomTool, leaveRoomTool, listRoomUsersTool],
  handlers: {
    'agent_communication/enter_room': handleEnterRoom,
    'agent_communication/leave_room': handleLeaveRoom,
    'agent_communication/list_room_users': handleListRoomUsers
  }
};