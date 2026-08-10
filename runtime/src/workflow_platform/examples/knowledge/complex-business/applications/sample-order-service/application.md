---
title: 示例订单服务
scope: applications/sample-order-service
status: confirmed
owners: [example-team]
sources:
  - type: document
    ref: fictional-example
lastVerifiedAt: 2026-08-05
confidence: high
invalidWhen: [示例系统下线]
---

# 示例订单服务

## 职责

- 创建订单。
- 维护订单状态生命周期。
- 发布订单事件并接收回告。

## 非职责

- 不执行履约，只负责订单侧协调。

## 上下游

- 上游：网关。
- 下游：履约服务。

## 模块

- 订单写入、状态机、事件发布。

## 入口

- API：见 [api.md](domain/base/api.md)。
- 事件：见 [message.md](domain/base/message.md)。
