"""平台数据层：SQLite 存储电力系统模型、运行边界（8760h）与计算任务。

表结构与算法数据规范（CSV 口径）一一对应，便于导出/导入与直接调用 algorithm 包。
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
from typing import Any, Dict, List, Optional

DB_PATH = os.environ.get("PLATFORM_DB", os.path.join(os.path.dirname(os.path.dirname(__file__)), "platform.db"))
DATA_DIR = os.environ.get("PLATFORM_DATA", os.path.join(os.path.dirname(os.path.dirname(__file__)), "platform_data"))

_local = threading.local()
_write_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS systems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT 'v1.0',
  note TEXT DEFAULT '',
  budget REAL DEFAULT 0,
  c_curt REAL DEFAULT 0,
  horizon INTEGER DEFAULT 8760,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER NOT NULL, name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER NOT NULL, name TEXT NOT NULL,
  frm TEXT NOT NULL, too TEXT NOT NULL, cap REAL NOT NULL, x REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER NOT NULL, seq INTEGER, name TEXT NOT NULL,
  kind INTEGER NOT NULL, cap REAL NOT NULL, ramp REAL DEFAULT 1e6,
  pmin REAL DEFAULT 0, node TEXT NOT NULL, hours REAL DEFAULT 0,
  eta_ch REAL DEFAULT 0, eta_dis REAL DEFAULT 0,
  c_inv REAL DEFAULT 0, c_op REAL DEFAULT 0, is_new INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER NOT NULL, name TEXT NOT NULL, node TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS boundary_load (
  system_id INTEGER NOT NULL, node TEXT NOT NULL, t INTEGER NOT NULL, val REAL NOT NULL,
  PRIMARY KEY (system_id, node, t)
);
CREATE TABLE IF NOT EXISTS boundary_res (
  system_id INTEGER NOT NULL, unit TEXT NOT NULL, t INTEGER NOT NULL, val REAL NOT NULL,
  PRIMARY KEY (system_id, unit, t)
);
CREATE TABLE IF NOT EXISTS boundary_tie (
  system_id INTEGER NOT NULL, tie TEXT NOT NULL, t INTEGER NOT NULL, val REAL NOT NULL,
  PRIMARY KEY (system_id, tie, t)
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',   -- pending/running/done/failed
  progress INTEGER DEFAULT 0,
  stage TEXT DEFAULT '',
  message TEXT DEFAULT '',
  notes TEXT DEFAULT '[]',
  verify_ok INTEGER,
  verify_msgs TEXT DEFAULT '[]',
  result_dir TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  started_at TEXT, finished_at TEXT
);
"""


def conn() -> sqlite3.Connection:
    c = getattr(_local, "conn", None)
    if c is None:
        c = sqlite3.connect(DB_PATH, check_same_thread=False)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA foreign_keys=ON")
        _local.conn = c
    return c


def init_db() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    with _write_lock:
        conn().executescript(SCHEMA)
        try:  # 旧库迁移：任务取消标志
            conn().execute("ALTER TABLE jobs ADD COLUMN cancel_requested INTEGER DEFAULT 0")
        except sqlite3.OperationalError:
            pass
        try:  # 旧库迁移：仿真时序口径（默认全年 8760h）
            conn().execute("ALTER TABLE systems ADD COLUMN horizon INTEGER DEFAULT 8760")
        except sqlite3.OperationalError:
            pass
        conn().commit()


def query(sql: str, args: tuple = ()) -> List[Dict[str, Any]]:
    cur = conn().execute(sql, args)
    return [dict(r) for r in cur.fetchall()]


def one(sql: str, args: tuple = ()) -> Optional[Dict[str, Any]]:
    rows = query(sql, args)
    return rows[0] if rows else None


def execute(sql: str, args: tuple = ()) -> int:
    with _write_lock:
        cur = conn().execute(sql, args)
        conn().commit()
        return cur.lastrowid


# ---------------------------------------------------------------- 导入导出

def pick(r: Dict[str, Any], *keys: str, default: Any = None) -> Any:
    """兼容中文 CSV 列名与前端 JSON 英文字段名。"""
    for k in keys:
        if k in r and r[k] not in (None, ""):
            return r[k]
    return default


