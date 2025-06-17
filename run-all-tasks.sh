#!/bin/bash

# Agent Communication MCP Server - 全タスク実行スクリプト

set -e

echo "=== Phase 1: Test Environment Setup ==="
# ./tasks/continue-task.sh setup-test-environment

echo "=== Phase 2: Test Creation ==="
# テストを並列実行
SKIP_PERMISSION_CHECK=true ./tasks/continue-task.sh agent-a-messaging-tests &
SKIP_PERMISSION_CHECK=true ./tasks/continue-task.sh agent-b-rooms-tests &
SKIP_PERMISSION_CHECK=true ./tasks/continue-task.sh agent-c-management-tests &
wait

SKIP_PERMISSION_CHECK=true ./tasks/continue-task.sh agent-d-integration-tests

echo "=== Phase 3: Implementation ==="
# 実装を並列実行
SKIP_PERMISSION_CHECK=true ./tasks/continue-task.sh agent-a-messaging &
SKIP_PERMISSION_CHECK=true ./tasks/continue-task.sh agent-b-rooms &
SKIP_PERMISSION_CHECK=true ./tasks/continue-task.sh agent-c-management &
wait

echo "=== Phase 4: Integration ==="
SKIP_PERMISSION_CHECK=true ./tasks/continue-task.sh agent-d-integration

echo "=== Phase 5: Run All Tests ==="
SKIP_PERMISSION_CHECK=true ./tasks/continue-task.sh run-all-tests

echo "=== All tasks completed ==="