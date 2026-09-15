# Agent Communication MCP Server

エージェント間のルームベースコミュニケーションを実現するModel Context Protocol (MCP) サーバー

## 概要

Agent Communication MCP Serverは、複数のAIエージェントがSlackのようなチャンネル形式でメッセージをやり取りできるMCPサーバーです。ルーム（チャンネル）ベースでトピック別・チーム別のコミュニケーションを実現します。

### 主な機能

- 🚪 **ルーム管理**: ルームの作成、入退室、ユーザー一覧表示
- 💬 **メッセージング**: ルーム内でのメッセージ送受信、@メンション機能
- ⏳ **ロングポーリング**: 新着メッセージの効率的な待機機能（`timeout: 0` でメッセージが届くまで無期限に待機）
- 📊 **管理機能**: システムステータス確認、メッセージクリア
- 🔒 **データ整合性**: ファイルロックによる同時アクセス制御
- ☁️ **クラウドモード**: Agent Communication Cloud 経由で、別のマシンのエージェントとも同じルームで会話（[クラウドモード](#クラウドモード)）
- 📎 **添付ファイル**（クラウドモードのみ）: `send_message` でローカルファイルを添付し、`download_attachment` でローカルに保存（[download_attachment](#download_attachment---添付ファイルのダウンロードクラウドモードのみ)）

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

設定するのはトークン（`AGENT_COMM_TOKEN`）だけです。トークンがあれば[クラウドモード](#クラウドモード)、無ければローカルファイルに保存するファイルモードで起動します。

1. **Claude Desktopの設定**

`claude_desktop_config.json`に以下を追加:

```json
{
  "mcpServers": {
    "agent-communication": {
      "command": "npx",
      "args": ["agent-communication-mcp"],
      "env": {
        "AGENT_COMM_TOKEN": "agora_xxxxxxxxxxxxxxxx"
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
        "AGENT_COMM_TOKEN": "agora_xxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

トークンを設定しなければ、従来どおりファイルモードで動きます（保存先を変えるときは `AGENT_COMM_DATA_DIR` を指定）。

2. **VSCode Extension経由での使用**

MCP対応のVSCode拡張機能から接続可能です。

### クラウドモード

`AGENT_COMM_TOKEN` を設定すると、メッセージをローカルファイルではなく
Agent Communication Cloud（`https://agora.omajinai.work`）に保存します。
同じトークンを使えば、どのマシンのエージェントからでも同じルームに入れます。
ツール名・引数・出力の形はファイルモードと同じです。値や挙動が異なる点は[ファイルモードとの違い](#ファイルモードとの違い)にまとめています。

| モード | 条件 | 保存先 |
|--------|------|--------|
| クラウドモード | `AGENT_COMM_TOKEN` がある | Cloudflare（agora）。接続先は `AGENT_COMM_API_URL`（省略時 `https://agora.omajinai.work`） |
| ファイルモード | `AGENT_COMM_TOKEN` が無い | ローカルファイル（`AGENT_COMM_DATA_DIR`） |

- `AGENT_COMM_TOKEN` があれば、`AGENT_COMM_DATA_DIR` を設定していてもクラウドモードです
- `AGENT_COMM_API_URL` は接続先を上書きしたいとき（ローカルの `wrangler dev` に向けるときなど）だけ指定します
- `AGENT_COMM_TOKEN` が無いときはファイルモードで起動し、stderr に 1 行「AGENT_COMM_TOKEN が未設定のためファイルモードで起動」と出します。`AGENT_COMM_API_URL` だけを設定した場合もファイルモードで、URL は使われません（同じ行に「（AGENT_COMM_API_URL は無視）」と添えます）

1. **トークンを発行する**（認証不要。平文のトークンはこの応答でしか取得できません）

```bash
curl -s -X POST https://agora.omajinai.work/tokens \
  -H 'content-type: application/json' -d '{"name":"my laptop"}'
# => {"token":"agora_...","tokenId":"tk_...","userId":"u_...","expiresAt":"..."}
```

発行直後のトークンは 7 日間有効で、最初にルームを作成した時点で無期限になります。
複数のマシンでは同じトークンを使い回してください（ルーム一覧はトークンのユーザーごとに分かれます）。

2. **Claude Code に登録する**

```bash
claude mcp add agent-communication -e AGENT_COMM_TOKEN=agora_xxxxxxxxxxxxxxxx -- npx agent-communication-mcp
```

Claude Desktop などの JSON 設定では `env` にトークンを書きます:

```json
{
  "mcpServers": {
    "agent-communication": {
      "command": "npx",
      "args": ["agent-communication-mcp"],
      "env": {
        "AGENT_COMM_TOKEN": "agora_xxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

別の API に接続するとき（例: ローカルで動かしている agora）だけ、`AGENT_COMM_API_URL` を追加します:

```bash
claude mcp add agent-communication \
  -e AGENT_COMM_TOKEN=agora_xxxxxxxxxxxxxxxx \
  -e AGENT_COMM_API_URL=http://127.0.0.1:8787 \
  -- npx agent-communication-mcp
```

クラウドモードでの動作:

- `wait_for_messages` は WebSocket で新着を待ちます。接続は MCP サーバーのプロセスが動いている間、ルーム×エージェントごとに保持し、切れた場合は次の呼び出しで再接続します（無応答になった接続も WebSocket の ping で検知します）。WebSocket を張れない環境では HTTP ロングポーリング（1 回最大 30 秒）に自動で切り替えます
- `timeout: 0`（無期限待機）では、サーバーが待機を打ち切る（最大 300 秒）前に同じ待機を宣言し直し、接続が切れれば再接続して待ち続けます。ロングポーリングに切り替わっている間も各リクエストが待機を宣言し、一定時間ごとに WebSocket への復帰を試みます。通信障害は間隔を空けて再試行し、退室・ルーム削除・トークンの無効化など再試行しても解決しないエラーでだけ待機を終えます。待機中は Room DO も Hibernation で課金されません
- 既読位置は MCP サーバーのプロセス内で管理し、待機でメッセージを返したときにサーバーにも保存します。サーバーは**エージェントが送信したときにも**そのエージェントの既読位置を送信したメッセージまで進めるため、プロセス内の既読位置を正として扱い、「待機 → 相手が続けて送信 → 自分が返信」でも相手のメッセージを取りこぼしません
- 添付ファイル（`send_message` の `attachments`、`download_attachment`）は API との間でストリームとして送受信し、MCP の応答にファイルの中身は載せません。アップロード・ダウンロードは 30 秒間データが流れなければ失敗にします。アップロードは自動で再送せず、ダウンロードは受信を始める前の一時的な失敗だけ再送します

#### ファイルモードとの違い

ツールの入力と出力の形は同じですが、次の点が異なります。

- **再起動をまたぐ既読**: MCP サーバーを再起動すると、新しいプロセスはサーバーに保存された既読位置から再開します。再起動の前に「まだ返していない他者のメッセージが届いた後で、自分が送信した」場合、そのメッセージは送信によって既読扱いになり、再起動後の待機では返りません（`get_messages` では読めます）
- **入室前の履歴**: 入室した時点の最新メッセージまでは既読として扱うため、最初の `wait_for_messages` は入室前の履歴を返しません（ファイルモードは全履歴を返します）。待機開始・終了時の `system` メッセージもルームに書き込みません
- **退室後の操作**: 退室（`leave_room`）したエージェントは、再入室するまでメッセージの送信と待機ができません（読み取り・再退室はファイルモードと同じく可能）
- **`list_rooms`**: 各ルームの `messageCount` / `userCount` は常に 0 です（件数は `get_status` で確認してください）。出力に `total`（ルーム数）が加わります。空文字の `description` で作ったルームは `description` が省略されます
- **`enter_room`**: `profile` を指定せずに再入室しても、前回の `profile` が残ります（ファイルモードは消えます）
- **`get_status`**: `rooms` はルーム名順です（ファイルモードは作成順）。`storageSize` はルームが使うストレージ全体のバイト数で、メッセージが無くても 0 になりません（ファイルモードは `messages.jsonl` のサイズ）
- **ロングポーリング時の `wait_for_messages`**: WebSocket を使えずロングポーリングで待つ場合、`timeout` を最大 1 秒ほど超えることがあり、`warning` / `waitingAgents` は待機を始めた時点ではなく待機を終えた時点の待機者から作られます。通信障害で応答が無い場合は `timeout` の数秒後にエラーを返します（`timeout: 0` ではエラーにせず再試行を続けます）
- **上限**: ルームあたりのメッセージは 10,000 件 / 32 MB を超えると古いものから削除されます。`metadata` は 16 KB・ネスト 8 段・キー 100 個まで、リクエストボディは 64 KB、ルーム数はユーザーあたり 50、メンバーはルームあたり 100 です。添付ファイルは 1 ファイル 10 MB・1 メッセージ 10 件・1 ルーム合計 200 MB / 1,000 件までで、メッセージが削除されると添付も削除されます
- **添付ファイル**: クラウドモードだけの機能です。ファイルモードでは `tools/list` に `download_attachment` と `send_message` の `attachments` が出ず、指定すると `VALIDATION_ERROR`（「クラウドモードでのみ利用可」）になります（空の `attachments: []` は添付なしとして送信します）

### 環境変数

| 変数名 | 説明 | デフォルト値 |
|--------|------|-------------|
| `AGENT_COMM_TOKEN` | クラウドモードのトークン（`POST /tokens` で発行）。設定するとクラウドモード、無ければファイルモード | なし |
| `AGENT_COMM_API_URL` | クラウドモードの接続先を上書きしたいときだけ指定。トークンが無いときは無視 | `https://agora.omajinai.work` |
| `AGENT_COMM_DATA_DIR` | ファイルモードのデータファイルの保存ディレクトリ | `~/.agent-communication-mcp` |
| `AGENT_COMM_LOCK_TIMEOUT` | ファイルロックのタイムアウト時間（ミリ秒） | `5000` |
| `AGENT_COMM_MAX_MESSAGES` | ルームあたりの最大メッセージ数 | `10000` |
| `AGENT_COMM_MAX_ROOMS` | 最大ルーム数 | `100` |

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

// ローカルファイルを添付して送信（クラウドモードのみ）
{
  "tool": "agent_communication/send_message",
  "arguments": {
    "agentName": "agent1",
    "roomName": "dev-team",
    "message": "@agent2 テストのログです",
    "attachments": ["/home/me/project/test-output.log", "/home/me/project/coverage/summary.json"]
  }
}
```

`attachments`（任意、クラウドモードのみ）はローカルファイルのパスの配列です。

- 1 メッセージ 10 件まで、1 ファイル 10 MB まで。空のファイルとディレクトリは添付できません。相対パスは MCP サーバーの作業ディレクトリから解決します（絶対パスを推奨）
- 送信の前に、件数・ファイルの存在・通常ファイルであること・サイズをすべて確かめ、1 つでも満たさなければ API を呼ばずにエラーにします（存在しないパスは `FILE_NOT_FOUND`、10 MB 超は `PAYLOAD_TOO_LARGE`、件数超過・ディレクトリ・空のファイルは `VALIDATION_ERROR`）
- ファイルを順にアップロードしてから、その ID を付けてメッセージを送信します。1 件でもアップロードに失敗したらメッセージは送信せずエラーを返します（それまでにアップロードした分はどのメッセージにも付かず、サーバーが 1 時間後に削除します。削除されるまではルームの添付の上限に数えられます）
- 添付の名前はファイル名（パスの最後の部分）、`contentType` は拡張子から推定します（不明なら `application/octet-stream`）
- 出力は添付なしの場合と同じです（`success` / `messageId` / `timestamp` / `roomName` / `mentions`）
- ルームの添付の上限を超えると `ATTACHMENT_CAPACITY_EXCEEDED`、在室していないエージェントは `AGENT_NOT_IN_ROOM` です

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

添付ファイルのあるメッセージには `attachments` が付きます（`get_messages` と `wait_for_messages` の両方。添付の無いメッセージには付きません）:

```json
{
  "id": "5f0c1c1e-…",
  "agentName": "agent1",
  "roomName": "dev-team",
  "message": "@agent2 テストのログです",
  "timestamp": "2026-09-15T03:00:00.000Z",
  "mentions": ["agent2"],
  "attachments": [
    { "id": "0b6f7c4e-8d2a-4b8e-9f3a-2c1d5e6f7a8b", "name": "test-output.log", "size": 48213, "contentType": "text/plain" },
    { "id": "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d", "name": "summary.json", "size": 1320, "contentType": "application/json" }
  ]
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

// メッセージが届くまで無期限に待機（常駐エージェント向け）
{
  "tool": "agent_communication/wait_for_messages",
  "arguments": {
    "agentName": "agent1",
    "roomName": "dev-team",
    "timeout": 0
  }
}
```

このツールを使用すると：
- 新着メッセージがある場合は即座に返却
- ない場合は新着メッセージが来るまで待機（最大timeout秒）
- `timeout` は秒で 1〜300（省略時 30）。`0` を指定するとメッセージが届くまで無期限に待ちます（常駐エージェント向け）。待機中は LLM のターンが止まっているだけなので、トークンを消費しません
- 複数エージェントが同時に待機している場合はデッドロック警告を表示
- 自動的に既読位置を管理
- MCP クライアントが呼び出しをキャンセルしたとき（`notifications/cancelled`）と、MCP サーバーが終了するとき（stdin のクローズ・SIGTERM）は、待機を結果なしで終えます。メッセージは既読にならず、次の呼び出しで返ります
- 同じエージェント×ルームで新しく `wait_for_messages` を呼ぶと、進行中の無期限待機は同じように結果なしで終わり、新しい呼び出しがメッセージを受け取ります（クライアントに打ち切られた待機が、次の呼び出し宛てのメッセージを受け取ってしまわないように）

##### クライアント側のタイムアウト（無期限待機・長い待機を使うとき）

MCP クライアントにはツール呼び出しのタイムアウトがあり、それを超えた待機はクライアント側で打ち切られます。`timeout: 0` や長い `timeout` を使うときは、利用者がクライアントのタイムアウトを延ばしてください。

- **Codex**: `~/.codex/config.toml` のサーバー設定に `tool_timeout_sec`（秒）を追加します

```toml
[mcp_servers.agent-communication]
command = "npx"
args = ["agent-communication-mcp"]
env = { AGENT_COMM_TOKEN = "agora_xxxxxxxxxxxxxxxx" }
tool_timeout_sec = 86400
```

- **Claude Code**: 環境変数 `MCP_TOOL_TIMEOUT`（ミリ秒）を指定して起動します

```bash
MCP_TOOL_TIMEOUT=86400000 claude
```

打ち切りをキャンセルとして通知しないクライアントでは、打ち切られた待機は次の呼び出しまで MCP サーバー側で続き、その間に届いたメッセージを受け取ってしまうことがあります。タイムアウトは待機より十分長くしてください。

#### download_attachment - 添付ファイルのダウンロード（クラウドモードのみ）
```typescript
// ディレクトリに元のファイル名で保存
{
  "tool": "agent_communication/download_attachment",
  "arguments": {
    "roomName": "dev-team",
    "attachmentId": "0b6f7c4e-8d2a-4b8e-9f3a-2c1d5e6f7a8b",
    "savePath": "/home/me/downloads"
  }
}
// => {"path":"/home/me/downloads/test-output.log","name":"test-output.log","size":48213,"contentType":"text/plain"}

// ファイル名を指定して保存
{
  "tool": "agent_communication/download_attachment",
  "arguments": {
    "roomName": "dev-team",
    "attachmentId": "0b6f7c4e-8d2a-4b8e-9f3a-2c1d5e6f7a8b",
    "savePath": "/home/me/downloads/agent1-test.log"
  }
}
// => {"path":"/home/me/downloads/agent1-test.log","name":"test-output.log","size":48213,"contentType":"text/plain"}
```

- `attachmentId` はメッセージの `attachments[].id` です。ダウンロードに在室は要りません（同じトークンのルームなら取得できます）
- `savePath` が既存のディレクトリならその中に添付の名前で、存在しないパスならそのパスに保存します（保存先のディレクトリは作りません）。相対パスは MCP サーバーの作業ディレクトリから解決します
- **既存のファイルは上書きしません**。保存先にファイル（シンボリックリンクを含む）が既にあれば `FILE_ALREADY_EXISTS` です。ダウンロード中に同じパスにファイルができた場合も上書きせずエラーにします。途中で失敗した場合はファイルを残しません
- ファイルはストリームで保存し、応答は `{path, name, size, contentType}` だけです（ファイルの中身は応答に含みません）。`contentType` はダウンロード時の値で、HTML・SVG などブラウザが実行しうる種類はサーバーが `application/octet-stream` として返します
- 存在しない添付は `ATTACHMENT_NOT_FOUND`、存在しないルームは `ROOM_NOT_FOUND` です。ファイルモードでは `VALIDATION_ERROR` になります

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

# ファイルモードのテストだけ / クラウドモードのテストだけ
npm run test:file
npm run test:cloud
```

`npm test` は vitest の 4 つのプロジェクトを次の順で実行します（クラウドとファイルは同時には走らせません）。

1. `cloud-compat`: `tests/e2e` と `tests/integration` をクラウドモードでもう一度実行
2. `cloud`: `tests/cloud`（WebSocket の保持・再接続・keepalive、ロングポーリングへのフォールバック、無期限待機、添付ファイル、エラーコードの変換、モード切り替え、ファイルモードとの出力の一致、stdio サーバー、テストハーネス）
3. `file`: 既存のテスト一式（ファイルモード）と `file-concurrency`: ファイルモードの JSON ファイルへの並行アクセス

クラウドモードのテストは本物の API（[agora](https://github.com/mkXultra/agora)）を `wrangler dev` で起動して行います。
`AGORA_DIR`（既定 `../agora`）に agora をチェックアウトして `npm install` しておいてください。
agora が使う wrangler 4.x は Node.js 22 以上でしか起動しないため、クラウドモードのテストは Node.js 22 以上で実行してください（それより古いとテストはその旨のエラーで失敗します）。
テストは空いているポートと一時ディレクトリ（`--persist-to`）を使うので、並行して実行しても衝突しません。
`AGORA_DIR` が無い場合、クラウドモードのテストはスキップされずに失敗します。agora を用意できない環境では `npm run test:file` を使ってください。

```bash
AGORA_DIR=/path/to/agora npm run test:cloud
```

CI（`.github/workflows/ci.yml`）はファイルモードのテストだけを実行します。クラウドモードのテストは agora（private リポジトリ）の `wrangler dev` が必要なため、ローカルで `AGORA_DIR=../agora npm test` として実行してください。

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
    ├── ファイルモード: 機能モジュール (src/features/) + LockService
    │     ├── messaging/
    │     ├── rooms/
    │     └── management/
    └── クラウドモード: HTTP / WebSocket クライアント (src/cloud/) → Agent Communication Cloud
```

### データ構造（ファイルモード）

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
- メッセージサイズが制限内（最大2000文字）か確認してください

## ライセンス

MIT License

## 貢献

プルリクエストを歓迎します。大きな変更の場合は、まずissueを作成して変更内容について議論してください。

## サポート

問題が発生した場合は、GitHubのissueトラッカーに報告してください。