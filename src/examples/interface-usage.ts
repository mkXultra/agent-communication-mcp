// Agent Communication MCP Server - インターフェース使用例による検証

import type {
  Room,
  Message,
  Agent,
  AgentProfile,
  Presence,
  IStorageService,
  IRoomService,
  MCPTools,
} from '../types';

import type {
  CreateRoomInput,
  CreateRoomOutput,
} from '../schemas';

import {
  AppError,
  RoomNotFoundError,
  RoomAlreadyExistsError,
  AgentNotInRoomError,
  toMCPError,
} from '../errors';

// 基本エンティティの使用例
function createSampleRoom(): Room {
  return {
    name: 'general',
    description: 'General discussion room',
    createdAt: new Date().toISOString(),
    messageCount: 42,
    userCount: 5,
  };
}

function createSampleMessage(): Message {
  return {
    id: 'msg-123',
    roomName: 'general',
    agentName: 'alice',
    message: 'Hello @bob, how are you?',
    mentions: ['bob'],
    timestamp: new Date().toISOString(),
    metadata: {
      urgency: 'normal',
      category: 'greeting',
    },
  };
}

function createSampleAgent(): Agent {
  return {
    name: 'alice',
    profile: {
      role: 'developer',
      description: 'Senior software engineer',
      capabilities: ['TypeScript', 'React', 'Node.js'],
      metadata: {
        team: 'frontend',
        timezone: 'UTC+9',
      },
    },
  };
}

function createSamplePresence(): Presence {
  return {
    agentName: 'alice',
    status: 'online',
    joinedAt: new Date().toISOString(),
    messageCount: 15,
    profile: {
      role: 'developer',
      capabilities: ['TypeScript'],
    },
  };
}

// サービスインターフェースの使用例
class ExampleStorageService implements IStorageService {
  async readJSON<T>(path: string): Promise<T> {
    // 実装例：ファイルからJSONを読み込む
    console.log(`Reading JSON from ${path}`);
    throw new Error('Not implemented');
  }

  async writeJSON<T>(path: string, data: T): Promise<void> {
    // 実装例：JSONをファイルに書き込む
    console.log(`Writing JSON to ${path}`, data);
  }

  async appendJSONL(path: string, data: any): Promise<void> {
    // 実装例：JSONLファイルに行を追加
    console.log(`Appending to JSONL ${path}`, data);
  }

  async readJSONL<T>(path: string, options?: any): Promise<T[]> {
    // 実装例：JSONLファイルから読み込み
    console.log(`Reading JSONL from ${path}`, options);
    return [];
  }

  async withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
    // 実装例：ファイルロック付きで操作実行
    console.log(`Acquiring lock for ${path}`);
    return await operation();
  }

  async exists(path: string): Promise<boolean> {
    // 実装例：ファイル存在確認
    console.log(`Checking existence of ${path}`);
    return true;
  }

  async ensureDir(path: string): Promise<void> {
    // 実装例：ディレクトリ作成
    console.log(`Ensuring directory ${path}`);
  }
}

class ExampleRoomService implements IRoomService {
  async createRoom(roomName: string, description?: string): Promise<Room> {
    // 実装例：ルーム作成
    if (roomName === 'existing') {
      throw new RoomAlreadyExistsError(roomName);
    }
    
    return {
      name: roomName,
      description,
      createdAt: new Date().toISOString(),
      messageCount: 0,
      userCount: 0,
    };
  }

  async listRooms(agentName?: string): Promise<any> {
    // 実装例：ルーム一覧取得
    console.log(`Listing rooms for agent: ${agentName || 'all'}`);
    return {
      rooms: [createSampleRoom()],
      total: 1,
    };
  }

  async deleteRoom(roomName: string): Promise<void> {
    // 実装例：ルーム削除
    if (roomName === 'nonexistent') {
      throw new RoomNotFoundError(roomName);
    }
    console.log(`Deleting room: ${roomName}`);
  }

  async enterRoom(agentName: string, roomName: string, profile?: AgentProfile): Promise<void> {
    // 実装例：ルーム参加
    if (roomName === 'nonexistent') {
      throw new RoomNotFoundError(roomName);
    }
    console.log(`${agentName} entering room ${roomName}`, profile);
  }

  async leaveRoom(agentName: string, roomName: string): Promise<void> {
    // 実装例：ルーム退出
    if (roomName === 'nonexistent') {
      throw new RoomNotFoundError(roomName);
    }
    console.log(`${agentName} leaving room ${roomName}`);
  }

  async listRoomUsers(roomName: string): Promise<Presence[]> {
    // 実装例：ルームユーザー一覧
    if (roomName === 'nonexistent') {
      throw new RoomNotFoundError(roomName);
    }
    return [createSamplePresence()];
  }

  async updatePresence(roomName: string, agentName: string, status: 'online' | 'offline'): Promise<void> {
    // 実装例：プレゼンス更新
    console.log(`Updating presence: ${agentName} in ${roomName} -> ${status}`);
  }
}

// MCPツール型の使用例
function demonstrateMCPTypes() {
  // send_message ツールの使用例
  const sendMessageInput: MCPTools['send_message']['input'] = {
    agentName: 'alice',
    roomName: 'general',
    message: 'Hello world!',
    metadata: { priority: 'high' },
  };

  const sendMessageOutput: MCPTools['send_message']['output'] = {
    success: true,
    messageId: 'msg-456',
    roomName: 'general',
    agentName: 'alice',
    timestamp: new Date().toISOString(),
    mentions: [],
  };

  // スキーマ型の使用例
  const createRoomInput: CreateRoomInput = {
    roomName: 'new-room',
    description: 'A new room for testing',
  };

  const createRoomOutput: CreateRoomOutput = {
    success: true,
    roomName: 'new-room',
    description: 'A new room for testing',
    createdAt: new Date().toISOString(),
  };

  console.log('MCP types demonstration:', {
    sendMessageInput,
    sendMessageOutput,
    createRoomInput,
    createRoomOutput,
  });
}

// エラーハンドリングの使用例
function demonstrateErrorHandling() {
  try {
    throw new RoomNotFoundError('nonexistent-room');
  } catch (error) {
    if (error instanceof RoomNotFoundError) {
      console.log('Caught RoomNotFoundError:', error.message);
      console.log('Error code:', error.code);
      console.log('Status code:', error.statusCode);
    }
  }

  try {
    throw new AgentNotInRoomError('alice', 'private-room');
  } catch (error) {
    if (error instanceof AppError) {
      console.log('Caught AppError:', error.message);
      const mcpError = toMCPError(error);
      console.log('MCP Error Response:', mcpError);
    }
  }
}

// 全体的な使用例を実行
export function runInterfaceValidation() {
  console.log('=== Interface Usage Validation ===');
  
  console.log('1. Creating sample entities...');
  const room = createSampleRoom();
  const message = createSampleMessage();
  const agent = createSampleAgent();
  const presence = createSamplePresence();
  
  console.log('Sample entities created:', { room, message, agent, presence });
  
  console.log('2. Demonstrating service interfaces...');
  new ExampleStorageService();
  new ExampleRoomService();
  
  console.log('Service instances created');
  
  console.log('3. Demonstrating MCP types...');
  demonstrateMCPTypes();
  
  console.log('4. Demonstrating error handling...');
  demonstrateErrorHandling();
  
  console.log('=== Interface validation completed successfully ===');
}

// TypeScript型チェック用のダミー実行
if (require.main === module) {
  runInterfaceValidation();
}