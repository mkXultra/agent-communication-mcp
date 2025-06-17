# AIエージェント向け：複数エージェントによるバグ修正ワークフロー実行ガイド

## 前提条件

このドキュメントは、Claude Code MCPツール（`mcp__ccm__claude_code`）を使用してバグ修正を実行するAIエージェント向けのガイドです。

## 必要なツール

- `mcp__ccm__claude_code`: エージェント起動
- `mcp__ccm__list_claude_processes`: プロセス監視
- `mcp__ccm__get_claude_result`: 結果取得
- `Read`, `Write`, `Bash`: ファイル操作とコマンド実行

## ワークフロー実行手順

### Phase 0: クリーンアップ（必須）

既存の成果物ファイルを必ずバックアップしてから開始する：

```bash
# 1. バックアップディレクトリを作成
Bash("mkdir -p ./backup")

# 2. 既存ファイルをバックアップ（存在する場合のみ）
Bash('[ -f "bug-investigation-report.md" ] && mv bug-investigation-report.md "./backup/bug-investigation-report_$(date +%Y%m%d_%H%M%S).md"')
Bash('[ -f "code-review-report.md" ] && mv code-review-report.md "./backup/code-review-report_$(date +%Y%m%d_%H%M%S).md"')
```

### Phase 1: バグ調査エージェント起動

ユーザーから提供されたバグ情報を含めて調査エージェントを起動：

```python
# 調査エージェントを起動
result = mcp__ccm__claude_code(
    model="opus",
    workFolder=os.getcwd(),  # 現在の作業ディレクトリを使用
    prompt=f"""
MCPサーバーのバグ調査を実施してください。

## 調査対象のバグ
{user_provided_bug_description}

## 調査手順
1. 関連するソースコードをReadツールで読み込む
2. エラーの根本原因を特定する
3. 影響範囲を分析する
4. 修正方法を具体的に提案する

## 出力要件
結果をbug-investigation-report.mdファイルに以下の形式で出力：

```markdown
# バグ調査レポート

## 問題の概要
[1-2文で問題を要約]

## 原因の詳細
[技術的な原因を説明]

## 影響を受けるファイルと関数
- ファイルパス:行番号 - 関数名
- 例: src/services/LockService.ts:62 - acquireFileLock

## 推奨される修正方法
[修正の方針を説明]

## 具体的な修正箇所とコード例
[修正前後のコードを含める]
```
"""
)

# セッションIDを保存（調査完了後は不要）
investigation_pid = result['pid']
```

### Phase 2: 調査完了待機

```python
# 5分間待機
Bash("sleep 300")

# 結果を取得
investigation_result = mcp__ccm__get_claude_result(pid=investigation_pid)

# 完了確認
if investigation_result['status'] != 'completed':
    # さらに2分待機して再確認
    Bash("sleep 120")
    investigation_result = mcp__ccm__get_claude_result(pid=investigation_pid)

# レポートファイルの存在確認
if not os.path.exists("bug-investigation-report.md"):
    raise Exception("調査レポートが作成されていません")
```

### Phase 3: 実装エージェント起動

調査結果に基づいて修正を実装：

```python
# 実装エージェントを起動
impl_result = mcp__ccm__claude_code(
    model="sonnet",
    workFolder=os.getcwd(),
    prompt="""
bug-investigation-report.mdファイルを読んで、記載されている修正を実装してください。

## 実装手順
1. bug-investigation-report.mdをReadツールで読む
2. 「具体的な修正箇所とコード例」セクションの内容を実装
3. Editツールを使用して該当ファイルを修正
4. 修正後、Bashツールでビルドを実行して構文エラーがないか確認

## 実装後の報告
修正が完了したら、以下を報告してください：
- 修正したファイル名と行番号
- 実際に適用した変更の概要
- ビルド結果（成功/失敗）
"""
)

# 実装エージェントのセッションIDを保存（重要：再利用のため）
IMPLEMENTATION_SESSION_ID = impl_result.get('session_id')
implementation_pid = impl_result['pid']
```

### Phase 4: コードレビューエージェント起動

修正内容をレビュー：

