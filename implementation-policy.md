# Agent Communication MCP Server 実装方針ドキュメント

## 概要
本ドキュメントは、実装の簡単さとユニットテストの作成しやすさを最優先とした技術的決定事項をまとめたものです。

## 技術的決定事項

### 1. エラーハンドリング方針

**決定：カスタムエラークラス継承方式を採用**

理由：
- `instanceof`でエラー種別を判定でき、テストが書きやすい
- スタックトレースが自動的に含まれる
- TypeScriptの型推論が効く

```typescript
// 基底エラークラス
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

// 具体的なエラークラス
export class RoomNotFoundError extends AppError {
  constructor(roomName: string) {
    super(`Room '${roomName}' not found`, 'ROOM_NOT_FOUND', 404);
  }
}
```

**MCPプロトコルへの変換：**
```typescript
// シンプルな変換関数
export function toMCPError(error: AppError) {
  return {
    code: error.statusCode,
    message: error.message,
    data: { errorCode: error.code }
  };
}
```

### 2. 非同期処理の統一方針

**決定：Promise/async-awaitのみ使用**

理由：
- コードがシンプルで読みやすい
- try-catchでエラーハンドリングが統一的
- Jestでのテストが簡単（async/awaitをそのまま使える）

```typescript
// 統一的な非同期処理パターン
async function performOperation(): Promise<Result> {
  try {
    const data = await readFile();
    return processData(data);
  } catch (error) {
    throw new AppError('Operation failed', 'OPERATION_ERROR');
  }
}
```

### 3. データバリデーション範囲

**決定：入力時（MCPツールパラメータ）のみでバリデーション**

理由：
- バリデーションロジックが一箇所に集約される
- パフォーマンスが良い
- テストケースがシンプル

```typescript
// MCPツール入力のzodスキーマ例
export const sendMessageSchema = z.object({
  agentName: z.string().min(1).max(50),
  roomName: z.string().regex(/^[a-zA-Z0-9-_]+$/),
  message: z.string().min(1).max(1000)
});
```

### 4. 命名規則

**決定：TypeScriptの標準的な慣例に従う**

- インターフェース：プレフィックスなし（`Room`、`Message`）
- エラークラス：`Error`サフィックス（`RoomNotFoundError`）
- 定数：UPPER_SNAKE_CASE（`MAX_MESSAGE_LENGTH`）
- 関数・変数：camelCase（`getUserCount`）
- ファイル名：PascalCaseまたはkebab-case（用途による）

### 5. ロギング方針

**決定：構造化ログ（JSON形式）を採用**

理由：
- テストでログ内容を検証しやすい
- ログ解析ツールで処理しやすい
- 必要な情報を確実に記録できる

```typescript
// シンプルなロガー実装
export class Logger {
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: any) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...meta
    };
    console.log(JSON.stringify(entry));
  }
}
```

## テスト戦略

### ユニットテストの基本方針

1. **モックの使用を最小限に**
   - ファイルシステムのみモック化
   - ビジネスロジックは実際のコードを使用

2. **テストケースの構造**
   ```typescript
   describe('RoomService', () => {
     describe('createRoom', () => {
       it('should create a new room successfully', async () => {
         // Arrange
         const roomName = 'test-room';
         
         // Act
         const result = await service.createRoom(roomName);
         
         // Assert
         expect(result).toEqual({ success: true, roomName });
       });
       
       it('should throw RoomAlreadyExistsError', async () => {
         // エラーケースのテスト
         await expect(service.createRoom('existing')).rejects.toThrow(RoomAlreadyExistsError);
       });
     });
   });
   ```

3. **テストデータの管理**
   - テスト用のフィクスチャをJSON形式で用意
   - 各テストは独立して実行可能

## ディレクトリ構造の詳細

```
src/
├── errors/
│   ├── AppError.ts          # 基底エラークラス
│   └── index.ts             # 各種エラークラスのエクスポート
├── schemas/
│   ├── room.schema.ts       # ルーム関連のzodスキーマ
│   ├── message.schema.ts    # メッセージ関連のzodスキーマ
│   └── index.ts
├── types/
│   ├── room.types.ts        # ルーム関連の型定義
│   ├── message.types.ts     # メッセージ関連の型定義
│   └── index.ts
└── utils/
    ├── logger.ts            # ロガー実装
    └── validator.ts         # バリデーションヘルパー
```

## コーディング規約

1. **関数は単一責任の原則に従う**
2. **早期リターンでネストを減らす**
3. **型注釈は必須（any禁止）**
4. **コメントは「なぜ」を説明（「何を」は不要）**

この方針により、シンプルで理解しやすく、テストしやすいコードベースを実現します。