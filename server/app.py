"""基于市场环境的电力系统规划仿真平台 —— 后端服务

FastAPI 单体服务：静态托管前端 SPA，REST API 提供系统建模 / 运行边界 / 任务与结果。
"""
from __future__ import annotations

import csv
import io
import json
import os
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import db, jobs

app = FastAPI(title="基于市场环境的电力系统规划仿真平台", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
KINDS = ("nodes", "lines", "units", "ties")


@app.on_event("startup")
def _startup() -> None:
    db.init_db()
    # 默认空库：不自动播种样例数据。需要演示数据时显式调用 POST /api/systems/from-sample
    # 或设置环境变量 PP_SEED_SAMPLE=1 首次启动自动导入。
    if os.environ.get("PP_SEED_SAMPLE") == "1" and not db.query("SELECT id FROM systems LIMIT 1"):
        sample = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "sample")
        if os.path.isdir(sample):
            db.seed_from_sample(sample)


# ---------------------------------------------------------------- 系统建模

@app.get("/api/systems")
def list_systems():
    rows = db.query("SELECT s.*, "
                    "(SELECT COUNT(*) FROM units u WHERE u.system_id=s.id) AS unit_count, "
                    "(SELECT MAX(t) FROM boundary_load b WHERE b.system_id=s.id) AS horizon "
                    "FROM systems s ORDER BY s.id DESC")
    return rows


@app.post("/api/systems")
def create_system(body: Dict[str, Any]):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "系统名称不能为空")
    sid = db.execute("INSERT INTO systems(name,version,note,budget,c_curt,horizon) VALUES(?,?,?,?,?,?)",
                     (name, body.get("version") or "v1.0", body.get("note") or "",
                      float(body.get("budget") or 0), float(body.get("c_curt") or 0),
                      int(body.get("horizon") or 8760)))
    return {"id": sid}


@app.post("/api/systems/from-sample")
def create_system_from_sample():
    """显式导入 data/sample 作为样例系统（默认不自动播种，仅演示/回归用）。"""
    sample = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "sample")
    if not os.path.isdir(sample):
        raise HTTPException(404, "未找到 data/sample 样例数据")
    try:
        return {"id": db.seed_from_sample(sample)}
    except FileNotFoundError as exc:
        raise HTTPException(400, str(exc))


@app.get("/api/systems/{sid}")
def get_system(sid: int):
    full = db.get_system_full(sid)
    if not full:
        raise HTTPException(404, "系统不存在")
    return full


@app.put("/api/systems/{sid}")
def update_system(sid: int, body: Dict[str, Any]):
    if not db.one("SELECT id FROM systems WHERE id=?", (sid,)):
        raise HTTPException(404, "系统不存在")
    fields, args = [], []
    for k in ("name", "version", "note", "budget", "c_curt"):
        if k in body:
            fields.append(f"{k}=?")
            args.append(body[k])
    if fields:
        db.execute(f"UPDATE systems SET {','.join(fields)} WHERE id=?", tuple(args) + (sid,))
    return {"ok": True}


@app.delete("/api/systems/{sid}")
def delete_system(sid: int):
    for t in ("nodes", "lines", "units", "ties", "boundary_load", "boundary_res",
              "boundary_tie", "jobs"):
        db.execute(f"DELETE FROM {t} WHERE system_id=?", (sid,))
    db.execute("DELETE FROM systems WHERE id=?", (sid,))
    return {"ok": True}


@app.put("/api/systems/{sid}/{kind}")
def save_kind(sid: int, kind: str, body: Dict[str, Any]):
    if kind not in KINDS:
        raise HTTPException(404, "未知清单类型")
    rows = body.get("rows") or []
    db.save_system_model(sid, kind, rows)
    return {"ok": True, "count": len(rows)}


