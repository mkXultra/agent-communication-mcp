# Agent Communication MCP Server インターフェース設計書実装計画書

## 概要
本計画書は、並列開発を可能にするための詳細なインターフェース設計の実装計画を定義します。

## 設計対象インターフェース一覧

### 1. 共通型定義（最優先）
- 基本データ型（Room、Message、Agent、Presence）
- エラー型定義
- MCPレスポンス型定義

### 2. サービス層インターフェース
- IStorageService：ストレージ抽象化層
- IRoomService：ルーム管理サービス
- IMessageService：メッセージングサービス
- IManagementService：管理機能サービス

### 3. MCPツールインターフェース
- 各ツールのパラメータスキーマ
- レスポンス型定義

## 実装スケジュール（2日間集中設計）

### Day 0.5（半日）：設計前準備
**午前（2-3時間）**
```
1. チーム全員でのキックオフ
   - 実装方針ドキュメントの読み合わせ
   - 質疑応答と認識合わせ
   - 担当割り振り

2. 設計テンプレート準備
   - TypeScript型定義テンプレート
   - インターフェースドキュメントテンプレート
   - レビューチェックリスト作成
```

### Day 1：コア設計
**午前：基本型定義（全員参加必須）**
```typescript
// 1. 基本エンティティ型
interface Room {
  name: string;
  description?: string;
  createdAt: string;
  messageCount: number;
  userCount: number;
}

interface Message {
  id: string;
  roomName: string;
  agentName: string;
  message: string;
  mentions: string[];
  timestamp: string;
  metadata?: Record<string, any>;
}

interface Agent {
  name: string;
  profile?: AgentProfile;
}

interface AgentProfile {
  role?: string;
  description?: string;
  capabilities?: string[];
  metadata?: Record<string, any>;
}

interface Presence {
  agentName: string;
  status: 'online' | 'offline';
  joinedAt: string;
  messageCount: number;
  profile?: AgentProfile;
}
```

**午後：サービスインターフェース設計**
```typescript
// 各担当者が並列で作業
// 担当A: StorageService
interface IStorageService {
  // ファイル操作
  readJSON<T>(path: string): Promise<T>;
  writeJSON<T>(path: string, data: T): Promise<void>;
  appendJSONL(path: string, data: any): Promise<void>;
  readJSONL<T>(path: string, options?: ReadOptions): Promise<T[]>;
  
  // ロック機構
  withLock<T>(path: string, operation: () => Promise<T>): Promise<T>;
  
  // ユーティリティ
  exists(path: string): Promise<boolean>;
  ensureDir(path: string): Promise<void>;
}

// 担当B: RoomService
interface IRoomService {
  // ルーム管理
  createRoom(roomName: string, description?: string): Promise<Room>;
  listRooms(agentName?: string): Promise<RoomListResponse>;
  deleteRoom(roomName: string): Promise<void>;
  
  // プレゼンス管理
  enterRoom(agentName: string, roomName: string, profile?: AgentProfile): Promise<void>;
  leaveRoom(agentName: string, roomName: string): Promise<void>;
  listRoomUsers(roomName: string): Promise<Presence[]>;
  updatePresence(roomName: string, agentName: string, status: 'online' | 'offline'): Promise<void>;
}

// 担当C: MessageService & ManagementService
interface IMessageService {
  sendMessage(params: SendMessageParams): Promise<Message>;
  getMessages(params: GetMessagesParams): Promise<MessageListResponse>;
  deleteMessage(roomName: string, messageId: string): Promise<void>;
}

interface IManagementService {
  getStatus(roomName?: string): Promise<StatusResponse>;
  clearRoomMessages(roomName: string): Promise<ClearResult>;
  getRoomStatistics(roomName: string): Promise<RoomStatistics>;
}
```

### Day 2：MCPツール定義とレビュー
**午前：MCPツールパラメータ定義**
```typescript
// Zodスキーマと型定義の作成
// 各ツールごとにinput/outputを明確化

// 例: send_message
const sendMessageInputSchema = z.object({
  agentName: z.string().min(1).max(50),
  roomName: z.string().regex(/^[a-zA-Z0-9-_]+$/),
  message: z.string().min(1).max(1000),
  metadata: z.record(z.any()).optional()
});

type SendMessageInput = z.infer<typeof sendMessageInputSchema>;

interface SendMessageOutput {
  success: boolean;
  messageId: string;
  roomName: string;
  timestamp: string;
  mentions: string[];
}
```

**午後：統合レビューと調整**
```
1. 全インターフェースのクロスレビュー
   - 命名の一貫性確認
   - 型の整合性チェック
   - 不足している定義の洗い出し

2. 統合テスト用モックの設計
   - 各インターフェースのモック実装方針
   - テストデータ構造の定義

3. 最終調整とドキュメント化
   - 設計決定事項の文書化
   - 実装時の注意事項まとめ
```

## 成果物

### 1. 型定義ファイル群
```
src/types/
├── entities.ts      # Room, Message, Agent等の基本型
├── services.ts      # サービスインターフェース
├── errors.ts        # エラー型定義
├── mcp.ts          # MCPツール関連型
└── index.ts        # 統合エクスポート
```

### 2. スキーマ定義ファイル群
```
src/schemas/
├── room.schema.ts
├── message.schema.ts
├── management.schema.ts
└── index.ts
```

### 3. インターフェース設計書
- Markdown形式の詳細仕様書
- 各インターフェースの責務と使用例
- エラーケースの明確化

### 4. モックファクトリー
```
tests/mocks/
├── mockStorageService.ts
├── mockRoomService.ts
├── mockMessageService.ts
└── fixtures/
    ├── rooms.json
    └── messages.json
```

## レビュー基準

### 必須確認項目
1. **型安全性**：any型の使用禁止、適切な型制約
2. **命名一貫性**：実装方針に従った命名
3. **エラーハンドリング**：全エラーケースの考慮
4. **テスタビリティ**：モック可能な設計
5. **拡張性**：将来の機能追加を妨げない設計

### レビューチェックリスト
- [ ] 全ての関数に戻り値の型が明示されているか
- [ ] エラーケースが網羅されているか
- [ ] 非同期処理がPromiseで統一されているか
- [ ] オプショナルパラメータが適切に設計されているか
- [ ] 循環依存が発生していないか

## リスクと対策

### リスク1：インターフェース変更の影響
**対策**：
- セマンティックバージョニングの概念を適用
- Breaking changeは全員で協議

### リスク2：認識の齟齬
**対策**：
- 日次15分のスタンドアップ
- Slackでの即時質問・回答

### リスク3：過度な抽象化
**対策**：
- YAGNI原則の徹底
- 実装時に必要になったら追加

## 次のステップ

インターフェース設計完了後：
1. 各チームメンバーが担当サービスの実装開始
2. CIパイプラインの構築
3. 日次でのインテグレーションテスト

この計画により、2日間で完全なインターフェース設計を完了し、並列開発を開始できます。