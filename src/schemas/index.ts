// Agent Communication MCP Server - スキーマ統合エクスポート

// ルーム管理スキーマ
export * from './room.schema';

// メッセージングスキーマ
export * from './message.schema';

// 管理機能スキーマ
export * from './management.schema';

// 便利な再エクスポート
export {
  // ルーム関連
  createRoomInputSchema,
  createRoomOutputSchema,
  listRoomsInputSchema,
  listRoomsOutputSchema,
  enterRoomInputSchema,
  enterRoomOutputSchema,
  leaveRoomInputSchema,
  leaveRoomOutputSchema,
  listRoomUsersInputSchema,
  listRoomUsersOutputSchema,
  deleteRoomInputSchema,
  deleteRoomOutputSchema,
} from './room.schema';

export {
  // メッセージ関連
  sendMessageInputSchema,
  sendMessageOutputSchema,
  getMessagesInputSchema,
  getMessagesOutputSchema,
} from './message.schema';

export {
  // 管理機能関連
  getStatusInputSchema,
  getStatusOutputSchema,
  clearRoomMessagesInputSchema,
  clearRoomMessagesOutputSchema,
  getRoomStatisticsInputSchema,
  getRoomStatisticsOutputSchema,
  exportRoomDataInputSchema,
  exportRoomDataOutputSchema,
  backupRoomInputSchema,
  backupRoomOutputSchema,
  restoreRoomInputSchema,
  restoreRoomOutputSchema,
} from './management.schema';