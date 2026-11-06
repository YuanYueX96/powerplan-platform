@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem ============================================================
rem  基于市场环境的电力系统规划仿真平台 —— Windows 一键启动
rem  用法：双击本文件；或命令行  start.bat 8000  （指定端口）
rem  首次运行会创建 .venv 虚拟环境并安装依赖（需联网，约 1~3 分钟）
rem ============================================================

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8000"

rem ---- 1. 找 Python ----
set "PY="
py -3 --version >nul 2>nul && set "PY=py -3"
if not defined PY (
  python --version >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo.
  echo [错误] 没有找到 Python。
  echo 请先安装 Python 3.10 或更高版本：https://www.python.org/downloads/
  echo 安装时务必勾选 "Add Python to PATH"，装完后重新双击本文件。
  echo.
  pause
  exit /b 1
)

rem ---- 2. 虚拟环境 ----
if not exist ".venv\Scripts\python.exe" (
  echo [1/3] 首次运行，创建虚拟环境 .venv ...
  %PY% -m venv .venv
  if errorlevel 1 (
    echo [错误] 虚拟环境创建失败，请检查 Python 安装是否完整。
    pause
    exit /b 1
  )
)

rem ---- 3. 依赖 ----
echo [2/3] 检查并安装依赖 ...
".venv\Scripts\python.exe" -m pip install -q --upgrade pip
".venv\Scripts\python.exe" -m pip install -q -r requirements.txt
if errorlevel 1 (
  echo.
  echo [错误] 依赖安装失败。常见原因：
  echo   1^) 无法访问 PyPI —— 可在国内网络下改用镜像：
  echo      .venv\Scripts\python.exe -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
  echo   2^) 离线机器 —— 请参考 docs\部署方案.md 第 5 节「离线安装」。
  echo.
  pause
  exit /b 1
)

rem ---- 4. 启动 ----
echo [3/3] 启动服务：http://localhost:%PORT%   （关闭本窗口即停止服务）
echo.
start "" /min cmd /c "timeout /t 3 >nul & start http://localhost:%PORT%"
".venv\Scripts\python.exe" -m uvicorn server.app:app --host 0.0.0.0 --port %PORT%
pause
