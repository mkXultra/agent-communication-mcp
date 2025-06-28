# テストスイート競合問題の深い分析

## 問題の根本原因

### 1. 共有リソースによる競合状態 (Race Condition)
すべてのテストが同じ `test-data` ディレクトリを使用しており、Vitestの並列実行により以下の競合が発生：

```
時間軸:
T1: TestA が test-data を削除開始
T2: TestB が test-data/rooms/concurrent-test-room にアクセス試行 → RoomNotFoundError
T3: TestA が test-data を再作成
T4: TestC が test-data を削除開始
T5: TestA が予期しない状態に遭遇
```

### 2. ファイルシステムレベルの競合
- **ディレクトリの削除と作成の競合**: 削除中のディレクトリにアクセス
- **ファイルロックの競合**: LockServiceが同じファイルに対して複数のロックを取得
- **inode の再利用**: 削除直後に同名ディレクトリを作成した際の混乱

### 3. プロセス間通信の問題
- Node.jsのファイルシステム操作は非同期
- OSレベルでのファイル操作完了とNode.jsでの認識にタイムラグ
- 特にWindowsではファイル削除が遅延することがある

## 競合が発生する具体的なシナリオ

### concurrent-access.test.ts の失敗
```typescript
// TestA: setup.ts の beforeEach
await fs.rm(testDataDir, { recursive: true }); // ディレクトリ削除中

// TestB: concurrent-access.test.ts
await roomsAdapter.createRoom({ roomName }); // RoomNotFoundError!
// → test-data/rooms が存在しないため
```

### throughput.test.ts のパフォーマンス低下
```typescript
// 複数テストが同時実行
// → ファイルシステムのI/O競合
// → LockServiceのロック待ち時間増加
// → スループット低下: 472 msgs/sec < 500 msgs/sec
```

## 解決策

### 1. テストごとに独立したディレクトリを使用
```typescript
const testDataDir = path.join(__dirname, `../../test-data-${process.pid}-${Date.now()}`);
```

### 2. Vitestの並列実行を制御
```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true // 並列実行を無効化
      }
    }
  }
});
```

### 3. より堅牢なクリーンアップ
```typescript
beforeEach(async () => {
  // リトライ機構を追加
  for (let i = 0; i < 3; i++) {
    try {
      await fs.rm(testDataDir, { recursive: true, force: true });
      break;
    } catch (error) {
      if (i === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
});
```

### 4. テスト分離の強化
```typescript
// 各テストスイートで独自のポートやディレクトリを使用
const testId = crypto.randomUUID();
const testDataDir = `/tmp/agent-comm-test-${testId}`;
```

## なぜ単独実行では成功するのか

1. **リソース競合がない**: 他のテストが同じディレクトリを操作していない
2. **CPU/I/O リソースが十分**: 並列実行による負荷がない
3. **ファイルロックの競合がない**: LockServiceが単一のテストからのみ使用される

## 結論

この問題は**アプリケーションコードの問題ではなく、テスト環境の設計問題**です。本番環境では：
- 各プロセスは独自のデータディレクトリを使用
- 適切なファイルロックにより競合を防止
- エラーハンドリングが適切に機能

テストの失敗は、テスト環境が本番環境とは異なる極端な競合状態を作り出しているためです。