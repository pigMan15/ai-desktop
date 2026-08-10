---
title: 订单状态生命周期
scope: sample-order-service
status: confirmed
owners: [example-team]
sources:
  - type: code
    ref: order-state-machine
lastVerifiedAt: 2026-08-05
confidence: high
invalidWhen: [状态机调整]
---

# 订单状态生命周期

合法状态：`CREATED` → `ACCEPTED` → `PROCESSING` → `COMPLETED`。
任意非终态可进入 `CANCELLED`。

## 禁止转换

- `COMPLETED` 不可回退。
- `CANCELLED` 不可恢复。
- 已终态订单禁止再次发创建事件。
