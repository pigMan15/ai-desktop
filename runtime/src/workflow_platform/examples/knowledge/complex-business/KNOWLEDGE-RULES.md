# 知识规则

## 每条知识的必备元数据

```yaml
title: string
scope: string
status: confirmed | candidate | personal
owners: string[]
sources:
  - type: artifact | code | document | incident
    ref: string
lastVerifiedAt: YYYY-MM-DD
confidence: high | medium | low
invalidWhen: string[]
```

## 事实、推断与待确认项

- 事实：有代码或正式文档证据。
- 推断：需要标注依据，进入 `candidate/`。
- 待确认项：必须显式列出。

## 候选与个人

- 未确认结论只能进入 `candidate/`。
- `personal/` 不代表团队正式结论。

## product / solution 差异

- `solution/` 只记录相对 `product/` 的差异，不复制主流程。
- 易变化信息只提供定位入口，改代码前必须核对当前实现。

## 更新与删除禁令

- 修改索引、路由、规则和模板必须人工审核。
- 不得删除仍被引用的知识，应标记失效条件。
