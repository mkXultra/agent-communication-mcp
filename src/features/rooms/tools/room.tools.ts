// Agent Communication MCP Server - Room Management MCP Tools
// エージェントB担当：ルーム管理MCPツール実装

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { RoomService } from '../room/RoomService';
import { createRoomInputSchema, listRoomsInputSchema } from '../../../schemas/room.schema';
import { toMCPError } from '../../../errors';

const roomService = new RoomService();

export const createRoomTool: Tool = {
  name: 'agent_communication/create_room',
  description: 'Create a new room for agent communication',
  inputSchema: {
    type: 'object',
    properties: {
      roomName: {
        type: 'string',
        description: 'Name of the room to create (alphanumeric, hyphens, underscores only)',
        pattern: '^[a-zA-Z0-9-_]+$',
        minLength: 1,
        maxLength: 50
      },
      description: {
        type: 'string',
        description: 'Optional description of the room',
        maxLength: 200
      }
    },
    required: ['roomName']
  }
};

export const listRoomsTool: Tool = {
  name: 'agent_communication/list_rooms',
  description: 'List all available rooms with their information',
  inputSchema: {
    type: 'object',
    properties: {
      agentName: {
        type: 'string',
        description: 'Optional agent name to filter rooms (shows only joined rooms)',
        minLength: 1,
        maxLength: 50
      }
    },
    required: []
  }
};

// ツール実行ハンドラー
export async function handleCreateRoom(args: any): Promise<any> {
  try {
    // 入力バリデーション
    const validatedInput = createRoomInputSchema.parse(args);
    
    // サービス実行
    const result = await roomService.createRoom(
      validatedInput.roomName,
      validatedInput.description
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

export async function handleListRooms(args: any): Promise<any> {
  try {
    // 入力バリデーション
    const validatedInput = listRoomsInputSchema.parse(args);
    
    // サービス実行
    const result = await roomService.listRooms(validatedInput.agentName);
    
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
export const roomTools = {
  tools: [createRoomTool, listRoomsTool],
  handlers: {
    'agent_communication/create_room': handleCreateRoom,
    'agent_communication/list_rooms': handleListRooms
  }
};