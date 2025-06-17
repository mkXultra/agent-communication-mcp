// Agent Communication MCP Server - 型定義統合エクスポート

// 基本エンティティ型
export * from './entities';

// サービスインターフェース
export * from './services';

// MCPツール型定義
export * from './mcp';

// 型定義の再エクスポート（便利な別名）
export type {
  Room,
  Message,
  Agent,
  AgentProfile,
  Presence,
  PresenceStatus,
} from './entities';

export type {
  IStorageService,
  IRoomService,
  IMessageService,
  IManagementService,
  IServiceContainer,
  ServiceConfig,
} from './services';

export type {
  MCPTools,
  MCPToolName,
  MCPTool,
  MCPToolHandler,
  MCPToolDefinition,
  MCPServerConfig,
  MCPResponse,
  MCPErrorResponse,
  MCPSuccessResponse,
  MCPToolContext,
} from './mcp';