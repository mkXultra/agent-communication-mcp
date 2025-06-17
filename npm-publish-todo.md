# NPM Package Publishing TODO List

## 完了済み
- [x] package.jsonの更新（name, version, description, keywords, etc.）
- [x] LICENSEファイルの作成
- [x] .npmignoreファイルの作成
- [x] パッケージの初回公開 (v0.1.0)

## 残タスク

### 高優先度（次回リリース前に必須）

#### 1. テストの修正
- [ ] 失敗している149個のテストを修正
  - [ ] スキーマバリデーションテストの修正（validation.test.ts）
  - [ ] タイムアウトしているテストの修正（5秒以上かかっているもの）
  - [ ] E2Eテストの安定化
- [ ] prepublishOnlyスクリプトにテスト実行を再度追加

#### 2. package.json の警告修正
- [ ] `npm pkg fix` を実行してrepository.urlの警告を修正

### 中優先度（品質向上）

#### 3. ドキュメントの充実
- [ ] README.mdの更新
  - [ ] インストール方法の明記
  - [ ] 使用例の追加
  - [ ] API仕様へのリンク
  - [ ] MCPサーバーとしての設定方法
- [ ] CHANGELOGの作成
- [ ] CONTRIBUTINGガイドラインの作成

#### 4. CI/CD の設定
- [ ] GitHub Actionsワークフローの作成
  - [ ] 自動テスト実行
  - [ ] 型チェック
  - [ ] リント
  - [ ] カバレッジレポート
- [ ] 自動リリースワークフローの設定
  - [ ] semantic-releaseまたは類似ツールの導入

#### 5. コード品質改善
- [ ] ESLintの設定と実行
- [ ] Prettierの設定
- [ ] コードカバレッジの向上（現在のカバレッジを確認し、90%以上を目指す）

### 低優先度（将来的な改善）

#### 6. パッケージの最適化
- [ ] 不要なファイルの除外（dist内のテストファイルなど）
- [ ] バンドルサイズの最適化
- [ ] 依存関係の見直し

#### 7. リリース管理
- [ ] バージョニング戦略の文書化
- [ ] リリースプロセスの自動化
- [ ] npm scriptsの整理

#### 8. セキュリティ
- [ ] npm auditの実行と脆弱性対応
- [ ] セキュリティポリシーの作成
- [ ] 依存関係の定期更新プロセス

#### 9. 開発者体験の向上
- [ ] TypeScriptの型定義の改善
- [ ] JSDOCコメントの追加
- [ ] 開発環境セットアップの簡素化

## 次回リリース計画

### v0.1.1（バグ修正リリース）
- テストの修正
- package.jsonの警告対応
- READMEの基本的な使用方法追加

### v0.2.0（品質向上リリース）
- CI/CDの導入
- ドキュメントの充実
- ESLint/Prettierの導入

### v1.0.0（安定版リリース）
- 全テストの安定化
- 完全なドキュメント
- パフォーマンス最適化
- プロダクション準備完了

## コマンドメモ

```bash
# バージョン更新とリリース
npm version patch  # 0.1.0 → 0.1.1
npm version minor  # 0.1.0 → 0.2.0
npm version major  # 0.1.0 → 1.0.0

# リリース前チェック
npm run build
npm run test
npm run typecheck
npm publish --dry-run

# 実際のリリース
npm publish

# パッケージ情報確認
npm info agent-communication-mcp
```