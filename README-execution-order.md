# Agent Communication MCP Server 実装コマンド実行順序

## 概要
すでにプロジェクトの基本設定（npm init、TypeScript設定、インターフェース定義）が完了している前提での実行順序です。

## 実行順序

### 1. エージェントA、B、Cを並列実行（最初に開始）

3つの別々のターミナルで同時に実行：

```bash
# ターミナル1：メッセージング機能
./tasks/continue-task.sh agent-a-messaging

# ターミナル2：ルーム・プレゼンス機能
./tasks/continue-task.sh agent-b-rooms

# ターミナル3：管理機能
./tasks/continue-task.sh agent-c-management
```

### 2. 進捗監視

別のターミナルで各エージェントの完了状態を監視：

```bash
# 完了状態を定期的に確認
watch -n 10 'echo "=== 完了状態 ===" && head -n 1 agent-*-review.txt'

# または各ログファイルを個別に監視
tail -f agent-a-messaging.log
tail -f agent-b-rooms.log
tail -f agent-c-management.log
```

### 3. エージェントDで統合（A、B、C完了後）

すべてのエージェントが「COMPLETED」になったことを確認してから実行：

```bash
# 完了確認
grep "COMPLETED" agent-a-messaging-review.txt
grep "COMPLETED" agent-b-rooms-review.txt
grep "COMPLETED" agent-c-management-review.txt

# 統合実行
./tasks/continue-task.sh agent-d-integration
```

### 4. 最終確認

```bash
# エージェントDの完了確認
grep "COMPLETED" agent-d-integration-review.txt

# MCPサーバーの起動テスト
npm run dev
```

## タイムライン（目安）

1. **0分**: エージェントA、B、C同時開始
2. **60-90分**: 各機能実装完了
3. **90分**: エージェントD開始（統合作業）
4. **120-150分**: 全体完成

## 依存関係

```
エージェントA ─┐
エージェントB ─┼─→ エージェントD（統合）
エージェントC ─┘
```

- エージェントA、B、Cは相互に独立
- エージェントDはA、B、Cの完了が前提

## 注意事項

1. **並列実行の利点**
   - 3つの機能を同時に開発
   - 全体の開発時間を短縮

2. **セッションIDの管理**
   - 各タスクのセッションIDはログファイルに記録
   - 中断時は記録されたセッションIDで再開

3. **エラー対処**
   - レビューファイルで未実装項目を確認
   - 必要に応じて手動修正後、セッションIDで継続

4. **統合タイミング**
   - A、B、Cすべてが完了してからDを実行
   - 部分的な統合は避ける

## トラブルシューティング

### A、B、Cのいずれかが失敗した場合
```bash
# レビューファイルで原因確認
cat agent-[a|b|c]-*-review.txt

# セッションIDで継続
./tasks/continue-task.sh agent-[a|b|c]-* <セッションID>
```

### 統合時にエラーが発生した場合
```bash
# エージェントDのログ確認
tail -100 agent-d-integration.log

# 各機能の公開APIが存在するか確認
ls -la src/features/*/index.ts
```