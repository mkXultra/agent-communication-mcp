# エージェントB: ルーム・プレゼンス機能実装タスク

## 背景
spec.md（行29-108）に記載されたAgent Communication MCP Serverのルーム管理とプレゼンス機能を完全実装する。

## タスク
以下のドキュメントを**全セクション**読んで実装してください：
1. 仕様書（/home/miyagi/dev/personal_pj/agent-communication-mcp/spec.md）の行29-108
2. 実装方針（/home/miyagi/dev/personal_pj/agent-communication-mcp/implementation-policy.md）
3. 並列実装計画書（/home/miyagi/dev/personal_pj/agent-communication-mcp/parallel-implementation-plan.md）の行118-180

## 実装項目（優先順位順）

【最高優先度】ルーム管理基本機能
1. RoomService.createRoom()
   - spec.md行46-56の仕様を**完全に**実装
   - パラメータ: roomName（英数字、ハイフン、アンダースコア）, description（オプション）
   - 戻り値: success, roomName, message
   - rooms.jsonへの保存

2. RoomService.listRooms()
   - spec.md行31-44の仕様を**完全に**実装
   - パラメータ: agentName（オプション、フィルタ用）
   - 戻り値: rooms配列（name, description, userCount, messageCount, isJoined）
   - isJoinedはagentName指定時のみ

3. rooms.jsonデータ構造
   ```json
   {
     "rooms": {
       "general": {
         "description": "General discussion",
         "createdAt": "2024-01-20T09:00:00Z",
         "messageCount": 0,
         "userCount": 0
       }
     }
   }
   ```

【高優先度】プレゼンス管理機能
4. PresenceService.enterRoom()
   - spec.md行58-74の仕様を**完全に**実装
   - パラメータ: agentName, roomName, profile（オプション）
   - プロフィール: role, description, capabilities[], metadata
   - presence.jsonへの保存

5. PresenceService.leaveRoom()
   - spec.md行76-86の仕様を**完全に**実装
   - パラメータ: agentName, roomName
   - オフラインステータスへの更新

6. PresenceService.listRoomUsers()
   - spec.md行88-107の仕様を**完全に**実装
   - 戻り値: roomName, users配列, onlineCount
   - users配列: name, status, messageCount, profile

7. presence.jsonデータ構造
   ```json
   {
     "roomName": "general",
     "users": {
       "agent1": {
         "status": "online",
         "messageCount": 0,
         "joinedAt": "2024-01-20T10:00:00Z",
         "profile": {
           "role": "coordinator",
           "description": "Task coordination",
           "capabilities": ["task_planning"],
           "metadata": {}
         }
       }
     }
   }
   ```

【中優先度】追加機能
8. ルーム削除機能
   - ルームディレクトリの削除
   - rooms.jsonからの削除

9. オフラインユーザーのクリーンアップ
   - 24時間以上オフラインのユーザーを自動削除

## バリデーション（Zodスキーマ）

```typescript
// src/schemas/room.schema.ts
createRoomSchema = z.object({
  roomName: z.string().regex(/^[a-zA-Z0-9-_]+$/),
  description: z.string().max(200).optional()
});

enterRoomSchema = z.object({
  agentName: z.string().min(1).max(50),
  roomName: z.string().regex(/^[a-zA-Z0-9-_]+$/),
  profile: z.object({
    role: z.string().optional(),
    description: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    metadata: z.record(z.any()).optional()
  }).optional()
});
```

## エラーハンドリング

```typescript
// ルーム作成時
throw new RoomAlreadyExistsError(roomName);

// 入室時
throw new RoomNotFoundError(roomName);
throw new AgentAlreadyInRoomError(agentName, roomName);

// 退室時
throw new AgentNotInRoomError(agentName, roomName);
```

## MCPツール実装

1. **room.tools.ts**
   - list_rooms
   - create_room

2. **presence.tools.ts**
   - enter_room
   - leave_room
   - list_room_users

## テスト要件

1. **単体テスト**（tests/rooms/unit/）
   - RoomService.test.ts
   - PresenceService.test.ts
   - カバレッジ90%以上必須

2. **統合テスト**（tests/rooms/integration/）
   - room-lifecycle.test.ts（作成→入室→退室→削除）

3. **負荷テスト**（tests/rooms/load/）
   - multi-room.test.ts（100ルーム×50ユーザー）

## 公開API（src/features/rooms/index.ts）

```typescript
export interface IRoomsAPI {
  // ルーム管理
  createRoom(name: string, description?: string): Promise<Room>;
  roomExists(name: string): Promise<boolean>;
  listRooms(agentName?: string): Promise<RoomListResponse>;
  
  // プレゼンス管理
  enterRoom(agentName: string, roomName: string, profile?: AgentProfile): Promise<void>;
  leaveRoom(agentName: string, roomName: string): Promise<void>;
  getRoomUsers(roomName: string): Promise<RoomUsersResponse>;
}

export class RoomsAPI implements IRoomsAPI {
  // 実装
}

// MCPツール定義もエクスポート
export { roomTools } from './tools/room.tools';
export { presenceTools } from './tools/presence.tools';
```

## 完了条件
- [ ] spec.md行29-108の**すべて**の仕様を満たしている
- [ ] implementation-policy.mdのエラーハンドリング方針に準拠
- [ ] rooms.jsonとpresence.jsonのデータ構造が仕様通り
- [ ] 単体テストカバレッジ90%以上
- [ ] 負荷テスト（100ルーム×50ユーザー）合格
- [ ] src/features/rooms/README.mdにAPIドキュメント作成

## 注意事項
- メッセージ数カウントは一旦0固定（統合時に連携）
- ファイルロックは実装不要（エージェントDが統合時に追加）
- 他エージェントの機能に依存しないこと