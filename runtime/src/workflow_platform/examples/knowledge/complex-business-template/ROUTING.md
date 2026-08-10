# 路由

## 任务类型与读取顺序

| 任务 | 先读 | 停止条件 |
| --- | --- | --- |
| 需求澄清 | 应用职责 → product 主干 | 能列出受影响流程与状态 |
| 方案设计 | product 主干 → solution 差异 → base | 能给出变更点清单 |
| 编码 | base 接口/模型 → 代码 | 已定位到代码入口 |
| 问题排查 | 错误处理 → base 事件 | 已定位可能根因 |
| Code Review | 全局约束 → 应用架构约束 | 能逐条核对约束 |
| 发布计划 | 跨应用流程 → 回告事件 | 已确认影响范围 |

## 通用顺序

1. 先读应用导航入口（`applications/*/INDEX.md`）。
2. 再读应用职责（`applications/*/application.md`）。
3. 再读 product 主干（`applications/*/domain/product/`）。
4. 再读 solution 差异（`applications/*/domain/solution/`）。
5. 再读 base 与 tech（`applications/*/domain/base/`、`applications/*/tech/`）。
6. 最后回到代码核对实现事实。

## 禁止

禁止一次性无界读取整个仓库。只读取任务相关的入口文件。
