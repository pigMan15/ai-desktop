---
title: 错误与消息处理
scope: sample-order-service
status: confirmed
owners: [example-team]
sources:
  - type: document
    ref: fictional-ops
lastVerifiedAt: 2026-08-05
confidence: high
invalidWhen: [处理策略调整]
---

# 错误与消息处理

- 可重试异常：网络超时、消息发送失败。
- 不可重试异常：参数校验失败、非法状态转换。
- 死信：重试超限后进入死信并保留证据。
- 日志脱敏：凭据与个人信息不得写入日志与知识库。
