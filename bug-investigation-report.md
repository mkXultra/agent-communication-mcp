# バグ調査レポート

## 問題の概要

ルームを作成して入室した後、メッセージを送信しようとすると「Room 'bug-fix-test' not found」エラーが発生する。list_roomsやlist_room_usersでは正常にルームとユーザーが確認できるにも関わらず、send_messageでルームが見つからないというエラーが発生している。

## 原因の詳細

問題の根本原因は、**MessageServiceが独立したmockRoomCheckerを使用しており、実際のルーム管理システムと連携していない**ことにある。

### 具体的な問題点：

1. **MessageService**（src/features/messaging/MessageService.ts）は、ルームの存在確認に**MockRoomChecker**を使用している（28行目）
2. **MockRoomChecker**（src/features/messaging/mockRoomChecker.ts）は、ハードコードされた3つのルーム（'general', 'test-room', 'development'）のみを認識する（6行目）
3. 新しく作成されたルームは、RoomServiceで管理されているが、MockRoomCheckerには反映されない
4. そのため、実際に存在するルームでもメッセージ送信時に「ルームが見つからない」エラーが発生する

### データフローの不整合：

- **ルーム作成**: RoomsAdapter → RoomsAPI → RoomService → RoomStorage（実際のファイルシステム）
- **メッセージ送信**: MessagingAdapter → MessageService → **MockRoomChecker（ハードコードされたデータ）**

## 影響を受けるファイルと関数

### 主要な影響を受けるファイル：

1. **src/features/messaging/MessageService.ts**
   - `sendMessage()` メソッド（23-61行目）
   - `getMessages()` メソッド（63-91行目）
   - `getMessageCount()` メソッド（93-102行目）

2. **src/features/messaging/mockRoomChecker.ts**
   - 全体（このファイル自体が問題の原因）

3. **src/adapters/MessagingAdapter.ts**
   - `sendMessage()` メソッド（25-60行目）- すでにroomsAdapterでチェックしているが、MessageServiceでも重複してチェックされている
   - `getMessages()` メソッド（62-98行目）- 同様の問題

## 推奨される修正方法

### 方法1: MockRoomCheckerを削除し、実際のRoomServiceを使用（推奨）

MessageServiceが実際のRoomServiceを使用するように修正する。これにより、すべてのコンポーネントが同じルームデータを参照するようになる。

### 方法2: MessagingAdapterでの重複チェックを活用

MessagingAdapterですでにルーム存在チェックとユーザー参加チェックを行っているため、MessageService内でのMockRoomCheckerによるチェックを削除する。

## 具体的な修正箇所とコード例

### 修正1: MessageServiceからMockRoomCheckerの使用を削除

**src/features/messaging/MessageService.ts**の修正：

```typescript
import { MessageStorage } from './MessageStorage';
import { MessageValidator } from './MessageValidator';
import { MessageCache } from './MessageCache';
// import { MockRoomChecker } from './mockRoomChecker'; // 削除
import { generateUUID } from './utils';
import {
  SendMessageParams,
  SendMessageResponse,
  GetMessagesParams,
  MessageListResponse,
  MessageStorageData
} from './types/messaging.types';

export class MessageService {
  private readonly storage: MessageStorage;
  private readonly cache: MessageCache;

  constructor(dataDir?: string, cacheCapacity?: number) {
    this.storage = new MessageStorage(dataDir);
    this.cache = new MessageCache(cacheCapacity);
  }

  async sendMessage(params: SendMessageParams): Promise<SendMessageResponse> {
    // Validate input parameters
    const validatedParams = MessageValidator.validateSendMessage(params);
    
    // MockRoomChecker.ensureRoomExists を削除
    // ルームの存在確認はMessagingAdapterで実施済み
    
    // Generate message ID and timestamp
    const messageId = generateUUID();
    const timestamp = new Date().toISOString();
    
    // 以下同じ...
  }

  async getMessages(params: GetMessagesParams): Promise<MessageListResponse> {
    // Validate input parameters
    const validatedParams = MessageValidator.validateGetMessages(params);
    
    // MockRoomChecker.ensureRoomExists を削除
    // ルームの存在確認はMessagingAdapterで実施済み
    
    // Check cache first
    const cachedResult = this.cache.get(validatedParams);
    // 以下同じ...
  }

  async getMessageCount(roomName: string): Promise<number> {
    // Validate room name
    MessageValidator.validateGetMessages({ roomName });
    
    // MockRoomChecker.ensureRoomExists を削除
    // ルームの存在確認は呼び出し元で実施
    
    return await this.storage.getMessageCount(roomName);
  }
}
```

### 修正2: mockRoomChecker.tsファイルの削除

`src/features/messaging/mockRoomChecker.ts`ファイルを削除する。

### 修正3: インポートの整理

MockRoomCheckerを使用している他のファイルがあれば、そのインポートも削除する必要がある。

### 注意点：

1. この修正により、ルームの存在確認は各アダプター層（MessagingAdapter）で一元的に管理されるようになる
2. MessageServiceは純粋にメッセージの保存・取得のビジネスロジックに集中できる
3. 各層の責任が明確になり、データの整合性が保たれる

この修正を適用することで、新しく作成されたルームでも正常にメッセージの送受信が可能になります。