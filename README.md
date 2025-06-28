# Agent Communication MCP Server

エージェント間のルームベースコミュニケーションを実現するModel Context Protocol (MCP) サーバー

## 概要

Agent Communication MCP Serverは、複数のAIエージェントがSlackのようなチャンネル形式でメッセージをやり取りできるMCPサーバーです。ルーム（チャンネル）ベースでトピック別・チーム別のコミュニケーションを実現します。

### 主な機能

- 🚪 **ルーム管理**: ルームの作成、入退室、ユーザー一覧表示
- 💬 **メッセージング**: ルーム内でのメッセージ送受信、@メンション機能
- ⏳ **ロングポーリング**: 新着メッセージの効率的な待機機能
- 📊 **管理機能**: システムステータス確認、メッセージクリア
- 🔒 **データ整合性**: ファイルロックによる同時アクセス制御

## インストール

### npmパッケージとして利用

```bash
npm install agent-communication-mcp
```

### ソースコードから利用

```bash
# リポジトリのクローン
git clone https://github.com/mkXultra/agent-communication-mcp.git
cd agent-communication-mcp

# 依存関係のインストール
npm install

# TypeScriptのビルド
npm run build
```

## 使用方法

### MCPクライアントとの接続

1. **Claude Desktopの設定**

`claude_desktop_config.json`に以下を追加:

```json
{
  "mcpServers": {
    "agent-communication": {
      "command": "npx",
      "args": ["agent-communication-mcp"],
      "env": {
        "AGENT_COMM_DATA_DIR": "/path/to/data/directory"
      }
    }
  }
}
```

または、ローカルインストールの場合:

```json
{
  "mcpServers": {
    "agent-communication": {
      "command": "node",
      "args": ["/path/to/agent-communication-mcp/dist/index.js"],
      "env": {
        "AGENT_COMM_DATA_DIR": "/path/to/data/directory"
      }
    }
  }
}
```

2. **VSCode Extension経由での使用**

MCP対応のVSCode拡張機能から接続可能です。

### 環境変数

| 変数名 | 説明 | デフォルト値 |
|--------|------|-------------|
| `AGENT_COMM_DATA_DIR` | データファイルの保存ディレクトリ | `./data` |
| `AGENT_COMM_LOCK_TIMEOUT` | ファイルロックのタイムアウト時間（ミリ秒） | `5000` |
| `AGENT_COMM_MAX_MESSAGES` | ルームあたりの最大メッセージ数 | `10000` |
| `AGENT_COMM_MAX_ROOMS` | 最大ルーム数 | `100` |
| `AGENT_COMM_WAIT_TIMEOUT` | wait_for_messagesの最大タイムアウト時間（ミリ秒） | `120000` |

## ツール一覧と使用例

### 1. ルーム管理ツール

#### list_rooms - ルーム一覧取得
```typescript
// 全ルームを取得
{
  "tool": "agent_communication/list_rooms",
  "arguments": {}
}

// 特定エージェントが参加しているルームのみ取得
{
  "tool": "agent_communication/list_rooms",
  "arguments": {
    "agentName": "agent1"
  }
}
```

#### create_room - ルーム作成
```typescript
{
  "tool": "agent_communication/create_room",
  "arguments": {
    "roomName": "dev-team",
    "description": "Development team discussions"
  }
}
```

#### enter_room - ルーム入室
```typescript
{
  "tool": "agent_communication/enter_room",
  "arguments": {
    "agentName": "agent1",
    "roomName": "dev-team",
    "profile": {
      "role": "developer",
      "description": "Backend development specialist",
      "capabilities": ["python", "nodejs", "database"]
    }
  }
}
```

#### leave_room - ルーム退室
```typescript
{
  "tool": "agent_communication/leave_room",
  "arguments": {
    "agentName": "agent1",
    "roomName": "dev-team"
  }
}
```

#### list_room_users - ルーム内ユーザー一覧
```typescript
{
  "tool": "agent_communication/list_room_users",
  "arguments": {
    "roomName": "dev-team"
  }
}
```

### 2. メッセージングツール

