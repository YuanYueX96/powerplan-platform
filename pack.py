"""打包分发脚本 —— 生成可拷贝到其他电脑运行的分发包（zip）。

用法（在项目根目录）：
    python pack.py                    # 打包程序本体（不含数据库）
    python pack.py --with-data        # 连同当前 platform.db 与任务结果一起打包（数据迁移）
    python pack.py --out D:/share     # 指定输出目录

产物：dist/电力规划平台-v1.0-<日期>.zip
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import struct
import sys
import zipfile
import zlib
from datetime import date

ROOT = os.path.dirname(os.path.abspath(__file__))
VERSION = "v1.0"

# 分发包需要携带的内容（白名单，避免把开发垃圾带出去）
INCLUDE_FILES = [
    "requirements.txt", "start.bat", "start.sh", "README.md", "pack.py",
    "Dockerfile", "docker-compose.yml", "run.py", "make_sample_data.py",
]
INCLUDE_DIRS = ["server", "algorithm", "data", "docs"]

# 无论在哪一层都跳过的名字
SKIP_NAMES = {
    "__pycache__", ".git", ".workbuddy", ".venv", "venv", "dist", "output",
    "platform_data", "node_modules", ".idea", ".vscode", ".DS_Store",
}
SKIP_SUFFIX = (".pyc", ".pyo", ".db-wal", ".db-shm", ".bak")


def _skip(path: str, name: str) -> bool:
    if name in SKIP_NAMES:
        return True
    if name.startswith("platform.db"):
        return True           # 数据库单独处理（--with-data）
    if name.endswith(SKIP_SUFFIX):
        return True
    return False


def _walk(rel_dir: str):
    base = os.path.join(ROOT, rel_dir)
    for cur, dirs, files in os.walk(base):
        dirs[:] = sorted(d for d in dirs if not _skip(cur, d))
        for f in sorted(files):
            if _skip(cur, f):
                continue
            full = os.path.join(cur, f)
            yield full, os.path.relpath(full, ROOT)


def _checkpoint_wal(db_path: str) -> None:
    """把 WAL 落盘，避免拷贝到半截数据。"""
    try:
        con = sqlite3.connect(db_path)
        con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        con.close()
    except Exception as exc:  # noqa: BLE001
        print(f"  ! WAL 检查点失败（可忽略，但建议先停服务再打包）：{exc}")


def build(with_data: bool, out_dir: str) -> str:
    os.makedirs(out_dir, exist_ok=True)
    name = f"电力规划平台-{VERSION}-{date.today():%Y%m%d}.zip"
    out_path = os.path.join(out_dir, name)

    entries = []
    for f in INCLUDE_FILES:
        full = os.path.join(ROOT, f)
        if os.path.isfile(full):
            entries.append((full, f))
        else:
            print(f"  ! 缺少文件，已跳过：{f}")
    for d in INCLUDE_DIRS:
        if os.path.isdir(os.path.join(ROOT, d)):
            entries.extend(_walk(d))

    if with_data:
        db_path = os.environ.get("PLATFORM_DB", os.path.join(ROOT, "platform.db"))
        if os.path.isfile(db_path):
            _checkpoint_wal(db_path)
            entries.append((db_path, "platform.db"))
        data_dir = os.environ.get("PLATFORM_DATA", os.path.join(ROOT, "platform_data"))
        if os.path.isdir(data_dir):
            data_dir = os.path.abspath(data_dir)
            for cur, dirs, files in os.walk(data_dir):
                dirs[:] = sorted(d for d in dirs if d not in SKIP_NAMES)
                for f in sorted(files):
                    full = os.path.join(cur, f)
                    rel = os.path.relpath(full, data_dir).replace(os.sep, "/")
                    entries.append((full, f"platform_data/{rel}"))

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for full, arc in entries:
            arc_name = arc.replace(os.sep, "/")
            info = zipfile.ZipInfo(arc_name)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            if not arc_name.isascii():
                # 中文文件名：置 UTF-8 标志位，并附 Unicode Path 扩展字段，
                # 兼容 Windows 资源管理器 / 7-Zip / 旧版解压工具，避免解压乱码。
                info.flag_bits |= 0x800
                raw = arc_name.encode("utf-8")
                payload = struct.pack("<BI", 1, zlib.crc32(raw) & 0xFFFFFFFF) + raw
                info.extra = struct.pack("<HH", 0x7075, len(payload)) + payload
            with open(full, "rb") as fh:
                z.writestr(info, fh.read())

    size_mb = os.path.getsize(out_path) / 1024 / 1024
    print(f"\n打包完成：{out_path}")
    print(f"  文件数 {len(entries)}，体积 {size_mb:.1f} MB")
    print(f"  含数据库：{'是（含任务结果，可直接迁移历史数据）' if with_data else '否（对方机器从空库开始）'}")
    return out_path


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="生成部署分发包")
    ap.add_argument("--with-data", action="store_true", help="连同数据库与任务结果一起打包")
    ap.add_argument("--out", default=os.path.join(ROOT, "dist"), help="输出目录，默认 ./dist")
    args = ap.parse_args()
    try:
        build(args.with_data, args.out)
    except Exception as exc:  # noqa: BLE001
        print(f"打包失败：{exc}")
        sys.exit(1)
