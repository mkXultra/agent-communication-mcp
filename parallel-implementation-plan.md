# Agent Communication MCP Server 並列実装計画書

## 概要
4つのAIエージェントによる完全並列開発計画。3つのエージェントが各機能を独立実装し、1つのエージェントが統合に専念します。

## AIエージェント構成

- **エージェントA**: メッセージング機能担当
- **エージェントB**: ルーム・プレゼンス機能担当  
- **エージェントC**: 管理機能担当
- **エージェントD**: 統合・インフラ担当

---

## フェーズ0：初期セットアップ

### 共同作成物
```
src/contracts/
├── paths.ts              # ファイルパス規約
├── types.ts              # 基本型定義
└── errors.ts             # エラーコード定義
```

### 合意事項
```typescript
// paths.ts - 全員が守るファイルパス規約
export const PATHS = {
  ROOMS_DATA: 'data/rooms.json',
  ROOM_MESSAGES: (room: string) => `data/rooms/${room}/messages.jsonl`,
  ROOM_PRESENCE: (room: string) => `data/rooms/${room}/presence.json`
};

// types.ts - 最小限の共通型
export interface Room {
  name: string;
  description?: string;
  createdAt: string;
}

export interface Message {
  id: string;
  roomName: string;
  agentName: string;
  message: string;
  timestamp: string;
}

// errors.ts - エラーコード
export enum ErrorCode {
  ROOM_NOT_FOUND = 'ROOM_NOT_FOUND',
  ROOM_ALREADY_EXISTS = 'ROOM_ALREADY_EXISTS',
  // ...
}
```

---

## エージェントA：メッセージング機能担当

### 完全独立実装

#### ディレクトリ構造
```
src/features/messaging/
├── index.ts               # 公開API
├── MessageService.ts      # ビジネスロジック
├── MessageStorage.ts      # ストレージ層
├── MessageValidator.ts    # バリデーション
├── MessageCache.ts        # キャッシュ層
├── types/
│   └── messaging.types.ts # メッセージング専用型
├── tools/
│   └── messaging.tools.ts # MCPツール定義
└── README.md             # 独立したドキュメント
```

#### 公開API（index.ts）
```typescript
// 統合時に使用されるAPI
export interface IMessagingAPI {
  sendMessage(params: SendMessageParams): Promise<Message>;
  getMessages(params: GetMessagesParams): Promise<Message[]>;
  getMessageCount(roomName: string): Promise<number>;
}

export class MessagingAPI implements IMessagingAPI {
  // 実装
}
```

#### 独自実装内容
- JSONLファイルへの直接読み書き
- メンション解析（@agentName）
- LRUキャッシュによる高速化
- ストリーミング読み込み

#### テスト
```
tests/messaging/
├── unit/
│   ├── MessageService.test.ts
│   └── MessageCache.test.ts
├── integration/
│   └── messaging-flow.test.ts
└── performance/
    └── throughput.test.ts    # 1000msg/秒
```

### 成果物
- [ ] 独立動作するメッセージング機能
- [ ] send_message, get_messages MCPツール
- [ ] 性能目標達成（1000msg/秒）
- [ ] APIドキュメント

---

## エージェントB：ルーム・プレゼンス機能担当

### 完全独立実装

#### ディレクトリ構造
```
src/features/rooms/
├── index.ts               # 公開API
├── room/
│   ├── RoomService.ts
│   ├── RoomStorage.ts
│   └── RoomValidator.ts
├── presence/
│   ├── PresenceService.ts
│   └── PresenceStorage.ts
├── types/
│   └── rooms.types.ts
├── tools/
│   ├── room.tools.ts      # create_room, list_rooms
│   └── presence.tools.ts  # enter_room, leave_room, list_room_users
└── README.md
```

#### 公開API（index.ts）
```typescript
export interface IRoomsAPI {
  createRoom(name: string, description?: string): Promise<Room>;
  roomExists(name: string): Promise<boolean>;
  listRooms(): Promise<Room[]>;
  enterRoom(agentName: string, roomName: string): Promise<void>;
  leaveRoom(agentName: string, roomName: string): Promise<void>;
  getRoomUsers(roomName: string): Promise<string[]>;
}

export class RoomsAPI implements IRoomsAPI {
  // 実装
}
```

#### 独自実装内容
- rooms.jsonの管理
- プレゼンス情報の管理
- オフラインユーザーの自動クリーンアップ
- ルーム統計情報

#### テスト
```
tests/rooms/
├── unit/
│   ├── RoomService.test.ts
│   └── PresenceService.test.ts
├── integration/
│   └── room-lifecycle.test.ts
└── load/
    └── multi-room.test.ts    # 100ルーム×50ユーザー
```

### 成果物
- [ ] 独立動作するルーム管理機能
- [ ] プレゼンス管理機能
- [ ] 5つのMCPツール実装
- [ ] APIドキュメント

---

## エージェントC：管理機能担当

### 完全独立実装

#### ディレクトリ構造
```
src/features/management/
├── index.ts               # 公開API
├── ManagementService.ts
├── StatsCollector.ts      # 統計収集
├── DataScanner.ts         # ファイルスキャン
├── types/
│   └── management.types.ts
├── tools/
│   └── management.tools.ts # get_status, clear_room_messages
└── README.md
```

