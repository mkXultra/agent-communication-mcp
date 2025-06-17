# Agent Communication MCP Server - Management Features API

## Overview

The Management Feature provides system monitoring and administration capabilities for the Agent Communication MCP Server. It enables comprehensive status monitoring, room statistics collection, and message management operations, fully compliant with spec.md (lines 151-180) and following implementation-policy.md guidelines.

## Architecture

```
src/features/management/
├── index.ts                    # Public API exports
├── ManagementService.ts        # Main management service
├── DataScanner.ts             # Directory scanning functionality
├── StatsCollector.ts          # Statistics collection
├── management.schema.ts       # Zod validation schemas
├── types/
│   └── management.types.ts    # TypeScript type definitions
└── tools/
    └── management.tools.ts    # MCP tool definitions
```

## Key Features

### 1. System Status Monitoring

Retrieves system-wide or room-specific statistics and monitoring data.

```typescript
import { IManagementAPI } from './src/features/management';

const api: IManagementAPI = new ManagementService();

// System-wide statistics
const systemStatus = await api.getStatus();

// Specific room statistics  
const roomStatus = await api.getStatus('room-name');
```

**Response Structure:**
- `totalRooms`: Total number of rooms
- `totalOnlineUsers`: Total online users across all rooms
- `totalMessages`: Total message count across all rooms
- `rooms`: Array of detailed per-room statistics

### 2. Room Message Management

Clears all messages from a specified room with safety confirmation.

```typescript
// confirm=true is required for safety
const result = await api.clearRoomMessages('room-name', true);
```

**Safety Features:**
- Explicit `confirm: true` parameter required
- Throws `ValidationError` if `confirm: false` or omitted
- Returns cleared message count for verification

### 3. システムメトリクス

```typescript
const metrics = await api.getSystemMetrics();
// returns: { totalStorageSize: number, mostActiveRoom: RoomStats | null }
```

## MCP ツール

### agent_communication/get_status

**パラメータ:**
- `roomName?: string` - 特定ルームの統計（省略時はシステム全体）

**レスポンス例:**
```json
{
  "rooms": [
    {
      "name": "general",
      "onlineUsers": 3,
      "totalMessages": 150,
      "storageSize": 15420
    }
  ],
  "totalRooms": 1,
  "totalOnlineUsers": 3,
  "totalMessages": 150
}
```

### agent_communication/clear_room_messages

**パラメータ:**
- `roomName: string` - ルーム名（必須）
- `confirm: boolean` - 確認フラグ（必須、trueのみ受け付け）

**レスポンス例:**
```json
{
  "success": true,
  "roomName": "general",
  "clearedCount": 150
}
```

## データ構造

### SystemStatus
```typescript
interface SystemStatus {
  rooms: RoomStats[];
  totalRooms: number;
  totalOnlineUsers: number;
  totalMessages: number;
}
```

### RoomStats
```typescript
interface RoomStats {
  name: string;
  onlineUsers: number;
  totalMessages: number;
  storageSize: number; // バイト単位
}
```

### ClearResult
```typescript
interface ClearResult {
  success: boolean;
  roomName: string;
  clearedCount: number;
}
```

## エラーハンドリング

実装方針（implementation-policy.md）に準拠したカスタムエラークラスを使用：

```typescript
// ルームが存在しない場合
throw new RoomNotFoundError(roomName);

// 確認フラグが不正な場合
throw new ValidationError('confirm', 'Confirmation required');

// ストレージ操作失敗
throw new StorageError('Failed to read room data', details);
```

## ファイル操作の詳細

### データソース
- `data/rooms.json` - ルーム一覧とメタデータ
- `data/rooms/{roomName}/messages.jsonl` - メッセージデータ
- `data/rooms/{roomName}/presence.json` - ユーザープレゼンス情報

### スキャン動作
- **メッセージ数**: `.jsonl`ファイルの行数をカウント
- **オンラインユーザー数**: `presence.json`で`online: true`のユーザー数
- **ストレージサイズ**: `messages.jsonl`ファイルのバイト数

### エラー処理
- 存在しないファイル → 0として扱う
- 破損したJSONファイル → デフォルト値（0/空オブジェクト）
- 権限エラー → `StorageError` をthrow

## パフォーマンス特性

### メモリ効率
- 大きなファイルはストリーミング処理
- ファイル全体をメモリに読み込まない
- 行数カウントは逐次読み込み

### 処理時間目安
- 小規模ルーム（〜1000メッセージ）: < 100ms
- 中規模ルーム（〜10000メッセージ）: < 500ms
- 大規模ルーム（〜100000メッセージ）: < 2000ms

## 使用例

### 基本的な統計収集
```typescript
import { ManagementAPI } from './src/features/management';

const management = new ManagementAPI('./data');

// 全体統計
const status = await management.getSystemStatus();
console.log(`総ルーム数: ${status.totalRooms}`);
console.log(`総オンラインユーザー: ${status.totalOnlineUsers}`);

// ルーム別統計
for (const room of status.rooms) {
  console.log(`${room.name}: ${room.totalMessages}メッセージ, ${room.onlineUsers}オンライン`);
}
```

### メッセージクリア
```typescript
try {
  const result = await management.clearRoomMessages('old-room', true);
  console.log(`${result.clearedCount}件のメッセージを削除しました`);
} catch (error) {
  if (error instanceof ValidationError) {
    console.error('確認が必要です');
  } else if (error instanceof RoomNotFoundError) {
    console.error('ルームが見つかりません');
  }
}
```

### システムメトリクス監視
```typescript
const metrics = await management.getSystemMetrics();
console.log(`総ストレージ使用量: ${metrics.totalStorageSize} bytes`);

if (metrics.mostActiveRoom) {
  console.log(`最もアクティブなルーム: ${metrics.mostActiveRoom.name}`);
}
```

## テスト

### 単体テスト
- `ManagementService.test.ts` - サービスロジック
- `DataScanner.test.ts` - ファイルスキャン機能
- `StatsCollector.test.ts` - 統計計算

### 統合テスト
- `stats-accuracy.test.ts` - 統計精度の検証
- `stats-accuracy-verification.test.ts` - 包括的な精度検証

### カバレッジ目標
- 単体テスト: 90%以上
- 統合テスト: 主要フローの完全カバー

## セキュリティ考慮事項

- パスインジェクション防止（正規表現によるルーム名検証）
- アトミックファイル操作（削除の安全性）
- 明示的確認によるデータ損失防止