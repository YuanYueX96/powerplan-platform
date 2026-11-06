#!/usr/bin/env bash
# ============================================================
#  基于市场环境的电力系统规划仿真平台 —— Linux / macOS 启动脚本
#  用法：./start.sh [端口，默认 8000]
#  首次运行创建 .venv 并安装依赖（需联网）
# ============================================================
set -e
cd "$(dirname "$0")"
PORT="${1:-8000}"

if command -v python3 >/dev/null 2>&1; then PY=python3; else PY=python; fi
if ! $PY -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
  echo "[错误] 需要 Python 3.10 或更高版本，当前：$($PY --version 2>&1 || echo 未安装)"
  exit 1
fi

if [ ! -x ".venv/bin/python" ]; then
  echo "[1/3] 首次运行，创建虚拟环境 .venv ..."
  $PY -m venv .venv
fi

echo "[2/3] 检查并安装依赖 ..."
./.venv/bin/python -m pip install -q --upgrade pip
./.venv/bin/python -m pip install -q -r requirements.txt || {
  echo "[错误] 依赖安装失败。国内网络可改用镜像："
  echo "  ./.venv/bin/python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple"
  echo "离线机器请参考 docs/部署方案.md 第 5 节。"
  exit 1
}

echo "[3/3] 启动服务：http://localhost:${PORT}   （Ctrl+C 停止）"
exec ./.venv/bin/python -m uvicorn server.app:app --host 0.0.0.0 --port "$PORT"
