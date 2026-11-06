"""计算任务执行器：后台线程调用 algorithm 包完成 规划求解 → 结果输出 → 独立校验。"""
from __future__ import annotations

import json
import os
import threading
import traceback
from typing import Dict

from . import db

# 算法实现不随公开仓库分发：缺失时平台其余功能照常可用，仅求解不可用。
try:
    from algorithm.data_io import DataError, load_case, validate
    from algorithm.model import SGLSModel, SolveOptions
    from algorithm.report import write_all
    from algorithm.verify import verify
except ImportError:
    DataError = Exception

    def _algorithm_missing(*args, **kwargs):
        raise RuntimeError(
            "算法包（algorithm/）未随本仓库发布，无法执行求解。"
            "平台建模 / 边界 / 参数 / 对比功能不受影响；"
            "接入方式见 algorithm/README.md 的接口契约。"
        )

    load_case = validate = write_all = verify = _algorithm_missing
    class SolveOptions:  # 占位：构造即报错，任务会以失败态落库并给出上述提示
        def __init__(self, *args, **kwargs):
            _algorithm_missing()
    class SGLSModel:
        def __init__(self, *args, **kwargs):
            _algorithm_missing()


def _set(job_id: int, **kw) -> None:
    sets = ", ".join(f"{k}=?" for k in kw)
    db.execute(f"UPDATE jobs SET {sets} WHERE id=?", tuple(kw.values()) + (job_id,))


def _cancelled(job_id: int) -> bool:
    r = db.one("SELECT cancel_requested FROM jobs WHERE id=?", (job_id,))
    return bool(r and r["cancel_requested"])


def _finish_cancel(job_id: int) -> None:
    _set(job_id, status="cancelled", progress=100, stage="已取消",
         message="用户取消任务", finished_at="now_local")
    db.execute("UPDATE jobs SET finished_at=datetime('now','localtime') WHERE id=?", (job_id,))


def run_job(job_id: int, system_id: int, options: Dict) -> None:
    # 口径归一化：界面按百分数录入（8 / 32），算法按小数（0.08 / 0.32）
    if float(options.get("discount", 0.08) or 0.08) > 1:
        options["discount"] = float(options["discount"]) / 100.0
    rms = options.get("res_min_share")
    if rms is not None and float(rms) > 1:
        options["res_min_share"] = float(rms) / 100.0
    job_dir = os.path.join(db.DATA_DIR, "jobs", str(job_id))
    case_dir = os.path.join(job_dir, "case")
    out_dir = os.path.join(job_dir, "result")
    try:
        _set(job_id, status="running", started_at="now_local", progress=5, stage="导出算例数据")
        db.execute("UPDATE jobs SET started_at=datetime('now','localtime') WHERE id=?", (job_id,))
        t_limit = int(options.get("horizon_limit") or 0) or None  # 0/缺省 = 全年
        db.export_system_to_case_dir(system_id, case_dir, t_limit=t_limit)
        if _cancelled(job_id):
            return _finish_cancel(job_id)

        _set(job_id, progress=20, stage="数据校验")
        data = load_case(case_dir)
        notes = validate(data)
        _set(job_id, notes=json.dumps(notes, ensure_ascii=False))
        if _cancelled(job_id):
            return _finish_cancel(job_id)

        _set(job_id, progress=35, stage="建模")
        opt = SolveOptions(
            dt=float(options.get("dt", 1.0)),
            annualize=bool(options.get("annualize", False)),
            years=int(options.get("years", 20)),
            discount=float(options.get("discount", 0.08)),
            res_min_share=options.get("res_min_share"),
            ess_lp_relax=bool(options.get("ess_lp_relax", False)),
            time_limit=float(options.get("time_limit", 300.0)),
            mip_gap=float(options.get("mip_gap", 1e-4)),
            output_flag=False,
            threads=int(options.get("threads", 0)),
        )
        model = SGLSModel(data, opt)
        model.build()
        if _cancelled(job_id):
            return _finish_cancel(job_id)

        _set(job_id, progress=55, stage="求解")
        res = model.solve()
        if res.status not in ("OPTIMAL", "SUBOPTIMAL"):
            _set(job_id, status="failed", progress=100,
                 stage="求解", message=f"求解器返回状态 {res.status}（不可行或未找到可行解）",
                 finished_at="now_local")
            db.execute("UPDATE jobs SET finished_at=datetime('now','localtime') WHERE id=?", (job_id,))
            return
        if _cancelled(job_id):
            return _finish_cancel(job_id)

        _set(job_id, progress=85, stage="写出结果")
        write_all(data, res, out_dir)

        _set(job_id, progress=95, stage="独立校验")
        ok, msgs = verify(data, out_dir)

        summary_path = os.path.join(out_dir, "结果汇总.json")
        summary = {}
        if os.path.exists(summary_path):
            with open(summary_path, encoding="utf-8") as f:
                summary = json.load(f)

        _set(job_id, status="done", progress=100, stage="完成", message="",
             verify_ok=1 if ok else 0, verify_msgs=json.dumps(msgs, ensure_ascii=False),
             result_dir=out_dir, summary=json.dumps(summary, ensure_ascii=False))
        db.execute("UPDATE jobs SET finished_at=datetime('now','localtime') WHERE id=?", (job_id,))

    except DataError as e:
        _set(job_id, status="failed", progress=100, stage="数据/建模错误",
             message=str(e).splitlines()[0], finished_at="now_local")
        db.execute("UPDATE jobs SET finished_at=datetime('now','localtime') WHERE id=?", (job_id,))
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        msg = f"{type(e).__name__}: {e}"
        if "GurobiError" in type(e).__name__ and "size-limited license" in str(e):
            msg = ("模型规模超出受限 Gurobi 许可上限（2000 变量/约束）。"
                   "请在「执行计算」页将计算时段改小（如代表日 24h / 一周 168h），"
                   "或使用商业许可后选择全年 8760h。")
        _set(job_id, status="failed", progress=100, stage="内部错误",
             message=msg, finished_at="now_local")
        db.execute("UPDATE jobs SET finished_at=datetime('now','localtime') WHERE id=?", (job_id,))


def submit(job_id: int, system_id: int, options: Dict) -> None:
    t = threading.Thread(target=run_job, args=(job_id, system_id, options), daemon=True,
                         name=f"job-{job_id}")
    t.start()