```python
# 実装完了まで待機（3分）
Bash("sleep 180")

# レビューエージェントを起動
review_result = mcp__ccm__claude_code(
    model="opus",
    workFolder=os.getcwd(),
    prompt=f"""
実装された修正をレビューしてください。

## レビュー手順
1. bug-investigation-report.mdを読んで修正内容を理解
2. 修正されたファイルをReadツールで確認
3. 以下の観点でレビュー：
   - 調査レポートの推奨事項に従っているか
   - エラーハンドリングが適切か
   - 新たなバグを生み出していないか
   - コーディング規約に従っているか

## レビュー結果の出力
code-review-report.mdファイルに必ず以下の形式で出力：

1行目: COMPLETED または INCOMPLETE
2行目以降: INCOMPLETEの場合のみ、具体的な指摘事項を箇条書き

例1（完了の場合）:
```
COMPLETED
```

例2（未完了の場合）:
```
INCOMPLETE
- src/services/LockService.ts:72 - エラーメッセージが英語のまま
- src/services/LockService.ts:83 - エラーコードをハードコーディングせず定数化すべき
- ログ出力の追加を検討（デバッグ用）
```
"""
)

# レビューエージェントのセッションIDを保存（重要：再利用のため）
REVIEW_SESSION_ID = review_result.get('session_id')
review_pid = review_result['pid']
```

### Phase 5: レビュー結果確認と修正サイクル

```python
# レビュー完了まで待機（2分）
Bash("sleep 120")

# レビューファイルを読み込んで判定
review_content = Read("code-review-report.md")
review_status = review_content.split('\n')[0].strip()

# 修正サイクルのループ（最大5回）
iteration = 0
while review_status == "INCOMPLETE" and iteration < 5:
    iteration += 1
    
    # 指摘事項を抽出（2行目以降）
    review_issues = '\n'.join(review_content.split('\n')[1:])
    
    # 実装エージェントのセッションを再開して修正
    fix_result = mcp__ccm__claude_code(
        model="sonnet",
        workFolder=os.getcwd(),
        session_id=IMPLEMENTATION_SESSION_ID,  # 重要：セッション再開
        prompt=f"""
レビューで以下の指摘を受けました。修正してください：

{review_issues}

各指摘事項に対して：
1. 該当箇所をEditツールで修正
2. 修正内容を簡潔に報告

すべての指摘事項を確実に対応してください。
"""
    )
    
    # 修正完了まで待機（2分）
    Bash("sleep 120")
    
    # レビューエージェントのセッションを再開して再レビュー
    re_review_result = mcp__ccm__claude_code(
        model="opus",
        workFolder=os.getcwd(),
        session_id=REVIEW_SESSION_ID,  # 重要：セッション再開
        prompt="""
修正が完了しました。再度レビューしてください。

前回指摘した事項がすべて解決されているか確認し、
code-review-report.mdを更新してください。

必ず1行目にCOMPLETEDまたはINCOMPLETEを記載してください。
"""
    )
    
    # 再レビュー完了まで待機（2分）
    Bash("sleep 120")
    
    # レビュー結果を再確認
    review_content = Read("code-review-report.md")
    review_status = review_content.split('\n')[0].strip()
```

### 完了確認

```python
# 最終ステータスの確認
if review_status == "COMPLETED":
    print("✅ バグ修正が完了しました")
    
    # 成果物の確認
    print("成果物:")
    print("- bug-investigation-report.md: 調査レポート")
    print("- code-review-report.md: レビュー結果（COMPLETED）")
    print("- 修正されたソースコード")
else:
    print("⚠️ レビューがCOMPLETEDになりませんでした")
    print("手動での対応が必要です")
```

## エラーハンドリング

### セッションID取得失敗時

```python
if not IMPLEMENTATION_SESSION_ID:
    # ログから抽出を試みる
    logs = Bash("tail -100 *.log | grep session_id")
    # または新規セッションで続行
```

### ファイル作成失敗時

```python
# リトライロジック
for attempt in range(3):
    if os.path.exists("bug-investigation-report.md"):
        break
    Bash(f"sleep {60 * (attempt + 1)}")  # 1分、2分、3分と待機
```

### プロセスタイムアウト時

```python
if result['status'] == 'timeout':
    # プロセスを強制終了
    Bash(f"kill -9 {pid}")
    # 新規セッションで再試行
```

## 注意事項

1. **作業ディレクトリ**: 常に`os.getcwd()`を使用して現在のディレクトリを取得
2. **セッションID**: 実装とレビューエージェントのセッションIDは必ず保持
3. **ファイル形式**: レビューファイルの1行目は必ず`COMPLETED`または`INCOMPLETE`
4. **待機時間**: 各エージェントの処理に適切な待機時間を設定
5. **エラー処理**: 各フェーズでエラーチェックを実施

## デバッグ情報

問題が発生した場合は以下を確認：

```python
# プロセス一覧
processes = mcp__ccm__list_claude_processes()

# 特定のプロセスの詳細
details = mcp__ccm__get_claude_result(pid=target_pid)

# ログファイルの確認
logs = Bash("ls -la *.log")
```