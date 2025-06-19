# Home Directory Default Implementation Investigation Report

## 調査概要

Agent Communication MCP Serverにおけるデータディレクトリのデフォルト値実装に関する包括的な調査を実施しました。現在の実装（`./data`）から、より適切なホームディレクトリベースの実装への移行について分析しています。

## 1. 現状の問題点詳細分析

### 1.1 現在のデフォルト値 './data' の使用箇所

調査の結果、25箇所で`./data`または`AGENT_COMM_DATA_DIR`環境変数が使用されています：

#### コアサービス層
1. **src/index.ts:21** - メインエントリーポイントでの初期化
   ```typescript
   const dataDir = process.env.AGENT_COMM_DATA_DIR || './data';
   ```

2. **src/services/LockService.ts:18** - ファイルロックサービス
   ```typescript
   private readonly dataDir: string = process.env.AGENT_COMM_DATA_DIR || './data'
   ```

#### ストレージ層
3. **src/features/rooms/room/RoomStorage.ts:13** - ルーム情報管理
   ```typescript
   constructor(dataDir: string = './data')
   ```

4. **src/features/rooms/presence/PresenceStorage.ts:13** - プレゼンス情報管理
   ```typescript
   constructor(dataDir: string = './data')
   ```

5. **src/features/messaging/MessageStorage.ts:9** - メッセージストレージ
   ```typescript
   constructor(dataDir: string = './data')
   ```

6. **src/features/management/DataScanner.ts:8** - データスキャナー
   ```typescript
   constructor(dataDir: string = './data')
   ```

#### アダプター層
7. **src/adapters/RoomsAdapter.ts:21** - ルームアダプター
   ```typescript
   const dataDir = process.env.AGENT_COMM_DATA_DIR || './data';
   ```

### 1.2 相対パスによる問題点

現在の実装における主要な問題点：

1. **実行ディレクトリ依存性**
   - アプリケーションの実行場所によってデータ保存先が変わる
   - `cd /tmp && npx agent-communication-mcp` と `cd ~ && npx agent-communication-mcp` で異なる場所にデータが保存される

2. **権限問題**
   - システムディレクトリから実行した場合、書き込み権限がない可能性
   - 例：`/usr/local/bin`から実行時に`./data`への書き込みが失敗

3. **データの一貫性欠如**
   - 同じユーザーでも実行場所によって異なるデータセットを参照
   - エージェント間の通信が分断される可能性

4. **予期しない場所へのデータ作成**
   - ユーザーが意図しない場所に`data`ディレクトリが作成される
   - クリーンアップが困難

### 1.3 os.homedir() の利用可能性

- Node.jsの`os`モジュールは標準モジュールとして利用可能
- 現在のコードベースでは、テストファイル（`FileLock.test.ts`）で`os.tmpdir()`を使用している例あり
- 本番コードでは`os`モジュールは未使用

## 2. 変更による影響範囲

### 2.1 直接影響を受けるコンポーネント

#### 必須変更箇所（6箇所）
- `src/index.ts` - メインエントリーポイント
- `src/services/LockService.ts` - ロックサービス
- `src/features/rooms/room/RoomStorage.ts` - ルームストレージ
- `src/features/rooms/presence/PresenceStorage.ts` - プレゼンスストレージ
- `src/features/messaging/MessageStorage.ts` - メッセージストレージ
- `src/features/management/DataScanner.ts` - データスキャナー

#### 間接的影響（アダプター層）
- `src/adapters/RoomsAdapter.ts`
- `src/adapters/MessagingAdapter.ts`
- `src/adapters/ManagementAdapter.ts`

### 2.2 テストへの影響

1. **統合テスト**
   - `tests/integration/setup.ts` - テスト環境のセットアップ
   - 環境変数`AGENT_COMM_DATA_DIR`を使用してテストデータディレクトリを設定

2. **E2Eテスト**
   - `tests/e2e/mcp-server.test.ts`
   - テスト用の隔離された環境が必要

### 2.3 既存ユーザーへの影響（後方互換性）

1. **破壊的変更**
   - デフォルトのデータ保存場所が変更される
   - 既存の`./data`に保存されたデータへのアクセスが失われる

2. **環境変数を使用しているユーザー**
   - `AGENT_COMM_DATA_DIR`を明示的に設定しているユーザーは影響なし

## 3. 解決策の提案

### 解決策1: 単純なホームディレクトリ移行

**実装内容**
```typescript
import os from 'os';
const DEFAULT_DATA_DIR = path.join(os.homedir(), '.agent-communication-mcp');
const dataDir = process.env.AGENT_COMM_DATA_DIR || DEFAULT_DATA_DIR;
```

**メリット**
- 実装が簡単
- 一貫したデータ保存場所
- ユーザーのホームディレクトリ内で管理しやすい

**デメリット**
- 既存データの手動移行が必要
- 後方互換性なし

### 解決策2: 段階的移行アプローチ

