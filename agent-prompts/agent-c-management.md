# エージェントC: 管理機能実装タスク

## 背景
spec.md（行151-180）に記載されたAgent Communication MCP Serverの管理機能を完全実装する。

## タスク
以下のドキュメントを**全セクション**読んで実装してください：
1. 仕様書（/home/miyagi/dev/personal_pj/agent-communication-mcp/spec.md）の行151-180
2. 実装方針（/home/miyagi/dev/personal_pj/agent-communication-mcp/implementation-policy.md）
3. 並列実装計画書（/home/miyagi/dev/personal_pj/agent-communication-mcp/parallel-implementation-plan.md）の行183-235

## 実装項目（優先順位順）

【最高優先度】ステータス取得機能
1. ManagementService.getStatus()
   - spec.md行152-167の仕様を**完全に**実装
   - パラメータ: roomName（オプション、特定ルームのみ）
   - 戻り値構造:
     ```typescript
     {
       rooms: [{
         name: string,
         onlineUsers: number,
         totalMessages: number,
         storageSize: number  // バイト単位
       }],
       totalRooms: number,
       totalOnlineUsers: number,
       totalMessages: number
     }
     ```

2. ディレクトリスキャン実装
   - data/rooms/配下を再帰的にスキャン
   - rooms.jsonから全ルーム情報取得
   - 各ルームのpresence.jsonからオンラインユーザー数計算
   - messages.jsonlのファイルサイズと行数カウント

【高優先度】メッセージクリア機能
3. ManagementService.clearRoomMessages()
   - spec.md行169-179の仕様を**完全に**実装
   - パラメータ: roomName, confirm（必須、安全確認）
   - messages.jsonlファイルの削除
   - rooms.jsonのmessageCountを0にリセット
   - 戻り値: success, roomName, clearedCount

4. 統計情報収集
   - getRoomStatistics()内部メソッド
   - ルーム別の詳細統計
   - メッセージ数、ユーザー数、ファイルサイズ

【中優先度】追加機能
5. データエクスポート機能
   - 特定ルームのデータをJSON形式でエクスポート
   - メッセージ履歴、ユーザー情報を含む

6. システムメトリクス
   - 総ストレージ使用量
   - 最もアクティブなルームの特定

## バリデーション（Zodスキーマ）

```typescript
// src/schemas/management.schema.ts
getStatusSchema = z.object({
  roomName: z.string().regex(/^[a-zA-Z0-9-_]+$/).optional()
});

clearRoomMessagesSchema = z.object({
  roomName: z.string().regex(/^[a-zA-Z0-9-_]+$/),
  confirm: z.boolean()
});
```

## エラーハンドリング

```typescript
// ステータス取得時
throw new RoomNotFoundError(roomName); // 特定ルーム指定時
throw new StorageError('Failed to read room data', 'STORAGE_ERROR');

// メッセージクリア時
throw new RoomNotFoundError(roomName);
throw new ValidationError('Confirmation required', 'CONFIRMATION_REQUIRED');
```

## ファイルスキャン実装詳細

```typescript
// DataScanner.ts
class DataScanner {
  async scanRoomDirectory(roomName: string): Promise<RoomScanResult> {
    const messagesPath = `data/rooms/${roomName}/messages.jsonl`;
    const presencePath = `data/rooms/${roomName}/presence.json`;
    
    // ファイルサイズ取得
    const messageStats = await this.getFileStats(messagesPath);
    
    // メッセージ数カウント（行数）
    const messageCount = await this.countLines(messagesPath);
    
    // オンラインユーザー数
    const onlineUsers = await this.countOnlineUsers(presencePath);
    
    return { messageCount, onlineUsers, storageSize: messageStats.size };
  }
}
```

## MCPツール実装

```typescript
// src/tools/management.tools.ts
export const managementTools = [
  {
    name: 'agent_communication/get_status',
    description: 'Get system or room status',
    inputSchema: getStatusSchema,
    handler: async (params) => { /* 実装 */ }
  },
  {
    name: 'agent_communication/clear_room_messages',
    description: 'Clear all messages in a room',
    inputSchema: clearRoomMessagesSchema,
    handler: async (params) => { /* 実装 */ }
  }
];
```

## テスト要件

1. **単体テスト**（tests/management/unit/）
   - ManagementService.test.ts
   - StatsCollector.test.ts
   - DataScanner.test.ts
   - カバレッジ90%以上必須

2. **統合テスト**（tests/management/integration/）
   - stats-accuracy.test.ts（統計情報の正確性検証）

## 公開API（src/features/management/index.ts）

```typescript
export interface IManagementAPI {
  getSystemStatus(): Promise<SystemStatus>;
  getRoomStatistics(roomName: string): Promise<RoomStats>;
  clearRoomMessages(roomName: string, confirm: boolean): Promise<ClearResult>;
}

export class ManagementAPI implements IManagementAPI {
  // 実装
}

// MCPツール定義もエクスポート
export { managementTools } from './tools/management.tools';
```

## 完了条件
- [ ] spec.md行151-180の**すべて**の仕様を満たしている
- [ ] implementation-policy.mdのエラーハンドリング方針に準拠
- [ ] ディレクトリスキャンが正確に動作
- [ ] clearRoomMessagesがconfirm=trueの時のみ実行される
- [ ] 単体テストカバレッジ90%以上
- [ ] 統計情報の正確性が検証されている
- [ ] src/features/management/README.mdにAPIドキュメント作成

## 注意事項
- ファイル操作は直接実装（ロック不要）
- 存在しないファイルは0として扱う
- 大量ファイルでもメモリ効率的に処理すること