def _num(r: Dict[str, Any], keys, default: float = 0.0) -> float:
    v = pick(r, *keys, default=default)
    if isinstance(v, str):  # 兼容千分位与全角逗号
        v = v.replace(",", "").replace("，", "").strip()
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _frac(r: Dict[str, Any], keys) -> float:
    """效率归一化为 0~1：CSV 通常写百分数（95），>1 时除以 100。"""
    v = _num(r, keys)
    return v / 100.0 if v > 1 else v


def bulk_execute(sql: str, seq: List[tuple]) -> None:
    """批量写入（单事务），用于 8760h × 多对象的时序初始化。"""
    if not seq:
        return
    with _write_lock:
        conn().executemany(sql, seq)
        conn().commit()


def _replace_nodes(sid: int, rows: List[Dict[str, Any]]) -> None:
    execute("DELETE FROM nodes WHERE system_id=?", (sid,))
    for r in rows:
        name = str(pick(r, "节点名称", "name", default="")).strip()
        if name:
            execute("INSERT INTO nodes(system_id,name) VALUES(?,?)", (sid, name))


def _replace_lines(sid: int, rows: List[Dict[str, Any]]) -> None:
    execute("DELETE FROM lines WHERE system_id=?", (sid,))
    for r in rows:
        execute(
            "INSERT INTO lines(system_id,name,frm,too,cap,x) VALUES(?,?,?,?,?,?)",
            (sid, str(pick(r, "线路名称", "name", default="")),
             str(pick(r, "首端节点", "frm", default="")),
             str(pick(r, "末端节点", "too", default="")),
             _num(r, ("线路容量", "cap")), _num(r, ("电抗标幺值", "x"))))


def _replace_units(sid: int, rows: List[Dict[str, Any]]) -> None:
    execute("DELETE FROM units WHERE system_id=?", (sid,))
    for i, r in enumerate(rows, start=1):
        execute(
            "INSERT INTO units(system_id,seq,name,kind,cap,ramp,pmin,node,hours,eta_ch,eta_dis,c_inv,c_op,is_new)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (sid, int(_num(r, ("序号", "seq"), i)) or i,
             str(pick(r, "机组名称", "name", default="")),
             int(_num(r, ("机组类型", "kind"), 1)),
             _num(r, ("装机容量", "cap")), _num(r, ("爬坡速率", "ramp"), 1e6),
             _num(r, ("最小技术出力", "pmin")),
             str(pick(r, "所在节点", "node", default="")),
             _num(r, ("可用小时数", "hours")),
             _frac(r, ("储能充电效率", "eta_ch")), _frac(r, ("储能放电效率", "eta_dis")),
             _num(r, ("投建成本", "c_inv")), _num(r, ("运行成本", "c_op")),
             int(_num(r, ("是否待建", "is_new"), 0))))


def _replace_ties(sid: int, rows: List[Dict[str, Any]]) -> None:
    execute("DELETE FROM ties WHERE system_id=?", (sid,))
    for r in rows:
        execute("INSERT INTO ties(system_id,name,node) VALUES(?,?,?)",
                (sid, str(pick(r, "联络线名称", "name", default="")),
                 str(pick(r, "所在节点", "node", default=""))))


BND_HEADERS = {"load": ["节点名称", "时段", "节点负荷"],
               "res": ["新能源机组名称", "时段", "新能源出力预测"],
               "tie": ["联络线名称", "时段", "联络线预测"]}


