#!/bin/bash

# Agent Communication MCP Server - TDD開発実行スクリプト
# このスクリプトは、TDDアプローチで開発を進めるための統合実行スクリプトです

set -e  # エラー時に停止

# カラー定義
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 実行ディレクトリの確認
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# continue-task.shの存在確認
if [ ! -f "./tasks/continue-task.sh" ]; then
    echo -e "${RED}Error: continue-task.sh not found in ./tasks/${NC}"
    exit 1
fi

# 実行モードの選択
echo -e "${BLUE}=== Agent Communication MCP Server TDD Development ===${NC}"
echo ""
echo "実行モードを選択してください:"
echo "1) フル実行（テスト環境セットアップから完了まで）"
echo "2) テスト作成のみ"
echo "3) 実装のみ（テスト作成済みの場合）"
echo "4) 統合とテスト実行のみ"
echo "5) 個別タスク実行"
echo ""
read -p "選択 (1-5): " mode

# タスク実行関数
run_task() {
    local task_name=$1
    local description=$2
    echo -e "${YELLOW}Starting: $description${NC}"
    ./tasks/continue-task.sh "$task_name"
    echo -e "${GREEN}Completed: $description${NC}"
    echo ""
}

# 並列実行関数
run_parallel_tasks() {
    local -n tasks=$1
    local pids=()
    
    # バックグラウンドでタスクを開始
    for task in "${tasks[@]}"; do
        IFS='|' read -r name desc <<< "$task"
        echo -e "${YELLOW}Starting in background: $desc${NC}"
        ./tasks/continue-task.sh "$name" > "${name}.parallel.log" 2>&1 &
        pids+=($!)
    done
    
    # すべてのタスクの完了を待つ
    echo -e "${BLUE}Waiting for parallel tasks to complete...${NC}"
    for pid in "${pids[@]}"; do
        wait $pid
    done
    
    echo -e "${GREEN}All parallel tasks completed!${NC}"
    echo ""
}

# 完了状態確認関数
check_completion() {
    local task_name=$1
    local review_file="${task_name}-review.txt"
    
    if [ -f "$review_file" ]; then
        if grep -q "^COMPLETED" "$review_file"; then
            return 0
        fi
    fi
    return 1
}

# メインロジック
case $mode in
    1)  # フル実行
        echo -e "${BLUE}=== Phase 0: Test Environment Setup ===${NC}"
        run_task "setup-test-environment" "テスト環境のセットアップ"
        
        echo -e "${BLUE}=== Phase 1: Test Creation (Parallel) ===${NC}"
        test_tasks=(
            "agent-a-messaging-tests|メッセージング機能テスト作成"
            "agent-b-rooms-tests|ルーム機能テスト作成"
            "agent-c-management-tests|管理機能テスト作成"
        )
        run_parallel_tasks test_tasks
        
        echo -e "${BLUE}=== Phase 1.1: Integration Test Creation ===${NC}"
        run_task "agent-d-integration-tests" "統合テスト作成"
        
        echo -e "${BLUE}=== Phase 2: Implementation (Parallel) ===${NC}"
        impl_tasks=(
            "agent-a-messaging|メッセージング機能実装"
            "agent-b-rooms|ルーム・プレゼンス機能実装"
            "agent-c-management|管理機能実装"
        )
        run_parallel_tasks impl_tasks
        
        echo -e "${BLUE}=== Phase 3: Integration ===${NC}"
        run_task "agent-d-integration" "統合実装"
        
        echo -e "${BLUE}=== Phase 4: Test Execution ===${NC}"
        run_task "run-all-tests" "全テスト実行と検証"
        
        echo -e "${GREEN}=== TDD Development Completed! ===${NC}"
        ;;
        
    2)  # テスト作成のみ
        echo -e "${BLUE}=== Test Creation Mode ===${NC}"
        
        # 環境セットアップ確認
        if ! check_completion "setup-test-environment"; then
            run_task "setup-test-environment" "テスト環境のセットアップ"
        fi
        
        # 並列でテスト作成
        test_tasks=(
            "agent-a-messaging-tests|メッセージング機能テスト作成"
            "agent-b-rooms-tests|ルーム機能テスト作成"
            "agent-c-management-tests|管理機能テスト作成"
        )
        run_parallel_tasks test_tasks
        
        run_task "agent-d-integration-tests" "統合テスト作成"
        ;;
        
    3)  # 実装のみ
        echo -e "${BLUE}=== Implementation Mode ===${NC}"
        
        # 並列で実装
        impl_tasks=(
            "agent-a-messaging|メッセージング機能実装"
            "agent-b-rooms|ルーム・プレゼンス機能実装"
            "agent-c-management|管理機能実装"
        )
        run_parallel_tasks impl_tasks
        ;;
        
    4)  # 統合とテスト実行
        echo -e "${BLUE}=== Integration and Test Mode ===${NC}"
        run_task "agent-d-integration" "統合実装"
        run_task "run-all-tests" "全テスト実行と検証"
        ;;
        
    5)  # 個別タスク実行
        echo ""
        echo "実行可能なタスク:"
        echo "1) setup-test-environment"
        echo "2) agent-a-messaging-tests"
        echo "3) agent-b-rooms-tests"
        echo "4) agent-c-management-tests"
        echo "5) agent-d-integration-tests"
        echo "6) agent-a-messaging"
        echo "7) agent-b-rooms"
        echo "8) agent-c-management"
        echo "9) agent-d-integration"
        echo "10) run-all-tests"
        echo ""
        read -p "タスク番号を選択 (1-10): " task_num
        
        case $task_num in
            1) run_task "setup-test-environment" "テスト環境のセットアップ" ;;
            2) run_task "agent-a-messaging-tests" "メッセージング機能テスト作成" ;;
            3) run_task "agent-b-rooms-tests" "ルーム機能テスト作成" ;;
            4) run_task "agent-c-management-tests" "管理機能テスト作成" ;;
            5) run_task "agent-d-integration-tests" "統合テスト作成" ;;
            6) run_task "agent-a-messaging" "メッセージング機能実装" ;;
            7) run_task "agent-b-rooms" "ルーム・プレゼンス機能実装" ;;
            8) run_task "agent-c-management" "管理機能実装" ;;
            9) run_task "agent-d-integration" "統合実装" ;;
            10) run_task "run-all-tests" "全テスト実行と検証" ;;
            *) echo -e "${RED}無効な選択です${NC}" ;;
        esac
        ;;
        
    *)
        echo -e "${RED}無効な選択です${NC}"
        exit 1
        ;;
esac

# 完了状態のサマリー表示
echo ""
echo -e "${BLUE}=== Task Completion Summary ===${NC}"
for task in setup-test-environment agent-{a-messaging,b-rooms,c-management,d-integration}{,-tests} run-all-tests; do
    if check_completion "$task"; then
        echo -e "$task: ${GREEN}COMPLETED${NC}"
    else
        echo -e "$task: ${YELLOW}INCOMPLETE${NC}"
    fi
done

echo ""
echo -e "${BLUE}実行ログは各タスクの .log ファイルで確認できます${NC}"
echo -e "${BLUE}レビュー結果は各タスクの -review.txt ファイルで確認できます${NC}"