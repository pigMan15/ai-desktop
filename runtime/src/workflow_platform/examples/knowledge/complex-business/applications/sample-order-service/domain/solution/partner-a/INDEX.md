# 合作方 A 差异入口

## 适用

- 业务身份前缀为合作方 A 的订单。

## 原则

- 只记录相对 product 主流程的差异。
- 差异不存在时回退到 product 主流程。
- 差异失效必须更新 `invalidWhen`。

## 文档

- [兼容性说明](compatibility-notes.md)