def replace_boundary(sid: int, kind: str, rows: List[Dict[str, Any]]) -> int:
    """kind: load|res|tie。全量替换该类时序数据。返回条数。"""
    table = {"load": "boundary_load", "res": "boundary_res", "tie": "boundary_tie"}[kind]
    col = {"load": "node", "res": "unit", "tie": "tie"}[kind]
    execute(f"DELETE FROM {table} WHERE system_id=?", (sid,))
    seq = []
    for r in rows:
        row_no = r.get("__row__", "?")
        t_raw = pick(r, "时段", "t")
        if t_raw in (None, ""):
            raise ValueError(f"第 {row_no} 行缺少「时段」列；表头需为：{', '.join(BND_HEADERS[kind])}")
        t = int(float(str(t_raw).replace(",", "").strip()))
        val = _num(r, ("节点负荷", "新能源出力预测", "联络线预测", "val", "value"))
        key = str(pick(r, "节点名称", "新能源机组名称", "机组名称", "联络线名称", "key", default="") or "").strip()
        if not key:
            key_col = {"load": "节点名称", "res": "新能源机组名称", "tie": "联络线名称"}[kind]
            raise ValueError(f"第 {row_no} 行缺少「{key_col}」列或值为空")
        seq.append((sid, key, t, val))
    bulk_execute(f"INSERT OR REPLACE INTO {table}(system_id,{col},t,val) VALUES(?,?,?,?)", seq)
    return len(seq)


def set_boundary_values(sid: int, kind: str, key: str, cells: List[Dict[str, Any]]) -> int:
    """按单元格写入（界面手工填写）：cells = [{t, val}]，逐点覆盖。"""
    table = {"load": "boundary_load", "res": "boundary_res", "tie": "boundary_tie"}[kind]
    col = {"load": "node", "res": "unit", "tie": "tie"}[kind]
    seq = [(sid, key, int(c["t"]), float(c.get("val") or 0)) for c in cells]
    bulk_execute(f"INSERT OR REPLACE INTO {table}(system_id,{col},t,val) VALUES(?,?,?,?)", seq)
    return len(seq)


def init_boundary_series(sid: int, kind: str, keys: List[str], horizon: int) -> int:
    """按清单对象生成全年空白时序（0 值），已存在的点不覆盖。返回插入条数。"""
    table = {"load": "boundary_load", "res": "boundary_res", "tie": "boundary_tie"}[kind]
    col = {"load": "node", "res": "unit", "tie": "tie"}[kind]
    seq = [(sid, k, t, 0.0) for k in keys for t in range(1, horizon + 1)]
    before = one(f"SELECT COUNT(*) AS c FROM {table} WHERE system_id=?", (sid,))["c"]
    bulk_execute(f"INSERT OR IGNORE INTO {table}(system_id,{col},t,val) VALUES(?,?,?,?)", seq)
    after = one(f"SELECT COUNT(*) AS c FROM {table} WHERE system_id=?", (sid,))["c"]
    return after - before


def save_system_model(sid: int, kind: str, rows: List[Dict[str, Any]]) -> None:
    {"nodes": _replace_nodes, "lines": _replace_lines,
     "units": _replace_units, "ties": _replace_ties}[kind](sid, rows)


def get_system_full(sid: int) -> Optional[Dict[str, Any]]:
    sysr = one("SELECT * FROM systems WHERE id=?", (sid,))
    if not sysr:
        return None
    return {
        "system": sysr,
        "nodes": query("SELECT name FROM nodes WHERE system_id=? ORDER BY id", (sid,)),
        "lines": query("SELECT * FROM lines WHERE system_id=? ORDER BY id", (sid,)),
        "units": query("SELECT * FROM units WHERE system_id=? ORDER BY seq,id", (sid,)),
        "ties": query("SELECT * FROM ties WHERE system_id=? ORDER BY id", (sid,)),
    }


def horizon(sid: int) -> int:
    """仿真时序口径：取系统设定（默认全年 8760h）与实际数据覆盖的最大时段。"""
    r = one("SELECT horizon FROM systems WHERE id=?", (sid,))
    base = int((r or {}).get("horizon") or 0)
    d = one("SELECT MAX(t) AS tm FROM boundary_load WHERE system_id=?", (sid,))
    return max(base, int((d or {}).get("tm") or 0))


