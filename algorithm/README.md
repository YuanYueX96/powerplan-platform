# algorithm/ —— 规划求解算法（不随仓库公开）

本目录是平台的**求解核心**：源网荷储规划模型的 Gurobi 实现，按《源网荷储规划算法
数据规范（CSV 组织）》实现读取、校验、建模、求解、结果输出与独立复核。

**版权所有，未随本仓库分发。** 平台的建模、边界、参数、对比等全部能力均开源可用；
接入你自己的求解实现即可完整跑通，无需改动平台代码。

## 接口契约

平台（`server/jobs.py`）只依赖以下五个入口，签名即契约：

```python
# algorithm/data_io.py
def load_case(case_dir: str) -> CaseData:
    """读取规范算例目录（机组/节点/线路/联络线/负荷/新能源/区外来电 CSV），
    字段不符时抛出 DataError（message 为可直接展示给用户的中文提示）。"""

def validate(data: CaseData) -> list[str]:
    """提交前数据校验，返回 notes 列表（警告不阻断）。"""

# algorithm/model.py
class SolveOptions:  # dt / annualize / years / discount / res_min_share /
    ...              # ess_lp_relax / time_limit / mip_gap / output_flag / threads

class SGLSModel:
    def __init__(self, data: CaseData, options: SolveOptions): ...
    def build(self) -> None: ...
    def solve(self) -> Result:   # Result.status ∈ {"OPTIMAL","SUBOPTIMAL",...}
        ...

# algorithm/report.py
def write_all(data: CaseData, result: Result, out_dir: str) -> None:
    """按规范 Output 段写出结果 CSV 与 结果汇总.json。"""

# algorithm/verify.py
def verify(data: CaseData, out_dir: str) -> tuple[bool, list[str]]:
    """独立校验：仅从输出 CSV 反算约束是否满足，返回 (ok, 明细)。"""
```

## 平台如何调用

任务提交后，平台把数据库中的系统模型还原为规范算例目录
（`platform_data/jobs/<id>/case/`），随后依序调用
`load_case → validate → SGLSModel.build/solve → write_all → verify`，
全程与数据库解耦——**实现这份契约，就完成了与平台的全部对接**。
