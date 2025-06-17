# Agent Communication MCP Server 仕様書

## 概要

Agent Communication MCP Serverは、複数のエージェントがルームベースでメッセージをやり取りするためのModel Context Protocol (MCP) サーバーです。Slackのようなチャンネル機能を提供し、トピック別、チーム別のコミュニケーションを実現します。

## 目的

- ルームベースのエージェント間コミュニケーション
- トピック別、チーム別の会話分離
- プレゼンス管理（ルーム毎のオンライン状態追跡）
- メッセージ履歴のルーム毎保存と検索

## アーキテクチャ

### データストレージ
- **メッセージ**: ルーム毎のJSONLファイル（`rooms/{roomName}/messages.jsonl`）
- **プレゼンス情報**: ルーム毎のJSONファイル（`rooms/{roomName}/presence.json`）
- **ルーム情報**: JSONファイル（`rooms.json`）
- **ロック機構**: ファイルロックによる同時アクセス制御

### MCPプロトコル準拠
- JSON-RPC 2.0ベースの通信
- 標準的なMCPツール定義
- エラーハンドリングとレスポンス形式

## 主要機能

### 1. ルーム管理

#### 1.1 ルーム一覧 (list_rooms)
```typescript
tool: agent_communication/list_rooms
parameters:
  - agentName?: string  // 自分が参加しているルームのみ表示（オプション）
returns:
  - rooms: Array<{
      name: string        // ルーム名
      description?: string // ルームの説明
      userCount: number   // 現在の参加者数
      messageCount: number // 累計メッセージ数
      isJoined?: boolean  // 自分が参加しているか
    }>
```

#### 1.2 ルーム作成 (create_room)
```typescript
tool: agent_communication/create_room
parameters:
  - roomName: string     // ルーム名（英数字、ハイフン、アンダースコア）
  - description?: string // ルームの説明
returns:
  - success: boolean
  - roomName: string
  - message: string
```

#### 1.3 ルーム入室 (enter_room)
```typescript
tool: agent_communication/enter_room
parameters:
  - agentName: string     // エージェント名（一意である必要がある）
  - roomName: string      // 入室するルーム名
  - profile?: {           // オプショナル: エージェントプロフィール
      role?: string       // 役割（例: "coordinator", "analyzer", "reporter"）
      description?: string // 説明
      capabilities?: string[] // 能力リスト
      metadata?: object   // その他のカスタムメタデータ
    }
returns:
  - success: boolean
  - roomName: string
  - message: string   // システムメッセージ
```

#### 1.4 ルーム退室 (leave_room)
```typescript
tool: agent_communication/leave_room
parameters:
  - agentName: string // エージェント名
  - roomName: string  // 退室するルーム名
returns:
  - success: boolean
  - roomName: string
  - message: string   // システムメッセージ
```

#### 1.5 ルーム内ユーザー一覧 (list_room_users)
```typescript
tool: agent_communication/list_room_users
parameters:
  - roomName: string    // ルーム名
returns:
  - roomName: string
  - users: Array<{
      name: string        // エージェント名
      status: "online" | "offline"
      messageCount?: number // そのルームでのメッセージ数
      profile?: {         // エージェントプロフィール（設定されている場合）
        role?: string
        description?: string
        capabilities?: string[]
        metadata?: object
      }
    }>
  - onlineCount: number
```

### 2. メッセージング

#### 2.1 メッセージ送信 (send_message)
```typescript
tool: agent_communication/send_message
parameters:
  - agentName: string  // 送信者エージェント名
  - roomName: string   // 送信先ルーム名
  - message: string    // メッセージ内容（@agent_nameでメンション可能）
  - metadata?: object  // オプショナルメタデータ
returns:
  - success: boolean
  - messageId: string  // メッセージID
  - roomName: string
  - timestamp: string  // 送信時刻
  - mentions: string[] // メッセージ内で@メンションされたエージェント名
```

#### 2.2 メッセージ取得 (get_messages)
```typescript
tool: agent_communication/get_messages
parameters:
  - roomName: string   // ルーム名
  - agentName?: string // 自分のエージェント名（メンションフィルタリング用）
  - limit?: number     // 取得件数（デフォルト: 50）
  - offset?: number    // 取得開始位置（デフォルト: 0）
  - mentionsOnly?: boolean // 自分宛のメンションのみ取得
returns:
  - roomName: string
  - messages: Array<{
      id: string
      agentName: string  // 送信者のエージェント名
      message: string
      timestamp: string
      mentions: string[] // メンションされたエージェント名のリスト
      metadata?: object
    }>
  - count: number
  - hasMore: boolean     // さらに古いメッセージがあるか
```

### 3. 管理機能

#### 3.1 ステータス取得 (get_status)
```typescript
tool: agent_communication/get_status
parameters:
  - roomName?: string  // 特定ルームのステータス（省略時は全体）
returns:
  - rooms: Array<{
      name: string
      onlineUsers: number
      totalMessages: number
      storageSize: number
    }>
  - totalRooms: number
  - totalOnlineUsers: number
  - totalMessages: number
```

#### 3.2 ルームメッセージクリア (clear_room_messages)
```typescript
tool: agent_communication/clear_room_messages
parameters:
  - roomName: string   // ルーム名
  - confirm: boolean   // 確認フラグ（必須）
returns:
  - success: boolean
  - roomName: string
  - clearedCount: number
```

