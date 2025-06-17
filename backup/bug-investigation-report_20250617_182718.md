# Bug Investigation Report: Lock File Creation Errors

## 問題の概要

MCPサーバーで以下の2つのエラーが発生しています：

1. **初回のルーム作成時**: `data/rooms.json.lock`ファイルが存在しないエラー
2. **ルームへの入室時**: `data/rooms/test-room/presence.json.lock`ファイルが存在しないエラー

これらのエラーは、ロックファイルを作成しようとする際に、親ディレクトリが存在しないことが原因です。

## 原因の詳細

### 根本原因
LockService.tsの`acquireFileLock`メソッド（62-96行目）において、ロックファイルを作成する前に親ディレクトリの存在を確認・作成する処理がありません。

```typescript
// LockService.ts:69行目
await fs.writeFile(lockFilePath, process.pid.toString(), { flag: 'wx' });
```

このコードは、`lockFilePath`の親ディレクトリが既に存在することを前提としていますが、初回実行時やルーム作成時にはディレクトリが存在しない可能性があります。

### エラー発生の流れ

1. **rooms.json.lockエラー**:
   - RoomsAdapter.tsが`listRooms`や`createRoom`を実行
   - LockService.withLock('rooms.json', ...)を呼び出し
   - LockServiceが`data/rooms.json.lock`を作成しようとする
   - `data/`ディレクトリが存在しないため、ENOENTエラーが発生

2. **presence.json.lockエラー**:
   - RoomsAdapter.tsが`enterRoom`を実行
   - LockService.withLock('rooms/{roomName}/presence.json', ...)を呼び出し
   - LockServiceが`data/rooms/{roomName}/presence.json.lock`を作成しようとする
   - `data/rooms/{roomName}/`ディレクトリが存在しないため、ENOENTエラーが発生

## 影響を受けるファイルと関数

### 主要な修正対象
- **src/services/LockService.ts**
  - `acquireFileLock`メソッド（62-96行目）

### 関連ファイル
- **src/adapters/RoomsAdapter.ts**
  - ロック処理を呼び出す各メソッド
- **src/adapters/MessagingAdapter.ts**
  - 同様にロック処理を使用
- **src/adapters/ManagementAdapter.ts**
  - 同様にロック処理を使用

## 推奨される修正方法

### 方針
LockService.tsの`acquireFileLock`メソッドで、ロックファイルを作成する前に親ディレクトリを確実に作成するように修正します。

### メリット
- すべてのロック処理で一元的に解決
- 既存のStorageクラスの`ensureDataDirectory`や`ensureRoomDirectory`メソッドとは独立して動作
- 他のファイルの修正が不要

## 具体的な修正箇所とコード例

### src/services/LockService.ts の修正

```typescript
/**
 * Acquire file system lock using lock file
 */
private async acquireFileLock(filePath: string): Promise<void> {
  const lockFilePath = `${filePath}.lock`;
  const startTime = Date.now();
  
  // ロックファイルの親ディレクトリを確保
  const lockFileDir = path.dirname(lockFilePath);
  try {
    await fs.mkdir(lockFileDir, { recursive: true });
  } catch (error: any) {
    if (error.code !== 'EEXIST') {
      throw new AppError(`Failed to create lock directory: ${error.message}`, 'LOCK_DIR_ERROR', 500);
    }
  }
  
  while (Date.now() - startTime < this.lockTimeout) {
    try {
      // Try to create lock file exclusively
      await fs.writeFile(lockFilePath, process.pid.toString(), { flag: 'wx' });
      return; // Successfully acquired lock
    } catch (error: any) {
      if (error.code === 'EEXIST') {
        // Lock file exists, check if it's stale
        const isStale = await this.isLockStale(lockFilePath);
        if (isStale) {
          // Remove stale lock and try again
          try {
            await fs.unlink(lockFilePath);
            continue;
          } catch {
            // Someone else might have removed it, continue
          }
        }
        
        // Wait before retry
        await this.sleep(LockService.RETRY_INTERVAL);
        continue;
      } else if (error.code === 'ENOENT') {
        // ディレクトリが作成されたにも関わらずENOENTが発生した場合は再試行
        continue;
      } else {
        // Some other error occurred
        throw new AppError(`Failed to acquire lock: ${error.message}`, 'LOCK_ERROR', 500);
      }
    }
  }
  
  throw new LockTimeoutError(filePath, this.lockTimeout);
}
```

### 必要なインポートの追加
ファイルの先頭に以下のインポートを追加：

```typescript
import path from 'path';
```

（既に2行目にインポート済みなので追加不要）

## テストケース

修正後、以下のケースでテストを実施する必要があります：

1. **初回実行時のテスト**
   - dataディレクトリが存在しない状態で`create_room`を実行
   - 正常にルームが作成されることを確認

2. **並行アクセステスト**
   - 複数のプロセスから同時にロックを取得
   - 適切にロックが機能することを確認

3. **エラーリカバリーテスト**
   - ロックファイルが残っている状態での動作確認
   - staleロックの自動削除機能の確認

## まとめ

この修正により、MCPサーバーの初回実行時やルーム作成時のエラーが解消され、より堅牢なファイルロック機構が実現されます。修正は最小限で、既存のコードへの影響も限定的です。