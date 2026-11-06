"""源网荷储规划模型 —— 命令行入口

用法:
    python run.py --case data/sample --out output
    python run.py --case data/sample --out output --annualize
    python run.py --case data/sample --out output --annualize --res-min-share 0.30
    python run.py --case data/sample --out output --scenarios
"""
from __future__ import annotations

import argparse
import os
import sys

from algorithm.data_io import DataError, load_case, validate
from algorithm.model import SGLSModel, SolveOptions
from algorithm.ptdf import connectivity_check
from algorithm.report import write_all
from algorithm.verify import verify


def _fmt_table(rows, header):
    widths = [max(len(str(x)) for x in col) for col in zip(header, *rows)]
    line = "  ".join(str(h).ljust(w) for h, w in zip(header, widths))
    out = [line, "-" * len(line)]
    for r in rows:
        out.append("  ".join(str(c).ljust(w) for c, w in zip(r, widths)))
    return "\n".join(out)


def run_once(case_dir: str, out_dir: str, opt: SolveOptions, label: str, quiet: bool = False):
    data = load_case(case_dir)
    notes = validate(data)
    if not quiet:
        print(f"\n=== {label} ===")
        for n in notes:
            print("  " + n)
    model = SGLSModel(data, opt)
    model.build()
    if not quiet:
        print("  规模: " + model.size_report())
    res = model.solve()
    write_all(data, res, out_dir)
    ok, msgs = verify(data, out_dir)
    if not quiet:
        print("  约束反算校验: " + ("通过" if ok else f"不通过（{len(msgs)} 条）"))
        for m in msgs[:6]:
            print("     " + m)
    return data, res


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="源网荷储规划模型 v0.4")
    ap.add_argument("--case", default="data/sample", help="算例目录（含规范定义的 CSV）")
    ap.add_argument("--out", default="output", help="结果输出目录")
    ap.add_argument("--dt", type=float, default=1.0)
    ap.add_argument("--annualize", action="store_true",
                    help="[规范外] 投资按 CRF 年化、运行成本按 365 天放大")
    ap.add_argument("--years", type=int, default=20)
    ap.add_argument("--discount", type=float, default=0.08)
    ap.add_argument("--res-min-share", type=float, default=None,
                    help="[规范外] 新能源电量占比下限，如 0.30")
    ap.add_argument("--relax-z", action="store_true",
                    help="[不推荐] 将 z 松弛为连续变量；会引入同时充放的虚拟卸荷")
    ap.add_argument("--time-limit", type=float, default=300.0)
    ap.add_argument("--mip-gap", type=float, default=1e-4)
    ap.add_argument("--scenarios", action="store_true",
                    help="依次跑 规范默认 / 年化 / 年化+配额 三组，输出对比")
    a = ap.parse_args(argv)

    base = SolveOptions(dt=a.dt, years=a.years, discount=a.discount,
                        time_limit=a.time_limit, mip_gap=a.mip_gap,
                        ess_lp_relax=a.relax_z, output_flag=True)

    try:
        if a.scenarios:
            variants = [
                ("S1 规范默认（单日口径）", dict(annualize=False, res_min_share=None), "s1_spec"),
                ("S2 投资年化 + 运行年化", dict(annualize=True, res_min_share=None), "s2_annual"),
                ("S3 年化 + 配额32%（收紧）", dict(annualize=True, res_min_share=0.32), "s3_policy"),
            ]
            rows, header = [], ["方案", "目标值", "投建容量MW", "投建成本亿元",
                                "运行成本亿元", "弃电率%", "新能源占比%", "供电成本元/MWh"]
            for label, kw, sub in variants:
                opt = SolveOptions(**{**base.__dict__, **kw})
                try:
                    d, r = run_once(a.case, os.path.join(a.out, sub), opt, label)
                except DataError as e:
                    print(f"\n  [{label}] 求解失败: {str(e).splitlines()[0]}")
                    rows.append([label, "不可行", "-", "-", "-", "-", "-", "-"])
                    continue
                s = r.summary
                rows.append([label, f"{r.objective:.4e}", f"{s['投建总容量_MW']:.0f}",
                             f"{r.invest_cost / 1e8:.3f}", f"{r.op_cost * r.obj_scale_op / 1e8:.3f}",
                             f"{100 * s['弃电率']:.2f}", f"{100 * s['新能源电量占比']:.2f}",
                             f"{s['平均供电成本_元每MWh']:.1f}"])
                print("\n  投建方案: " + ("、".join(f"{n} {c:.0f}MW" for n, c, _ in r.investments) or "无"))
            print("\n" + "=" * 100)
            print("三方案对比（S1 为规范原文口径，S2/S3 为修正口径）")
            print(_fmt_table(rows, header))
            return 0

        opt = SolveOptions(**{**base.__dict__,
                              "annualize": a.annualize,
                              "res_min_share": a.res_min_share})
        d, r = run_once(a.case, a.out, opt, "源网荷储规划模型 v0.4")

        print("\n求解状态:", r.status)
        print(f"目标值: {r.objective:.6e}")
        print("\n投建方案:")
        if r.investments:
            for name, cap, energy in r.investments:
                extra = f" / {energy:.0f} MWh" if energy else ""
                print(f"  {name:<8s} {cap:8.1f} MW{extra}")
        else:
            print("  （无投建）")
        print("\n关键指标:")
        for k, val in r.summary.items():
            print(f"  {k:<24s} {val:>16,.2f}")
        print("\n结果已写入:", os.path.abspath(a.out))
        return 0

    except DataError as e:
        print("\n[数据/建模错误] " + str(e), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