## データフォーマット

### ルーム情報フォーマット (rooms.json)
```json
{
  "rooms": {
    "general": {
      "description": "General discussion",
      "createdAt": "2024-01-20T09:00:00Z",
      "messageCount": 150,
      "userCount": 5
    },
    "dev-team": {
      "description": "Development team discussions",
      "createdAt": "2024-01-20T09:30:00Z",
      "messageCount": 42,
      "userCount": 3
    }
  }
}
```

### メッセージフォーマット (rooms/{roomName}/messages.jsonl)
```json
{"id":"msg_1234567890","roomName":"dev-team","agentName":"agent1","message":"Hello @coordinator, task completed!","mentions":["coordinator"],"timestamp":"2024-01-20T10:30:00Z","metadata":{}}
```

### プレゼンスフォーマット (rooms/{roomName}/presence.json)
```json
{
  "roomName": "dev-team",
  "users": {
    "agent1": {  // エージェント名をキーとして使用
      "status": "online",
      "messageCount": 42,
      "joinedAt": "2024-01-20T10:00:00Z",
      "profile": {
        "role": "coordinator",
        "description": "Task coordination and workflow management",
        "capabilities": ["task_planning", "resource_allocation", "progress_tracking"],
        "metadata": {
          "team": "automation",
          "version": "2.0"
        }
      }
    }
  }
}
```

## 実装詳細

### ディレクトリ構造
```
mcp-server/agent-communication/
├── data/                 # データファイル
│   ├── rooms.json       # ルーム情報
│   └── rooms/           # ルーム別データ
│       ├── general/
│       │   ├── messages.jsonl
│       │   └── presence.json
│       └── dev-team/
│           ├── messages.jsonl
│           └── presence.json
├── src/
│   ├── index.ts           # エントリーポイント
│   ├── tools/            # MCPツール定義
│   │   ├── room.ts       # ルーム管理ツール
│   │   ├── messaging.ts  # メッセージングツール
│   │   └── management.ts # 管理ツール
│   ├── services/         # ビジネスロジック
│   │   ├── RoomService.ts
│   │   ├── MessageService.ts
│   │   └── StorageService.ts
│   ├── utils/            # ユーティリティ
│   │   └── filelock.ts   # ファイルロック機構
│   └── types/            # 型定義
│       └── index.ts
├── tests/               # テスト
├── package.json
└── README.md
```

### エラーハンドリング

#### エラーコード
- `ROOM_NOT_FOUND`: ルームが見つからない
- `ROOM_ALREADY_EXISTS`: ルームが既に存在
- `AGENT_NOT_FOUND`: エージェントが見つからない
- `AGENT_ALREADY_IN_ROOM`: エージェントが既に入室済み
- `AGENT_NOT_IN_ROOM`: エージェントがルームにいない
- `FILE_LOCK_TIMEOUT`: ファイルロックタイムアウト
- `INVALID_MESSAGE_FORMAT`: 不正なメッセージフォーマット
- `STORAGE_ERROR`: ストレージアクセスエラー

### セキュリティ考慮事項

1. **ファイルアクセス制限**: 指定されたディレクトリ外へのアクセス防止
2. **入力検証**: エージェント名、メッセージ内容の検証
3. **レート制限**: 大量メッセージ送信の防止
4. **ログ記録**: 全操作のログ記録

## 拡張性

### 将来的な拡張機能
1. **メッセージ暗号化**: エンドツーエンド暗号化
2. **プライベートルーム**: 招待制ルーム、パスワード保護
3. **メッセージタイプ**: テキスト以外のメッセージ（ファイル、画像等）
4. **永続化オプション**: データベース対応
5. **ルームアーカイブ**: 古いルームの自動アーカイブ

## 設定

### 環境変数
```bash
AGENT_COMM_DATA_DIR       # データディレクトリ（デフォルト: ./data）
AGENT_COMM_LOCK_TIMEOUT   # ロックタイムアウト（デフォルト: 5000ms）
AGENT_COMM_MAX_MESSAGES   # ルームあたり最大メッセージ数（デフォルト: 10000）
AGENT_COMM_MAX_ROOMS      # 最大ルーム数（デフォルト: 100）
```

## テスト計画

### ユニットテスト
- 各サービスクラスの個別テスト
- ファイルロック機構のテスト
- エラーハンドリングのテスト

### 統合テスト
- 複数ルームでの同時アクセステスト
- ルーム間のメッセージ分離テスト
- エージェントの複数ルーム参加テスト

### パフォーマンステスト
- 大量メッセージ処理
- 同時接続数の限界テスト
- ファイルサイズ増大時の性能

## 実装計画

1. **Phase 1**: ルーム管理機能（ルーム作成、一覧、入退室）
2. **Phase 2**: メッセージング機能（ルーム別送受信）
3. **Phase 3**: 管理機能（ステータス、クリア）
4. **Phase 4**: テストとドキュメント整備

## 成功指標

- **可用性**: 99.9%以上のアップタイム
- **パフォーマンス**: メッセージ送信レイテンシ < 100ms
- **スケーラビリティ**: 100ルーム×平均10エージェント/ルーム
- **信頼性**: メッセージ損失率 < 0.01%