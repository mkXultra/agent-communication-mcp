# Messaging機能 API ドキュメント

Agent Communication MCP Serverのメッセージング機能の実装です。ルーム間でのメッセージ送受信、メンション、ページネーションをサポートしています。

## 概要

このモジュールは以下の機能を提供します：

- **メッセージ送信**: エージェント間でのメッセージ送信
- **メッセージ取得**: ページネーション対応のメッセージ取得
- **メンション機能**: `@agentName`形式でのメンション抽出
- **永続化**: JSONLファイルでのメッセージ保存
- **バリデーション**: Zodスキーマによる入力検証

## API 使用方法

### 基本的な使用例

```typescript
import { MessagingAPI } from './src/features/messaging';

const messagingAPI = new MessagingAPI('./data');

// メッセージ送信
const result = await messagingAPI.sendMessage({
  agentName: 'agent1',
  roomName: 'general',
  message: 'Hello @agent2, how are you?',
  metadata: { priority: 'normal' }
});

// メッセージ取得
const messages = await messagingAPI.getMessages({
  roomName: 'general',
  limit: 10,
  offset: 0
});
```

## MessagingAPI

### sendMessage(params: SendMessageParams): Promise<SendMessageResponse>

メッセージを送信します。

#### パラメータ
- `agentName`: 送信者エージェント名 (1-50文字)
- `roomName`: 送信先ルーム名 (英数字、ハイフン、アンダースコアのみ)
- `message`: メッセージ内容 (1-1000文字)
- `metadata?`: オプショナルメタデータ

#### 戻り値
```typescript
{
  success: boolean;
  messageId: string;     // UUID v4形式
  roomName: string;
  timestamp: string;     // ISO 8601形式
  mentions: string[];    // 抽出されたメンション
}
```

#### 例
```typescript
const response = await messagingAPI.sendMessage({
  agentName: 'alice',
  roomName: 'team-chat',
  message: 'Please review @bob and @charlie',
  metadata: { urgent: true }
});

console.log(response.mentions); // ['bob', 'charlie']
```

### getMessages(params: GetMessagesParams): Promise<MessageListResponse>

ルームからメッセージを取得します。

#### パラメータ
- `roomName`: ルーム名 (必須)
- `agentName?`: エージェント名 (メンションフィルタリング用)
- `limit?`: 取得件数 (デフォルト: 50, 最大: 1000)
- `offset?`: 取得開始位置 (デフォルト: 0)
- `mentionsOnly?`: 自分宛のメンションのみ取得 (デフォルト: false)

#### 戻り値
```typescript
{
  roomName: string;
  messages: Message[];
  count: number;         // 取得されたメッセージ数
  hasMore: boolean;      // さらに古いメッセージがあるか
}
```

#### 例
```typescript
// 基本的な取得
const result = await messagingAPI.getMessages({
  roomName: 'general'
});

// ページネーション
const page2 = await messagingAPI.getMessages({
  roomName: 'general',
  limit: 20,
  offset: 20
});

// メンションのみ取得
const mentions = await messagingAPI.getMessages({
  roomName: 'general',
  agentName: 'alice',
  mentionsOnly: true
});
```

### getMessageCount(roomName: string): Promise<number>

ルーム内のメッセージ総数を取得します。

```typescript
const count = await messagingAPI.getMessageCount('general');
console.log(`Total messages: ${count}`);
```

## MessageService

低レベルAPIとして`MessageService`を直接使用することも可能です。

```typescript
import { MessageService } from './src/features/messaging/MessageService';

const service = new MessageService('./data');
const result = await service.sendMessage(params);
```

## MessageStorage

ストレージ層への直接アクセス：

```typescript
import { MessageStorage } from './src/features/messaging/MessageStorage';

const storage = new MessageStorage('./data');
const result = await storage.getMessages(params);
```

## データ形式

### Message オブジェクト
```typescript
interface Message {
  id: string;           // UUID v4
  agentName: string;    // 送信者
  roomName: string;     // ルーム名
  message: string;      // メッセージ内容
  timestamp: string;    // ISO 8601形式
  mentions: string[];   // メンション配列
  metadata?: Record<string, any>; // オプションメタデータ
}
```

### ストレージ形式

メッセージは`data/rooms/{roomName}/messages.jsonl`に保存されます：

```jsonl
{"id":"123e4567-e89b-42d3-a456-426614174000","agentName":"alice","message":"Hello @bob","timestamp":"2024-01-01T10:00:00.000Z","mentions":["bob"],"metadata":{"priority":"normal"}}
{"id":"223e4567-e89b-42d3-a456-426614174001","agentName":"bob","message":"Hi @alice","timestamp":"2024-01-01T10:01:00.000Z","mentions":["alice"]}
```

## エラーハンドリング

### RoomNotFoundError
```typescript
try {
  await messagingAPI.sendMessage({
    agentName: 'alice',
    roomName: 'nonexistent',
    message: 'Hello'
  });
} catch (error) {
  if (error instanceof RoomNotFoundError) {
    console.log('Room does not exist');
  }
}
```

### StorageError
```typescript
try {
  await messagingAPI.getMessages({ roomName: 'general' });
} catch (error) {
  if (error instanceof StorageError) {
    console.log('Storage operation failed:', error.code);
  }
}
```

### バリデーションエラー
```typescript
try {
  await messagingAPI.sendMessage({
    agentName: '',  // 無効
    roomName: 'general',
    message: 'Hello'
  });
} catch (error) {
  // Zodバリデーションエラー
  console.log('Validation failed:', error.message);
}
```

## パフォーマンス

- **スループット**: 1000メッセージ/秒対応
- **ページネーション**: 大量メッセージでも効率的な取得
- **メンション検索**: 正規表現による高速な抽出
- **ストリーミング**: 大きなファイルの効率的な読み込み

## テスト

```bash
# メッセージング機能のテスト実行
npm run test:messaging

# カバレッジ付きテスト
npm run test:coverage

# パフォーマンステスト
npm run test:messaging -- tests/messaging/performance
```

## 実装詳細

### メンション抽出

正規表現 `/@([a-zA-Z0-9_-]+)/g` を使用してメンションを抽出します：

```typescript
const message = "Hello @alice and @bob-dev";
const mentions = MessageValidator.extractMentions(message);
// ['alice', 'bob-dev']
```

### ファイル構造

```
data/
└── rooms/
    ├── general/
    │   └── messages.jsonl
    ├── development/
    │   └── messages.jsonl
    └── team-chat/
        └── messages.jsonl
```

### 並行性

- ファイルロックは実装されていません（Agent Dで統合時に追加予定）
- 現在は単一プロセスでの利用を想定

## 注意事項

1. **ルーム存在確認**: 現在は`MockRoomChecker`を使用（Agent Bで実装予定）
2. **ファイルロック**: 未実装（Agent Dで追加予定）
3. **キャッシュ**: 基本実装のみ（将来の最適化で拡張予定）

## 今後の拡張

- LRUキャッシュによる高速化
- ファイルロック機構の統合
- リアルタイム通知機能
- メッセージ検索機能
- バルク操作サポート