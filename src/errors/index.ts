// Agent Communication MCP Server - エラー統合エクスポート

export * from './AppError';

// 便利な再エクスポート
export {
  AppError,
  RoomNotFoundError,
  RoomAlreadyExistsError,
  RoomCapacityExceededError,
  AgentNotFoundError,
  AgentNotInRoomError,
  AgentAlreadyInRoomError,
  MessageNotFoundError,
  MessageTooLongError,
  MessageCapacityExceededError,
  ValidationError,
  InvalidRoomNameError,
  InvalidAgentNameError,
  InvalidMessageFormatError,
  StorageError,
  FileLockTimeoutError,
  FileNotFoundError,
  MCPError,
  MCPToolNotFoundError,
  toMCPError,
  ERROR_CODES,
} from './AppError';

export type {
  MCPErrorResponse,
  ErrorCode,
} from './AppError';