def _read_upload_csv(file: UploadFile) -> List[Dict[str, str]]:
    """读取上传 CSV：编码自适应（Excel 中文环境默认 GBK），表头与取值规范化。"""
    raw = file.file.read()
    text = None
    for enc in ("utf-8-sig", "gb18030"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        raise HTTPException(400, "无法识别文件编码：请将 CSV 另存为「CSV UTF-8」或普通「CSV」（GBK）格式后重试")
    raw_rows = list(csv.DictReader(io.StringIO(text)))
    rows: List[Dict[str, str]] = []
    for i, r in enumerate(raw_rows, start=2):  # 从第 2 行起是数据（第 1 行表头）
        item: Dict[str, str] = {}
        empty = True
        for k, v in r.items():
            if k is None:  # 行末多余列
                continue
            k = str(k).strip().lstrip("\ufeff")
            if isinstance(v, list):
                v = v[0] if v else ""
            v = str(v or "").strip()
            item[k] = v
            if v:
                empty = False
        if empty:  # 跳过整行空数据
            continue
        item["__row__"] = str(i)
        rows.append(item)
    if not rows:
        raise HTTPException(400, "CSV 中没有有效的数据行")
    return rows


@app.post("/api/systems/{sid}/import/{kind}")
def import_csv(sid: int, kind: str, file: UploadFile = File(...)):
    if kind not in KINDS:
        raise HTTPException(404, "未知清单类型")
    rows = _read_upload_csv(file)
    try:
        db.save_system_model(sid, kind, rows)
    except (KeyError, ValueError) as e:
        raise HTTPException(400, f"第 {rows[0].get('__row__', '?')} 行附近解析失败：{e}。请使用「下载模板」或「导出 CSV」的列结构。")
    return {"ok": True, "count": len(rows)}


def _content_disposition(filename: str) -> str:
    """HTTP 头仅允许 ASCII，中文文件名按 RFC 5987 编码（filename*）。"""
    from urllib.parse import quote
    ascii_fallback = filename.encode("ascii", "ignore").decode() or "download"
    return f"attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{quote(filename)}"


def _csv_response(header: List[str], rows: List[List[Any]], filename: str) -> StreamingResponse:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(header)
    w.writerows(rows)
    buf.seek(0)
    return StreamingResponse(iter([buf.getvalue().encode("utf-8-sig")]), media_type="text/csv",
                             headers={"Content-Disposition": _content_disposition(filename)})


@app.get("/api/systems/{sid}/export/{kind}")
def export_csv(sid: int, kind: str):
    full = db.get_system_full(sid)
    if not full:
        raise HTTPException(404, "系统不存在")
    if kind == "nodes":
        return _csv_response(["节点名称"], [[n["name"]] for n in full["nodes"]], "节点.csv")
    if kind == "lines":
        return _csv_response(["线路名称", "首端节点", "末端节点", "线路容量", "电抗标幺值"],
                             [[l["name"], l["frm"], l["too"], l["cap"], l["x"]] for l in full["lines"]],
                             "线路.csv")
    if kind == "units":
        return _csv_response(
            ["序号", "机组名称", "机组类型", "装机容量", "爬坡速率", "最小技术出力", "所在节点",
             "可用小时数", "储能充电效率", "储能放电效率", "投建成本", "运行成本", "是否待建"],
            [[u["seq"], u["name"], u["kind"], u["cap"], u["ramp"], u["pmin"], u["node"],
              u["hours"], u["eta_ch"], u["eta_dis"], u["c_inv"], u["c_op"], u["is_new"]]
             for u in full["units"]], "机组.csv")
    if kind == "ties":
        return _csv_response(["联络线名称", "所在节点"],
                             [[t["name"], t["node"]] for t in full["ties"]], "联络线.csv")
    raise HTTPException(404, "未知清单类型")


# ---------------------------------------------------------------- 运行边界

BND = {"load": ("boundary_load", "node", ["节点名称", "时段", "节点负荷"]),
       "res": ("boundary_res", "unit", ["新能源机组名称", "时段", "新能源出力预测"]),
       "tie": ("boundary_tie", "tie", ["联络线名称", "时段", "联络线预测"])}


@app.post("/api/systems/{sid}/boundary/import/{kind}")
def import_boundary(sid: int, kind: str, file: UploadFile = File(...)):
    if kind not in BND:
        raise HTTPException(404, "未知边界类型")
    rows = _read_upload_csv(file)
    n = 0
    try:
        n = db.replace_boundary(sid, kind, rows)
    except (KeyError, ValueError, TypeError) as e:
        row_no = next((r.get("__row__") for r in rows if r.get("__row__")), "?")
        raise HTTPException(400, f"第 {row_no} 行附近解析失败：{e}。请使用「下载模板」或「导出 CSV」的列结构（含时段与数值列）。")
    return {"ok": True, "count": n, "horizon": db.horizon(sid)}


@app.get("/api/systems/{sid}/boundary/export/{kind}")
def export_boundary(sid: int, kind: str):
    table, col, header = BND[kind]
    rows = db.query(f"SELECT {col} AS k, t, val FROM {table} WHERE system_id=? ORDER BY t, {col}", (sid,))
    return _csv_response(header, [[r["k"], r["t"], r["val"]] for r in rows],
                         {"load": "负荷预测", "res": "新能源预测", "tie": "区外来电预测"}[kind] + ".csv")


@app.get("/api/systems/{sid}/boundary/template/{kind}")
def boundary_template(sid: int, kind: str):
    """下载导入模板：表头 + 用该系统的清单对象给出 2 行示例。"""
    if kind not in BND:
        raise HTTPException(404, "未知边界类型")
    header = BND[kind][2]
    keys = _boundary_keys(sid)
    k = (keys[kind] or [{"load": "N1", "res": "PV1", "tie": "X1"}[kind]])[0]
    demo_val = {"load": 850.0, "res": 0.0, "tie": 300.0}[kind]
    demo = [[k, 1, demo_val], [k, 2, demo_val]]
    return _csv_response(header, demo, {"load": "负荷预测模板", "res": "新能源预测模板", "tie": "区外来电预测模板"}[kind] + ".csv")


@app.get("/api/systems/{sid}/boundary/checks")
def boundary_checks(sid: int):
    """运行边界数据校验：阻断（不可计算）/ 警告（需关注）两级。"""
    T = db.horizon(sid)
    full = db.get_system_full(sid)
    if not full:
        raise HTTPException(404, "系统不存在")
    issues: List[Dict[str, Any]] = []

    # 对象清单（由建模页四清单决定）
    keys = _boundary_keys(sid)
    if not keys["load"]:
        issues.append({"level": "block", "msg": "阻断：节点清单为空，请先在「电力系统建模 → 节点清单」中添加节点"})
    if not keys["res"]:
        issues.append({"level": "warn", "msg": "警告：机组清单中没有光伏/风电机组，新能源出力预测无需填写"})
    if not keys["tie"]:
        issues.append({"level": "warn", "msg": "警告：联络线清单为空，区外来电按 0 处理"})

    have = {k: db.one(f"SELECT COUNT(*) AS c FROM {t} WHERE system_id=?", (sid,))["c"]
            for k, t in (("load", "boundary_load"), ("res", "boundary_res"), ("tie", "boundary_tie"))}
    if T <= 0:
        return {"horizon": 0, "blocking": issues + [{"level": "block", "msg": "阻断：仿真时序口径为 0，请检查系统设置"}],
                "warnings": [], "ok": False, "have": have}

    # ① 尚未填写
    for kind, label, table in (("load", "负荷预测", "boundary_load"),
                               ("res", "新能源出力预测", "boundary_res"),
                               ("tie", "区外来电预测", "boundary_tie")):
        if keys[kind] and not have[kind]:
            issues.append({"level": "block" if kind == "load" else "warn",
                           "msg": f"{'阻断' if kind == 'load' else '警告'}：{label}尚未填写（对象 {len(keys[kind])} 个，可在下表填写或导入 CSV）"})

    # ② 谷值负荷 vs 已建机组最小技术出力之和（负荷按节点逐时合计）；全 0 视为尚未填写
    if have["load"]:
        stat = db.one("SELECT MIN(s) AS mn, MAX(s) AS mx FROM (SELECT SUM(val) AS s FROM boundary_load "
                      "WHERE system_id=? GROUP BY t)", (sid,))
        if stat and (stat["mx"] or 0) > 0:
            valley = stat["mn"]
            pmin_sum = sum(u["pmin"] or 0 for u in full["units"] if not u["is_new"])
            if valley is not None and valley < pmin_sum:
                issues.append({"level": "block", "msg": f"阻断：谷值负荷 {fmt_n(valley)} MW 低于已建机组最小技术出力之和 {fmt_n(pmin_sum)} MW，低谷时段无法满足最小出力约束"})
        else:
            issues.append({"level": "block", "msg": "阻断：负荷预测全部为 0，请填写各节点的逐时负荷后再继续"})

    # ③ 新能源预测峰值 vs 该机组装机上限
    for r in db.query("SELECT unit, MAX(val) AS p FROM boundary_res WHERE system_id=? GROUP BY unit", (sid,)):
        u = next((x for x in full["units"] if x["name"] == r["unit"]), None)
        if u and r["p"] is not None and r["p"] > u["cap"] * 1.0001:
            issues.append({"level": "warn" if u["is_new"] else "block",
                           "msg": f"{'警告' if u['is_new'] else '阻断'}：{r['unit']} 预测峰值 {fmt_n(r['p'])} MW 超出装机上限 {fmt_n(u['cap'])} MW，超出部分将计入弃电"})

    # ④ 缺失时点
    for kind, col, table, label in (("load", "node", "boundary_load", "负荷预测"),
                                    ("res", "unit", "boundary_res", "新能源预测"),
                                    ("tie", "tie", "boundary_tie", "区外来电预测")):
        cnt = have[kind]
        if keys[kind] and cnt and cnt < len(keys[kind]) * T:
            issues.append({"level": "warn", "msg": f"警告：{label}存在缺失时点（已填 {cnt}/{len(keys[kind]) * T} 条），缺失时点按 0 补齐并计入校验"})

    blocking = [i for i in issues if i["level"] == "block"]
    warnings = [i for i in issues if i["level"] == "warn"]
    return {"horizon": T, "blocking": blocking, "warnings": warnings, "ok": not blocking, "have": have}


def fmt_n(v: float) -> str:
    return f"{v:,.0f}" if v >= 10 else f"{v:,.1f}"


@app.get("/api/systems/{sid}/boundary/overview")
def boundary_overview(sid: int):
    """按月聚合的全年概览：负荷/新能源/区外来电 月度电量与峰值。"""
    T = db.horizon(sid)
    if T <= 0:
        return {"horizon": 0, "months": []}
    months = range(1, 13)
    # 时段 t 直接按“天”分桶：day = (t-1)//24 + 1，再按日历月近似（对 8760h 数据）。
    # 对不足全年的数据按可用时段聚合，月标签仅作分组展示。
    def agg(table, col):
        rows = db.query(
            f"SELECT ((t-1)/24) AS d, SUM(val) AS e, MAX(val) AS p FROM {table} "
            f"WHERE system_id=? GROUP BY d ORDER BY d", (sid,))
        return rows
    load_rows = agg("boundary_load", "node")
    res_rows = agg("boundary_res", "unit")
    tie_rows = agg("boundary_tie", "tie")
    days = max([len(load_rows), len(res_rows), len(tie_rows)] or [1])
    per_month = max(1, (days + 11) // 12)
    out = []
    for mi, m in enumerate(months):
        lo, hi = mi * per_month, (mi + 1) * per_month
        def seg(rows):
            ss = [r for r in rows if lo <= r["d"] < hi]
            return (round(sum(r["e"] for r in ss), 1), round(max((r["p"] for r in ss), default=0), 1))
        le, lp = seg(load_rows)
        re_, rp = seg(res_rows)
        te, tp = seg(tie_rows)
        out.append({"month": m, "load_energy": le, "load_peak": lp,
                    "res_energy": re_, "res_peak": rp, "tie_energy": te, "tie_peak": tp})
    return {"horizon": T, "days": days, "months": out}


@app.get("/api/systems/{sid}/boundary/series")
def boundary_series(sid: int, kind: str, key: Optional[str] = None, day_from: int = 1, day_to: int = 14):
    """逐时曲线：返回 day_from~day_to 范围内 24h 曲线族（用于日热力图/折线）。"""
    if kind not in BND:
        raise HTTPException(404, "未知边界类型")
    table, col, _ = BND[kind]
    cond, args = "", [sid]
    if key:
        cond = f" AND {col}=?"
        args.append(key)
    rows = db.query(
        f"SELECT {col} AS k, t, val FROM {table} WHERE system_id=? {cond} "
        f"AND t >= ? AND t < ? ORDER BY t", tuple(args) + ((day_from - 1) * 24, day_to * 24))
    by_day: Dict[int, Dict[int, float]] = {}
    keys = set()
    for r in rows:
        d, t = (r["t"] - 1) // 24, (r["t"] - 1) % 24   # 时段 1 起算 → 第 1 日 0 时
        keys.add(r["k"])
        by_day.setdefault(d, {})[t] = r["val"]
    return {"keys": sorted(keys), "days": sorted(by_day), "series": {str(d): v for d, v in by_day.items()}}


def _boundary_keys(sid: int) -> Dict[str, List[str]]:
    """运行边界的对象清单：由建模页的节点 / 新能源机组 / 联络线清单决定。

    负荷对象 = 节点清单；新能源对象 = 光伏(4)/风电(5) 机组；区外来电 = 联络线清单。
    若历史数据中存在清单外的对象，保留在列表末尾，避免数据"消失"。
    """
    full = db.get_system_full(sid) or {"nodes": [], "units": [], "ties": []}
    def merge(primary, existing):
        out = list(primary)
        for k in existing:
            if k not in out:
                out.append(k)
        return out
    load = merge([n["name"] for n in full["nodes"]],
                 [r["node"] for r in db.query("SELECT DISTINCT node FROM boundary_load WHERE system_id=?", (sid,))])
    res = merge([u["name"] for u in full["units"] if u["kind"] in (4, 5)],
                [r["unit"] for r in db.query("SELECT DISTINCT unit FROM boundary_res WHERE system_id=?", (sid,))])
    tie = merge([t["name"] for t in full["ties"]],
                [r["tie"] for r in db.query("SELECT DISTINCT tie FROM boundary_tie WHERE system_id=?", (sid,))])
    return {"load": load, "res": res, "tie": tie}


@app.get("/api/systems/{sid}/boundary/keys")
def boundary_keys(sid: int):
    k = _boundary_keys(sid)
    full = db.get_system_full(sid) or {"units": []}
    k["horizon"] = db.horizon(sid)
    k["res_units"] = [{"name": u["name"], "kind": u["kind"], "cap": u["cap"], "is_new": u["is_new"]}
                      for u in full["units"] if u["kind"] in (4, 5)]
    return k


@app.post("/api/systems/{sid}/boundary/init")
def boundary_init(sid: int, body: Dict[str, Any] = {}):
    """按清单 × 全年时序生成空白（0 值）数据表，供界面逐格填写或导入覆盖。

    body.kind 缺省时对 load/res/tie 三类全部初始化。
    """
    if not db.one("SELECT id FROM systems WHERE id=?", (sid,)):
        raise HTTPException(404, "系统不存在")
    kinds = [body.get("kind")] if body.get("kind") else ["load", "res", "tie"]
    T = db.horizon(sid)
    keys = _boundary_keys(sid)
    created = {}
    for kind in kinds:
        if kind not in ("load", "res", "tie"):
            raise HTTPException(404, "未知边界类型")
        if not keys[kind]:
            created[kind] = 0
            continue
        created[kind] = db.init_boundary_series(sid, kind, keys[kind], T)
    return {"ok": True, "horizon": T, "created": created, "keys": keys}


@app.post("/api/systems/{sid}/boundary/rename")
def boundary_rename(sid: int, body: Dict[str, Any]):
    """对象改名（如节点重命名）时同步时序数据的对象键。"""
    kind, frm, to = body.get("kind"), body.get("from"), body.get("to")
    if kind not in ("load", "res", "tie") or not frm or not to:
        raise HTTPException(400, "参数不完整")
    table = {"load": "boundary_load", "res": "boundary_res", "tie": "boundary_tie"}[kind]
    col = {"load": "node", "res": "unit", "tie": "tie"}[kind]
    db.execute(f"UPDATE OR REPLACE {table} SET {col}=? WHERE system_id=? AND {col}=?", (to, sid, frm))
    return {"ok": True}


@app.put("/api/systems/{sid}/boundary/values")
def boundary_set_values(sid: int, body: Dict[str, Any]):
    """按对象批量写入时序点：{kind, key, cells:[{t,val}]}。"""
    kind, key = body.get("kind"), body.get("key")
    if kind not in ("load", "res", "tie"):
        raise HTTPException(404, "未知边界类型")
    if not key:
        raise HTTPException(400, "缺少对象名称")
    cells = body.get("cells") or []
    n = db.set_boundary_values(sid, kind, key, cells)
    return {"ok": True, "count": n}


# ---------------------------------------------------------------- 计算任务

@app.post("/api/jobs")
def create_job(body: Dict[str, Any]):
    sid = int(body.get("system_id") or 0)
    if not db.one("SELECT id FROM systems WHERE id=?", (sid,)):
        raise HTTPException(404, "系统不存在")
    options = body.get("options") or {}
    name = (body.get("name") or "").strip() or "未命名计算"
    jid = db.execute("INSERT INTO jobs(system_id,name,options) VALUES(?,?,?)",
                     (sid, name, json.dumps(options, ensure_ascii=False)))
    jobs.submit(jid, sid, options)
    return {"id": jid}


@app.get("/api/jobs")
def list_jobs(system_id: Optional[int] = None):
    cond, args = "", ()
    if system_id:
        cond, args = "WHERE j.system_id=?", (system_id,)
    return db.query(
        "SELECT j.id, j.system_id, j.name, j.status, j.progress, j.stage, j.message, "
        "j.verify_ok, j.created_at, j.finished_at, s.name AS system_name, s.version "
        "FROM jobs j LEFT JOIN systems s ON s.id=j.system_id " + cond + " ORDER BY j.id DESC", args)


@app.get("/api/jobs/{jid}")
def job_detail(jid: int):
    r = db.one("SELECT * FROM jobs WHERE id=?", (jid,))
    if not r:
        raise HTTPException(404, "任务不存在")
    r["options"] = json.loads(r["options"] or "{}")
    r["notes"] = json.loads(r["notes"] or "[]")
    r["verify_msgs"] = json.loads(r["verify_msgs"] or "[]")
    r["summary"] = json.loads(r["summary"] or "null")
    return r


@app.post("/api/jobs/{jid}/cancel")
def cancel_job(jid: int):
    r = db.one("SELECT status FROM jobs WHERE id=?", (jid,))
    if not r:
        raise HTTPException(404, "任务不存在")
    if r["status"] in ("pending", "running"):
        db.execute("UPDATE jobs SET cancel_requested=1 WHERE id=?", (jid,))
    return {"ok": True}


@app.get("/api/jobs/{jid}/chart/dispatch")
def job_dispatch_chart(jid: int):
    """系统运行结果透视：每台机组一条全时段曲线 + 系统总负荷。"""
    r = db.one("SELECT j.result_dir, j.system_id FROM jobs j WHERE j.id=?", (jid,))
    if not r or not r["result_dir"]:
        raise HTTPException(404, "任务尚无结果")
    path = os.path.join(r["result_dir"], "系统运行结果.csv")
    series: Dict[str, Dict[int, float]] = {}
    with open(path, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            series.setdefault(row["机组名称"], {})[int(row["时段"])] = float(row["机组出力"])
    T = max((max(m) for m in series.values()), default=0)
    unit_series = {k: [v.get(t, 0.0) for t in range(1, T + 1)] for k, v in series.items()}
    load_rows = db.query(
        "SELECT t, SUM(val) AS v FROM boundary_load WHERE system_id=? GROUP BY t ORDER BY t", (r["system_id"],))
    load = [0.0] * T
    for row in load_rows:
        if 1 <= row["t"] <= T:
            load[row["t"] - 1] = round(row["v"], 2)
    return {"series": unit_series, "load": load}


@app.get("/api/jobs/{jid}/chart/extra")
def job_extra_chart(jid: int):
    """储能运行（充/放电/SOC）与新能源弃电曲线。"""
    r = db.one("SELECT result_dir FROM jobs WHERE id=?", (jid,))
    if not r or not r["result_dir"]:
        raise HTTPException(404, "任务尚无结果")
    def read_csv(name):
        path = os.path.join(r["result_dir"], name)
        if not os.path.isfile(path):
            return []
        with open(path, encoding="utf-8-sig", newline="") as f:
            return list(csv.DictReader(f))
    ess: Dict[str, Dict[str, List[float]]] = {}
    for row in read_csv("储能运行结果.csv"):
        d = ess.setdefault(row["机组名称"], {"charge": [], "discharge": [], "soc": []})
        d["charge"].append(float(row["充电功率"] or 0))
        d["discharge"].append(float(row["放电功率"] or 0))
        d["soc"].append(float(row["SOC能量"] or 0))
    curt: Dict[str, Dict[int, float]] = {}
    for row in read_csv("新能源弃电结果.csv"):
        curt.setdefault(row["机组名称"], {})[int(row["时段"])] = float(row["弃电功率"])
    T = max((max(m) for m in curt.values()), default=0)
    curt_series = {k: [v.get(t, 0.0) for t in range(1, T + 1)] for k, v in curt.items()}
    return {"ess": ess, "curtail": curt_series}


@app.get("/api/jobs/{jid}/export-summary")
def job_export_summary(jid: int):
    r = db.one("SELECT summary, name FROM jobs WHERE id=?", (jid,))
    if not r or not r["summary"]:
        raise HTTPException(404, "任务尚无结果汇总")
    sm = json.loads(r["summary"])
    ind = sm.get("指标") or {}
    rows = [["指标", "数值"]]
    rows += [[k, round(v, 4)] for k, v in ind.items()]
    rows += [["目标值", sm.get("目标值")]]
    for k, v in (sm.get("成本分解") or {}).items():
        rows += [[k, round(v, 4)]]
    for i in sm.get("投建明细") or []:
        rows += [[f"投建-{i['机组']}", f"{i['容量_MW']} MW" + (f" / {i['能量_MWh']} MWh" if i.get("能量_MWh") else "")]]
    return _csv_response(["指标", "数值"], rows[1:], f"{r['name']}-结果汇总.csv")


@app.get("/api/jobs/{jid}/files")
def job_files(jid: int):
    r = db.one("SELECT result_dir FROM jobs WHERE id=?", (jid,))
    if not r or not r["result_dir"] or not os.path.isdir(r["result_dir"]):
        return []
    return [{"name": f, "size": os.path.getsize(os.path.join(r["result_dir"], f))}
            for f in sorted(os.listdir(r["result_dir"]))]


@app.get("/api/jobs/{jid}/files/{name}")
def job_file(jid: int, name: str):
    r = db.one("SELECT result_dir FROM jobs WHERE id=?", (jid,))
    if not r or not r["result_dir"]:
        raise HTTPException(404, "任务尚无结果")
    path = os.path.join(r["result_dir"], name)
    if not os.path.isfile(path) or "/" in name or "\\" in name:
        raise HTTPException(404, "文件不存在")
    return FileResponse(path, filename=name)


@app.get("/api/compare")
def compare(jids: str):
    ids = [int(x) for x in jids.split(",") if x.strip().isdigit()]
    out = []
    for jid in ids:
        r = db.one("SELECT j.id, j.name, j.status, j.summary, s.name AS system_name FROM jobs j "
                   "LEFT JOIN systems s ON s.id=j.system_id WHERE j.id=?", (jid,))
        if not r:
            continue
        out.append({"id": r["id"], "name": r["name"], "status": r["status"],
                    "system_name": r["system_name"],
                    "summary": json.loads(r["summary"] or "null")})
    return out


@app.get("/api/compare/export")
def compare_export(jids: str):
    """对比报告 CSV：关键指标 × 方案。"""
    ids = [int(x) for x in jids.split(",") if x.strip().isdigit()]
    jobs = []
    for jid in ids:
        r = db.one("SELECT j.id, j.name, j.summary FROM jobs j WHERE j.id=?", (jid,))
        if r and r["summary"]:
            sm = json.loads(r["summary"])
            jobs.append((f"#{r['id']} {r['name']}", sm.get("指标") or {}, sm))
    if not jobs:
        raise HTTPException(400, "无可用任务结果")
    metric_keys = ["总负荷电量_MWh", "新能源发电量_MWh", "弃电电量_MWh", "储能放电量_MWh",
                   "新能源电量占比", "弃电率", "投建总容量_MW", "投建总成本_元",
                   "投资上限余额_元", "平均供电成本_元每MWh", "目标值"]
    header = ["指标"] + [j[0] for j in jobs]
    rows = []
    for k in metric_keys:
        vals = []
        for _, ind, _ in jobs:
            v = ind.get(k)
            vals.append(round(v * 100, 2) if (v is not None and ("占比" in k or "率" in k)) else (round(v, 2) if v is not None else "—"))
        label = k.replace("_MWh", " MWh").replace("_MW", " MW").replace("_元", " 元").replace("_元每MWh", " 元/MWh")
        if "占比" in k or "率" in k:
            label += " %"
        rows.append([label] + vals)
    inv_row = ["投建方案"]
    for _, _, sm in jobs:
        inv = sm.get("投建明细") or []
        inv_row.append(", ".join(f"{i['机组']} {i['容量_MW']}MW" for i in inv) or "无")
    rows.append(inv_row)
    return _csv_response(header, rows, "方案对比报告.csv")


# ---------------------------------------------------------------- 静态前端

app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
