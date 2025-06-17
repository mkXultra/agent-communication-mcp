// Agent Communication MCP Server - カスタムエラークラス定義
// implementation-policy.md の18-36行目に基づく実装

// 基底エラークラス
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500
  ) {
    super(message);
    this.name = this.constructor.name;
    
    // Error.captureStackTrace が存在する場合のみ実行（Node.js環境）
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

// ルーム関連のエラー
export class RoomNotFoundError extends AppError {
  constructor(roomName: string) {
    super(`Room '${roomName}' not found`, 'ROOM_NOT_FOUND', 404);
  }
}

export class RoomAlreadyExistsError extends AppError {
  constructor(roomName: string) {
    super(`Room '${roomName}' already exists`, 'ROOM_ALREADY_EXISTS', 409);
  }
}

export class RoomCapacityExceededError extends AppError {
  constructor(maxRooms: number) {
    super(`Maximum number of rooms (${maxRooms}) exceeded`, 'ROOM_CAPACITY_EXCEEDED', 429);
  }
}

// エージェント関連のエラー
export class AgentNotFoundError extends AppError {
  constructor(agentName: string) {
    super(`Agent '${agentName}' not found`, 'AGENT_NOT_FOUND', 404);
  }
}

export class AgentNotInRoomError extends AppError {
  constructor(agentName: string, roomName: string) {
    super(`Agent '${agentName}' is not in room '${roomName}'`, 'AGENT_NOT_IN_ROOM', 403);
  }
}

export class AgentAlreadyInRoomError extends AppError {
  constructor(agentName: string, roomName: string) {
    super(`Agent '${agentName}' is already in room '${roomName}'`, 'AGENT_ALREADY_IN_ROOM', 409);
  }
}

// メッセージ関連のエラー
export class MessageNotFoundError extends AppError {
  constructor(messageId: string) {
    super(`Message '${messageId}' not found`, 'MESSAGE_NOT_FOUND', 404);
  }
}

export class MessageTooLongError extends AppError {
  constructor(maxLength: number) {
    super(`Message exceeds maximum length of ${maxLength} characters`, 'MESSAGE_TOO_LONG', 400);
  }
}

export class MessageCapacityExceededError extends AppError {
  constructor(roomName: string, maxMessages: number) {
    super(`Room '${roomName}' has reached maximum message limit (${maxMessages})`, 'MESSAGE_CAPACITY_EXCEEDED', 429);
  }
}

// バリデーション関連のエラー
export class ValidationError extends AppError {
  constructor(field: string, message: string) {
    super(`Validation failed for field '${field}': ${message}`, 'VALIDATION_ERROR', 400);
  }
}

export class ConfirmationRequiredError extends AppError {
  constructor(action: string) {
    super(`Confirmation required for ${action}`, 'CONFIRMATION_REQUIRED', 400);
  }
}

export class InvalidRoomNameError extends AppError {
  constructor(roomName: string) {
    super(`Invalid room name '${roomName}'. Must contain only alphanumeric characters, hyphens, and underscores`, 'INVALID_ROOM_NAME', 400);
  }
}

export class InvalidAgentNameError extends AppError {
  constructor(agentName: string) {
    super(`Invalid agent name '${agentName}'. Must be non-empty and not exceed 50 characters`, 'INVALID_AGENT_NAME', 400);
  }
}

export class InvalidMessageFormatError extends AppError {
  constructor(details?: string) {
    const message = details 
      ? `Invalid message format: ${details}`
      : 'Invalid message format';
    super(message, 'INVALID_MESSAGE_FORMAT', 400);
  }
}

// ストレージ関連のエラー
export class StorageError extends AppError {
  constructor(operation: string, details?: string) {
    const message = details 
      ? `Storage operation '${operation}' failed: ${details}`
      : `Storage operation '${operation}' failed`;
    super(message, 'STORAGE_ERROR', 500);
  }
}

export class FileLockTimeoutError extends AppError {
  constructor(path: string, timeout: number) {
    super(`Failed to acquire lock for '${path}' within ${timeout}ms`, 'FILE_LOCK_TIMEOUT', 408);
  }
}

export class FileNotFoundError extends AppError {
  constructor(path: string) {
    super(`File not found: ${path}`, 'FILE_NOT_FOUND', 404);
  }
}

// MCP関連のエラー
export class MCPError extends AppError {
  constructor(toolName: string, message: string) {
    super(`MCP tool '${toolName}' error: ${message}`, 'MCP_ERROR', 500);
  }
}

export class MCPToolNotFoundError extends AppError {
  constructor(toolName: string) {
    super(`MCP tool '${toolName}' not found`, 'MCP_TOOL_NOT_FOUND', 404);
  }
}

// MCPプロトコルへの変換ユーティリティ
export interface MCPErrorResponse {
  code: number;
  message: string;
  data?: {
    errorCode: string;
    details?: any;
  };
}

export function toMCPError(error: Error): MCPErrorResponse {
  if (error instanceof AppError) {
    return {
      code: error.statusCode,
      message: error.message,
      data: {
        errorCode: error.code,
      },
    };
  }
  
  // 予期しないエラーの場合
  return {
    code: 500,
    message: 'Internal server error',
    data: {
      errorCode: 'INTERNAL_ERROR',
      details: error.message,
    },
  };
}

// エラーコード定数
export const ERROR_CODES = {
  // ルーム関連
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_ALREADY_EXISTS: 'ROOM_ALREADY_EXISTS',
  ROOM_CAPACITY_EXCEEDED: 'ROOM_CAPACITY_EXCEEDED',
  
  // エージェント関連
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  AGENT_NOT_IN_ROOM: 'AGENT_NOT_IN_ROOM',
  AGENT_ALREADY_IN_ROOM: 'AGENT_ALREADY_IN_ROOM',
  
  // メッセージ関連
  MESSAGE_NOT_FOUND: 'MESSAGE_NOT_FOUND',
  MESSAGE_TOO_LONG: 'MESSAGE_TOO_LONG',
  MESSAGE_CAPACITY_EXCEEDED: 'MESSAGE_CAPACITY_EXCEEDED',
  
  // バリデーション関連
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
  INVALID_ROOM_NAME: 'INVALID_ROOM_NAME',
  INVALID_AGENT_NAME: 'INVALID_AGENT_NAME',
  INVALID_MESSAGE_FORMAT: 'INVALID_MESSAGE_FORMAT',
  
  // ストレージ関連
  STORAGE_ERROR: 'STORAGE_ERROR',
  FILE_LOCK_TIMEOUT: 'FILE_LOCK_TIMEOUT',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  
  // MCP関連
  MCP_ERROR: 'MCP_ERROR',
  MCP_TOOL_NOT_FOUND: 'MCP_TOOL_NOT_FOUND',
  
  // その他
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];