#### send_message - メッセージ送信
```typescript
{
  "tool": "agent_communication/send_message",
  "arguments": {
    "agentName": "agent1",
    "roomName": "dev-team",
    "message": "Hello @agent2, can you review this code?",
    "metadata": {
      "priority": "high"
    }
  }
}
```

#### get_messages - メッセージ取得
```typescript
// 最新50件のメッセージを取得
{
  "tool": "agent_communication/get_messages",
  "arguments": {
    "roomName": "dev-team",
    "limit": 50
  }
}

// 自分宛のメンションのみ取得
{
  "tool": "agent_communication/get_messages",
  "arguments": {
    "roomName": "dev-team",
    "agentName": "agent2",
    "mentionsOnly": true
  }
}
```

#### wait_for_messages - 新着メッセージ待機（ロングポーリング）
```typescript
// 新着メッセージが来るまで待機（最大30秒）
{
  "tool": "agent_communication/wait_for_messages",
  "arguments": {
    "agentName": "agent1",
    "roomName": "dev-team",
    "timeout": 30
  }
}

// デフォルトタイムアウト（30秒）で待機
{
  "tool": "agent_communication/wait_for_messages",
  "arguments": {
    "agentName": "agent1",
    "roomName": "dev-team"
  }
}
```

このツールを使用すると：
- 新着メッセージがある場合は即座に返却
- ない場合は新着メッセージが来るまで待機（最大timeout秒）
- 複数エージェントが同時に待機している場合はデッドロック警告を表示
- 自動的に既読位置を管理

### 3. 管理ツール

#### get_status - システムステータス取得
```typescript
// 全体のステータスを取得
{
  "tool": "agent_communication/get_status",
  "arguments": {}
}

// 特定ルームのステータスを取得
{
  "tool": "agent_communication/get_status",
  "arguments": {
    "roomName": "dev-team"
  }
}
```

#### clear_room_messages - ルームメッセージクリア
```typescript
{
  "tool": "agent_communication/clear_room_messages",
  "arguments": {
    "roomName": "dev-team",
    "confirm": true
  }
}
```

## 開発

### ビルドとテスト

```bash
# TypeScriptのビルド
npm run build

# 開発モード（ウォッチモード）
npm run dev

# テストの実行
npm test

# 特定の機能のテスト
npm run test:messaging
npm run test:rooms
npm run test:management

# 統合テスト
npm run test:integration

# E2Eテスト
npm run test:e2e

# カバレッジレポート
npm run test:coverage
```

### 型チェックとLint

```bash
# 型チェック
npm run typecheck

# ESLint
npm run lint
```

## アーキテクチャ

```
MCPクライアント
    ↓
MCPサーバー (src/index.ts)
    ↓
ツールレジストリ (src/server/ToolRegistry.ts)
    ↓
アダプター層 (src/adapters/)
    ├── MessagingAdapter
    ├── RoomsAdapter
    └── ManagementAdapter
    ↓
機能モジュール (src/features/)
    ├── messaging/
    ├── rooms/
    └── management/
```

### データ構造

```
data/
├── rooms.json              # ルーム情報
└── rooms/                  # ルーム別データ
    ├── general/
    │   ├── messages.jsonl  # メッセージ履歴
    │   ├── presence.json   # プレゼンス情報
    │   ├── read_status.json # 既読管理
    │   └── waiting_agents.json # 待機中エージェント
    └── dev-team/
        ├── messages.jsonl
        ├── presence.json
        ├── read_status.json
        └── waiting_agents.json
```

## トラブルシューティング

### ファイルロックエラー
- `LOCK_TIMEOUT`エラーが発生した場合、`AGENT_COMM_LOCK_TIMEOUT`環境変数を増やしてください
- 古いロックファイル（`.lock`拡張子）が残っている場合は手動で削除してください

### ルームが見つからない
- ルーム名は英数字、ハイフン、アンダースコアのみ使用可能です
- ルームに入室する前に作成されているか確認してください

### メッセージが送信できない
- エージェントがルームに入室しているか確認してください
- メッセージサイズが制限内（デフォルト1000文字）か確認してください

## ライセンス

MIT License

## 貢献

プルリクエストを歓迎します。大きな変更の場合は、まずissueを作成して変更内容について議論してください。

## サポート

問題が発生した場合は、GitHubのissueトラッカーに報告してください。