**実装内容**
```typescript
import os from 'os';

function getDataDirectory(): string {
  // 1. 環境変数を最優先
  if (process.env.AGENT_COMM_DATA_DIR) {
    return process.env.AGENT_COMM_DATA_DIR;
  }
  
  // 2. 既存の./dataが存在し、書き込み可能なら使用（後方互換性）
  const legacyPath = './data';
  if (fs.existsSync(legacyPath) && isWritable(legacyPath)) {
    console.warn('Using legacy data directory ./data. Consider migrating to ~/.agent-communication-mcp');
    return legacyPath;
  }
  
  // 3. 新しいデフォルト：ホームディレクトリ
  return path.join(os.homedir(), '.agent-communication-mcp');
}
```

**メリット**
- 既存ユーザーへの影響を最小化
- 段階的な移行が可能
- 警告メッセージで移行を促進

**デメリット**
- 実装がやや複雑
- レガシーサポートのメンテナンスコスト

### 解決策3: マイグレーションツール付き移行

**実装内容**
```typescript
// 新しいデフォルトディレクトリ
const DEFAULT_DATA_DIR = path.join(os.homedir(), '.agent-communication-mcp');

// マイグレーションコマンド
class DataMigration {
  async migrate(from: string = './data', to: string = DEFAULT_DATA_DIR) {
    if (!fs.existsSync(from)) {
      console.log('No legacy data found');
      return;
    }
    
    if (fs.existsSync(to)) {
      throw new Error('Target directory already exists');
    }
    
    // データの移行
    await fs.promises.cp(from, to, { recursive: true });
    console.log(`Data migrated from ${from} to ${to}`);
  }
}
```

**メリット**
- 自動化されたデータ移行
- ユーザーフレンドリー
- 確実な移行プロセス

**デメリット**
- 追加開発が必要
- マイグレーションツールのテストが必要

## 4. 推奨される実装方針

### 4.1 推奨解決策：解決策2（段階的移行アプローチ）

最も現実的でユーザーフレンドリーなアプローチとして、段階的移行を推奨します。

### 4.2 具体的な実装手順

#### ステップ1: ユーティリティ関数の作成
`src/utils/dataDir.ts`を新規作成：
```typescript
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, accessSync, constants } from 'fs';

export const DEFAULT_HOME_DATA_DIR = join(homedir(), '.agent-communication-mcp');
export const LEGACY_DATA_DIR = './data';

export function getDataDirectory(): string {
  // 環境変数が設定されている場合は最優先
  if (process.env.AGENT_COMM_DATA_DIR) {
    return process.env.AGENT_COMM_DATA_DIR;
  }
  
  // レガシーディレクトリの確認
  if (existsSync(LEGACY_DATA_DIR)) {
    try {
      accessSync(LEGACY_DATA_DIR, constants.W_OK);
      console.warn(
        `Warning: Using legacy data directory "${LEGACY_DATA_DIR}". ` +
        `Consider setting AGENT_COMM_DATA_DIR="${DEFAULT_HOME_DATA_DIR}" ` +
        `and migrating your data.`
      );
      return LEGACY_DATA_DIR;
    } catch {
      // 書き込み権限がない場合は新しいデフォルトを使用
    }
  }
  
  return DEFAULT_HOME_DATA_DIR;
}
```

#### ステップ2: 各コンポーネントの更新

**src/index.ts**の更新：
```typescript
import { getDataDirectory } from './utils/dataDir.js';

// Before: const dataDir = process.env.AGENT_COMM_DATA_DIR || './data';
const dataDir = getDataDirectory();
```

**src/services/LockService.ts**の更新：
```typescript
import { getDataDirectory } from '../utils/dataDir.js';

constructor(
  private readonly dataDir: string = getDataDirectory(),
  private readonly lockTimeout: number = parseInt(process.env.AGENT_COMM_LOCK_TIMEOUT || '5000')
) {}
```

同様に他のストレージクラスも更新。

### 4.3 テストの更新

テスト環境では環境変数を使用して隔離：
```typescript
// tests/integration/setup.ts
export function setupTestEnv(dataDir?: string): void {
  process.env.AGENT_COMM_DATA_DIR = dataDir || testDataDir;
  // ... 他の環境変数設定
}
```

### 4.4 ドキュメントの更新

1. **README.md**の更新
   - デフォルトのデータディレクトリが`~/.agent-communication-mcp`に変更されたことを明記
   - 移行手順の追加

2. **CLAUDE.md**の更新
   - 環境変数セクションの更新

3. **CHANGELOG.md**の作成
   - 破壊的変更の記録
   - 移行ガイドへのリンク

## 5. リスクと対策

### リスク1: データ損失
**対策**: 明確な移行ドキュメントと警告メッセージ

### リスク2: 権限エラー
**対策**: ホームディレクトリの書き込み権限チェックとフォールバック

### リスク3: パフォーマンス低下
**対策**: ディレクトリ存在チェックのキャッシング

## 6. 実装スケジュール案

1. **Phase 1** (1日): ユーティリティ関数の実装とテスト
2. **Phase 2** (1日): コアコンポーネントの更新
3. **Phase 3** (1日): テストの更新と実行
4. **Phase 4** (0.5日): ドキュメントの更新
5. **Phase 5** (0.5日): リリース準備

## まとめ

現在の`./data`デフォルトは、実行ディレクトリ依存性による多くの問題を抱えています。提案した段階的移行アプローチにより、既存ユーザーへの影響を最小化しながら、より堅牢なホームディレクトリベースの実装に移行できます。

セッションID: `homedir-investigation-2025-01-19`