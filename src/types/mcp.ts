// Agent Communication MCP Server - MCPツール入出力の型定義
// 設計計画書の136-151行目参照

// ルーム管理ツールの型定義（room.schema.tsから再エクスポートしやすくするため）
export interface MCPRoomTools {
  create_room: {
    input: {
      roomName: string;
      description?: string;
    };
    output: {
      success: boolean;
      roomName: string;
      description?: string;
      createdAt: string;
    };
  };
  
  list_rooms: {
    input: {
      agentName?: string;
    };
    output: {
      rooms: Array<{
        name: string;
        description?: string;
        createdAt: string;
        messageCount: number;
        userCount: number;
      }>;
      total: number;
    };
  };
  
  enter_room: {
    input: {
      agentName: string;
      roomName: string;
      profile?: {
        role?: string;
        description?: string;
        capabilities?: string[];
        metadata?: Record<string, any>;
      };
    };
    output: {
      success: boolean;
      agentName: string;
      roomName: string;
      joinedAt: string;
    };
  };
  
  leave_room: {
    input: {
      agentName: string;
      roomName: string;
    };
    output: {
      success: boolean;
      agentName: string;
      roomName: string;
      leftAt: string;
    };
  };
  
  list_room_users: {
    input: {
      roomName: string;
    };
    output: {
      roomName: string;
      users: Array<{
        agentName: string;
        status: 'online' | 'offline';
        joinedAt: string;
        messageCount: number;
        profile?: {
          role?: string;
          description?: string;
          capabilities?: string[];
          metadata?: Record<string, any>;
        };
      }>;
      total: number;
    };
  };
  
  delete_room: {
    input: {
      roomName: string;
    };
    output: {
      success: boolean;
      roomName: string;
      deletedAt: string;
    };
  };
}

// メッセージングツールの型定義
export interface MCPMessageTools {
  send_message: {
    input: {
      agentName: string;
      roomName: string;
      message: string;
      metadata?: Record<string, any>;
    };
    output: {
      success: boolean;
      messageId: string;
      roomName: string;
      agentName: string;
      timestamp: string;
      mentions: string[];
    };
  };
  
  get_messages: {
    input: {
      roomName: string;
      agentName?: string;
      limit?: number;
      cursor?: string;
      since?: string;
      includeMetadata?: boolean;
    };
    output: {
      messages: Array<{
        id: string;
        roomName: string;
        agentName: string;
        message: string;
        mentions: string[];
        timestamp: string;
        metadata?: Record<string, any>;
      }>;
      total: number;
      hasMore: boolean;
      cursor?: string;
    };
  };
  
  delete_message: {
    input: {
      roomName: string;
      messageId: string;
    };
    output: {
      success: boolean;
      messageId: string;
      roomName: string;
      deletedAt: string;
    };
  };
  
  get_message_mentions: {
    input: {
      roomName: string;
      agentName: string;
      limit?: number;
      cursor?: string;
      since?: string;
    };
    output: {
      mentions: Array<{
        id: string;
        roomName: string;
        agentName: string;
        message: string;
        mentions: string[];
        timestamp: string;
        mentionedAgent: string;
        metadata?: Record<string, any>;
      }>;
      total: number;
      hasMore: boolean;
      cursor?: string;
    };
  };
}

// 管理ツールの型定義
export interface MCPManagementTools {
  get_status: {
    input: {
      roomName?: string;
    };
    output: {
      totalRooms: number;
      totalMessages: number;
      totalAgents: number;
      activeRooms: string[];
      onlineAgents: number;
      roomDetails?: Array<{
        name: string;
        messageCount: number;
        userCount: number;
        lastActivityAt?: string;
      }>;
    };
  };
  
  clear_room_messages: {
    input: {
      roomName: string;
      olderThan?: string;
      dryRun?: boolean;
    };
    output: {
      success: boolean;
      roomName: string;
      deletedCount: number;
      remainingCount: number;
      clearedAt: string;
      dryRun: boolean;
    };
  };
  
  get_room_statistics: {
    input: {
      roomName: string;
      includeHistory?: boolean;
      timeRange?: {
        from: string;
        to: string;
      };
    };
    output: {
      roomName: string;
      totalMessages: number;
      uniqueAgents: number;
      messagesByAgent: Record<string, number>;
      firstMessageAt?: string;
      lastMessageAt?: string;
      averageMessagesPerDay?: number;
      mostActiveAgent?: string;
      peakActivity?: {
        date: string;
        messageCount: number;
      };
      timeRange?: {
        from: string;
        to: string;
      };
    };
  };
}

// 全MCPツールの統合型
export interface MCPTools extends MCPRoomTools, MCPMessageTools, MCPManagementTools {}

// MCPツール名の型定義
export type MCPToolName = keyof MCPTools;

// 汎用MCPツール型定義
export interface MCPTool<TInput = any, TOutput = any> {
  input: TInput;
  output: TOutput;
}

// MCPエラーレスポンス型
export interface MCPErrorResponse {
  code: number;
  message: string;
  data?: {
    errorCode: string;
    details?: any;
  };
}

// MCP成功レスポンス型
export interface MCPSuccessResponse<T = any> {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: false;
  _meta?: {
    result: T;
  };
}

// MCPレスポンス統合型
export type MCPResponse<T = any> = MCPSuccessResponse<T> | MCPErrorResponse;

// MCPツール実行コンテキスト
export interface MCPToolContext {
  toolName: string;
  requestId?: string;
  timestamp: string;
  metadata?: Record<string, any>;
}

// MCPツールハンドラー関数型
export type MCPToolHandler<TInput = any, TOutput = any> = (
  input: TInput,
  context?: MCPToolContext
) => Promise<TOutput>;

// MCPツール定義
export interface MCPToolDefinition<TInput = any, TOutput = any> {
  name: string;
  description: string;
  inputSchema: any; // Zod schema
  handler: MCPToolHandler<TInput, TOutput>;
}

// MCPサーバー設定
export interface MCPServerConfig {
  name: string;
  version: string;
  tools: MCPToolDefinition[];
  enableLogging?: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}