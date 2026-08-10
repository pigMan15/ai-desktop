---
title: 创单主干流程
scope: sample-order-service
status: confirmed
owners: [example-team]
sources:
  - type: code
    ref: order-service
lastVerifiedAt: 2026-08-05
confidence: high
invalidWhen: [创单接口重构]
---

# 创单主干流程

1. 接单：网关提交订单请求。
2. 校验：校验业务身份与参数。
3. 创建：写入订单记录并生成事件。
4. 发事件：发布 `OrderCreated`。
5. 回告：接收履约回告并更新状态。

## 失败分支

- 校验失败：拒绝并返回错误，不创建订单。
- 事件发布失败：订单保留待重试，不允许重复创建。