#### 公開API（index.ts）
```typescript
export interface IManagementAPI {
  getSystemStatus(): Promise<SystemStatus>;
  getRoomStatistics(roomName: string): Promise<RoomStats>;
  clearRoomMessages(roomName: string): Promise<void>;
}

export class ManagementAPI implements IManagementAPI {
  // 実装
}
```

#### 独自実装内容
- ディレクトリスキャンによる統計収集
- メッセージファイルサイズ計算
- システムメトリクス収集
- データクリーンアップ機能

#### テスト
```
tests/management/
├── unit/
│   ├── ManagementService.test.ts
│   └── StatsCollector.test.ts
└── integration/
    └── stats-accuracy.test.ts
```

### 成果物
- [ ] 独立動作する管理機能
- [ ] get_status, clear_room_messages MCPツール
- [ ] リアルタイム統計情報
- [ ] APIドキュメント

---

## エージェントD：統合・インフラ担当

### 実装内容

#### 1. プロジェクト基盤
```
agent-communication-mcp/
├── package.json
├── tsconfig.json
├── jest.config.js
├── .eslintrc.json
├── .gitignore
├── docker-compose.yml     # 開発環境
└── Makefile              # ビルド・テストコマンド
```

#### 2. MCPサーバー基盤
```
src/
├── index.ts              # エントリーポイント
├── server/
│   ├── MCPServer.ts      # サーバー実装
│   ├── ToolRegistry.ts   # ツール登録システム
│   ├── Middleware.ts     # 共通ミドルウェア
│   └── ErrorHandler.ts   # エラーハンドリング
└── utils/
    ├── logger.ts         # ロギング
    └── config.ts         # 設定管理
```

#### 3. 統合アダプター
```
src/adapters/
├── BaseAdapter.ts        # アダプター基底クラス
├── MessagingAdapter.ts   # エンジニアAの機能を統合
├── RoomsAdapter.ts       # エンジニアBの機能を統合
└── ManagementAdapter.ts  # エンジニアCの機能を統合
```

各アダプターの実装例：
```typescript
// MessagingAdapter.ts
export class MessagingAdapter extends BaseAdapter {
  private messagingAPI?: IMessagingAPI;

  async initialize(): Promise<void> {
    // エージェントAの成果物を動的にインポート
    const { MessagingAPI } = await import('../features/messaging');
    this.messagingAPI = new MessagingAPI();
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'agent_communication/send_message',
        handler: this.handleSendMessage.bind(this)
      },
      // ...
    ];
  }
}
```

#### 4. 統合テスト環境
```
tests/
├── integration/
│   ├── setup.ts          # テスト環境セットアップ
│   ├── adapters/         # アダプターテスト
│   └── scenarios/        # 実使用シナリオテスト
└── e2e/
    ├── full-flow.test.ts # 全機能統合テスト
    └── performance.test.ts # 負荷テスト
```

#### 5. CI/CD環境
```
.github/workflows/
├── feature-test.yml      # 各機能の独立テスト
├── integration-test.yml  # 統合テスト
├── performance-test.yml  # パフォーマンステスト
└── release.yml          # リリースワークフロー
```

#### 6. ドキュメント統合
```
docs/
├── README.md            # プロジェクト概要
├── SETUP.md            # セットアップガイド
├── API.md              # 統合APIドキュメント
├── ARCHITECTURE.md     # アーキテクチャ説明
└── features/           # 各機能のドキュメントを統合
    ├── messaging.md
    ├── rooms.md
    └── management.md
```

### エージェントDの責任範囲
- [ ] MCPサーバー基盤の構築
- [ ] 動的な機能統合システム
- [ ] 統合テストスイート
- [ ] CI/CDパイプライン
- [ ] 統合ドキュメント
- [ ] Dockerイメージ作成

---

## 実装順序

### 1. 初期セットアップ（全エージェント共通）
- src/contracts/の共通定義ファイル作成

### 2. 並列実装フェーズ
- **エージェントA**: メッセージング機能の完全実装
- **エージェントB**: ルーム・プレゼンス機能の完全実装
- **エージェントC**: 管理機能の完全実装
- **エージェントD**: MCPサーバー基盤とアダプターシステム構築

### 3. 統合フェーズ
- エージェントDが各機能を統合
- E2Eテストの実行
- 最終調整

## 統合戦略の利点

1. **完全な並列開発**
   - 各エンジニアが完全に独立して開発
   - 統合エンジニアが早期から準備

2. **柔軟な統合**
   - 各機能が完成次第、順次統合可能
   - 一部機能の遅延が全体に影響しない

3. **品質保証**
   - 統合エンジニアが統合テストに専念
   - 各機能の独立テスト＋統合テスト

4. **スムーズなリリース**
   - 統合エンジニアがCI/CDを整備
   - ドキュメントの一元管理

## 実装上の注意事項

### インターフェース定義の厳守
- 各エージェントはsrc/contracts/に定義された型とパスを厳守
- 公開APIの変更は禁止（追加は可能）

### テストの自動実行
- 各機能は独立してテスト可能であること
- カバレッジ90%以上を維持

### エラーハンドリング
- 定義されたエラーコードを使用
- 適切なログ出力を実装

この4名体制により、各AIエージェントが独立して並列実装を進めることができます。