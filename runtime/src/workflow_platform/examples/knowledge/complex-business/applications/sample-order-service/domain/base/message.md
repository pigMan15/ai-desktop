---
title: 消息索引
scope: sample-order-service
status: confirmed
owners: [example-team]
sources:
  - type: code
    ref: order-service
lastVerifiedAt: 2026-08-05
confidence: high
invalidWhen: [消息协议变更]
---

# 消息索引

| 事件 | 生产者 | 消费者 | 幂等键 |
| --- | --- | --- | --- |
| `OrderCreated` | 订单服务 | 履约服务 | 业务身份 |
| `OrderAdjusted` | 订单服务 | 履约服务 | 调整单号 |

消费者必须容忍重复事件。