def export_system_to_case_dir(sid: int, case_dir: str, t_limit: int = 0) -> str:
    """把库中的系统模型 + 边界写成 algorithm.load_case 可读的 CSV 目录，返回目录路径。
    t_limit>0 时只导出前 t_limit 个时段（受限许可下的代表日/一周切片求解）。"""
    import csv as _csv
    full = get_system_full(sid)
    if not full:
        raise ValueError(f"系统不存在: {sid}")
    os.makedirs(case_dir, exist_ok=True)

    def write(name, header, rows):
        with open(os.path.join(case_dir, name), "w", encoding="utf-8-sig", newline="") as f:
            w = _csv.writer(f)
            w.writerow(header)
            w.writerows(rows)

    write("节点.csv", ["节点名称"], [[n["name"]] for n in full["nodes"]])
    write("线路.csv", ["线路名称", "首端节点", "末端节点", "线路容量", "电抗标幺值"],
          [[l["name"], l["frm"], l["too"], l["cap"], l["x"]] for l in full["lines"]])
    write("机组.csv",
          ["序号", "机组名称", "机组类型", "装机容量", "爬坡速率", "最小技术出力", "所在节点",
           "可用小时数", "储能充电效率", "储能放电效率", "投建成本", "运行成本", "是否待建"],
          [[u["seq"], u["name"], u["kind"], u["cap"], u["ramp"], u["pmin"], u["node"],
            u["hours"] or "", (u["eta_ch"] or "") and u["eta_ch"] * 100,
            (u["eta_dis"] or "") and u["eta_dis"] * 100,
            u["c_inv"], u["c_op"], u["is_new"]] for u in full["units"]])
    write("联络线.csv", ["联络线名称", "所在节点"], [[t["name"], t["node"]] for t in full["ties"]])

    tl = max(0, int(t_limit or 0))
    lim = f" AND t<={tl}" if tl else ""
    load = query(f"SELECT node,t,val FROM boundary_load WHERE system_id=?{lim} ORDER BY t,node", (sid,))
    write("负荷预测.csv", ["节点名称", "时段", "节点负荷"], [[r["node"], r["t"], r["val"]] for r in load])
    res = query(f"SELECT unit,t,val FROM boundary_res WHERE system_id=?{lim} ORDER BY t,unit", (sid,))
    write("新能源预测.csv", ["新能源机组名称", "时段", "新能源出力预测"], [[r["unit"], r["t"], r["val"]] for r in res])
    tie = query(f"SELECT tie,t,val FROM boundary_tie WHERE system_id=?{lim} ORDER BY t,tie", (sid,))
    write("区外来电预测.csv", ["联络线名称", "时段", "联络线预测"], [[r["tie"], r["t"], r["val"]] for r in tie])
    write("规划经济数据.csv", ["投资上限", "弃新能源惩罚"], [[full["system"]["budget"], full["system"]["c_curt"]]])
    return case_dir


def seed_from_sample(sample_dir: str) -> int:
    """首启播种：把 data/sample 导入为样例系统。返回 system_id。"""
    import csv as _csv

    required = ("节点.csv", "线路.csv", "机组.csv", "联络线.csv",
                "负荷预测.csv", "新能源预测.csv", "区外来电预测.csv", "规划经济数据.csv")
    missing = [n for n in required if not os.path.isfile(os.path.join(sample_dir, n))]
    if missing:
        raise FileNotFoundError("样例数据不完整，缺少：" + "、".join(missing)
                                + "（请确认 data/sample 目录已完整解压）")

    def read(name):
        with open(os.path.join(sample_dir, name), encoding="utf-8-sig", newline="") as f:
            return list(_csv.DictReader(f))

    sid = execute("INSERT INTO systems(name,version,note,budget,c_curt) VALUES(?,?,?,?,?)",
                  ("样例系统", "v1.0", "由 data/sample 自动导入", 0.0, 0.0))
    econ = read("规划经济数据.csv")[0]
    execute("UPDATE systems SET budget=?, c_curt=? WHERE id=?",
            (float(econ["投资上限"]), float(econ["弃新能源惩罚"]), sid))
    save_system_model(sid, "nodes", read("节点.csv"))
    save_system_model(sid, "lines", read("线路.csv"))
    save_system_model(sid, "units", read("机组.csv"))
    save_system_model(sid, "ties", read("联络线.csv"))
    replace_boundary(sid, "load", read("负荷预测.csv"))
    replace_boundary(sid, "res", read("新能源预测.csv"))
    replace_boundary(sid, "tie", read("区外来电预测.csv"))
    return sid
