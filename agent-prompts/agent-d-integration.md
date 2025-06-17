# エージェントD: 統合・インフラ実装タスク

## 背景
他の3つのエージェントが実装した機能を統合し、完全に動作するMCP Serverを構築する。spec.mdの全体仕様に準拠したサーバーを実現する。

## 前提条件
- エージェントA、B、Cが各機能の実装を完了していること
- src/features/messaging/、src/features/rooms/、src/features/management/が存在すること
- 各機能の公開API（IMessagingAPI、IRoomsAPI、IManagementAPI）が利用可能であること

## タスク
以下のドキュメントを**全セクション**読んで実装してください：
1. 仕様書（/home/miyagi/dev/personal_pj/agent-communication-mcp/spec.md）**全行**
2. 実装方針（/home/miyagi/dev/personal_pj/agent-communication-mcp/implementation-policy.md）
3. 並列実装計画書（/home/miyagi/dev/personal_pj/agent-communication-mcp/parallel-implementation-plan.md）の行238-341

## 実装項目（優先順位順）

【最高優先度】MCPサーバー基盤
1. MCPサーバー実装（src/index.ts）
   ```typescript
   import { Server } from '@modelcontextprotocol/sdk/server/index.js';
   import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
   
   const server = new Server({
     name: 'agent-communication',
     version: '1.0.0'
   });
   
   // ツール登録
   await toolRegistry.registerAll(server);
   
   // エラーハンドラー
   server.setRequestHandler(/* ... */);
   
   // 起動
   const transport = new StdioServerTransport();
   await server.connect(transport);
   ```

2. ツール登録システム（src/server/ToolRegistry.ts）
   - 動的インポートによる各機能の読み込み
   - 全9ツールの登録（spec.md記載の全ツール）
   - エラーハンドリングの統一

3. ファイルロック統合（src/services/LockService.ts）
   - proper-lockfileを使用
   - 全ファイル操作をロックで保護
   - タイムアウト処理（5秒）

【高優先度】アダプター実装
4. MessagingAdapter（src/adapters/MessagingAdapter.ts）
   ```typescript
   export class MessagingAdapter {
     private api?: IMessagingAPI;
     
     async initialize() {
       const { MessagingAPI } = await import('../features/messaging/index.js');
       this.api = new MessagingAPI();
     }
     
     async handleSendMessage(params: any) {
       // ルーム存在確認を実装に置き換え
       const roomExists = await this.roomsAdapter.roomExists(params.roomName);
       if (!roomExists) {
         throw new RoomNotFoundError(params.roomName);
       }
       
       // ロック処理を追加
       return await this.lockService.withLock(
         `rooms/${params.roomName}/messages.jsonl`,
         async () => this.api!.sendMessage(params)
       );
     }
   }
   ```

5. RoomsAdapter（src/adapters/RoomsAdapter.ts）
   - エージェントBの機能を統合
   - メッセージ数の実カウント連携

6. ManagementAdapter（src/adapters/ManagementAdapter.ts）
   - エージェントCの機能を統合
   - 全機能の統計情報集約

【中優先度】テストとドキュメント
7. 統合テストスイート（tests/integration/）
    - setup.ts: テスト環境初期化
    - full-flow.test.ts: 全機能の連携テスト
    - concurrent-access.test.ts: 並行アクセステスト

8. E2Eテスト（tests/e2e/）
    - MCPクライアントからの実使用シナリオ
    - 全9ツールの動作確認

9. CI/CD設定（.github/workflows/）
    - test.yml: 自動テスト実行
    - 各機能の独立テストも含む

## エラーハンドリング統合

```typescript
// src/server/ErrorHandler.ts
export class ErrorHandler {
  static toMCPError(error: unknown) {
    if (error instanceof AppError) {
      return {
        code: error.statusCode,
        message: error.message,
        data: { errorCode: error.code }
      };
    }
    // デフォルトエラー処理
    return {
      code: 500,
      message: 'Internal server error',
      data: { errorCode: 'INTERNAL_ERROR' }
    };
  }
}
```

## ロギング統合

```typescript
// src/utils/logger.ts
import winston from 'winston';

export const logger = winston.createLogger({
  format: winston.format.json(),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});
```

## 統合チェックリスト

### 機能統合前の確認
- [ ] src/features/messaging/が存在しIMessagingAPIを公開
- [ ] src/features/rooms/が存在しIRoomsAPIを公開
- [ ] src/features/management/が存在しIManagementAPIを公開

### spec.md準拠確認
- [ ] 全9つのMCPツールが実装されている
  - [ ] list_rooms（spec.md行31-44）
  - [ ] create_room（spec.md行46-56）
  - [ ] enter_room（spec.md行58-74）
  - [ ] leave_room（spec.md行76-86）
  - [ ] list_room_users（spec.md行88-107）
  - [ ] send_message（spec.md行112-125）
  - [ ] get_messages（spec.md行128-148）
  - [ ] get_status（spec.md行152-167）
  - [ ] clear_room_messages（spec.md行169-179）
- [ ] データフォーマットが正確（spec.md行183-229）
- [ ] エラーコードが全て実装（spec.md行267-274）

### 統合テスト確認
- [ ] ルーム作成→メッセージ送信→取得の一連フロー
- [ ] 複数エージェントの同時入室
- [ ] 統計情報の正確性
- [ ] ファイルロックによる同時アクセス制御

## 完了条件
- [ ] MCPサーバーが起動しstdio経由で通信可能
- [ ] 全9ツールがspec.md通りに動作
- [ ] 統合テストが全て合格
- [ ] E2Eテストが全て合格
- [ ] README.mdにセットアップと使用方法記載
- [ ] CI/CDパイプラインが動作

## 注意事項
- 各エージェントの実装を変更せず、アダプター層で統合
- モックを実装に置き換える際は慎重に
- パフォーマンスの劣化がないことを確認