#!/bin/sh
# 启用本地 pre-commit 钩子（commit 前自动 validate）
set -e
cd "$(dirname "$0")/.."
git config core.hooksPath .githooks
echo "✓ 已启用 .githooks：commit 前自动执行 node 能力/数据工具.mjs validate"
