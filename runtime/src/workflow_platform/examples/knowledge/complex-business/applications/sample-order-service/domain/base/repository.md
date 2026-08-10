---
title: 存储说明
scope: sample-order-service
status: confirmed
owners: [example-team]
sources:
  - type: code
    ref: order-service
lastVerifiedAt: 2026-08-05
confidence: high
invalidWhen: [存储层重构]
---

# 存储说明

- `OrderRepository`：订单读写入口。
- 事务边界：订单创建与事件发布在同一事务边界内。
- 查询语义：按业务身份查询，返回最新版本。

不记录真实表名；查询语义以当前代码为准。
