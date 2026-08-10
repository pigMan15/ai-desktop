---
title: 架构约束
scope: sample-order-service
status: confirmed
owners: [example-team]
sources:
  - type: document
    ref: fictional-architecture
lastVerifiedAt: 2026-08-05
confidence: high
invalidWhen: [架构调整]
---

# 架构约束

1. 主流程与差异扩展边界清晰，差异不得侵入主流程。
2. 事件异步阶段之间不共享事务。
3. 禁止跨层写库：领域层不得直接访问存储层之外的库。
