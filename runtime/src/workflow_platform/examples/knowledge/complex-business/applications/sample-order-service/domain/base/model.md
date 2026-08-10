---
title: 模型说明
scope: sample-order-service
status: confirmed
owners: [example-team]
sources:
  - type: code
    ref: order-service
lastVerifiedAt: 2026-08-05
confidence: high
invalidWhen: [模型变更]
---

# 模型说明

- `Order`：订单核心字段；易变字段（状态、金额）需回代码核对。
- `ServiceUnit`：履约单单元；字段语义以代码为准。

不记录真实表名；字段是否易变以当前代码为准。
