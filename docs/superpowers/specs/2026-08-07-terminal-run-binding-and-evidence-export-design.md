# 终端 Run 绑定与证据导出设计

## 背景

终端模块保持独立，可在没有 Run 的情况下创建和使用终端。当前终端页面虽然显示“绑定节点”和“导出终端证据”，但没有选择 Run 的入口；独立终端点击导出时也只更新顶部状态，不生成文件。这导致操作指引无法给出一条可执行的绑定路径。

## 目标

- 在终端模块内可选地把新终端或现有独立终端绑定到一个 Run。
- 绑定后将终端输出持久化到 Runtime，并可导出为 Run Evidence。
- 不绑定 Run 时继续支持独立终端，并可导出普通终端日志。
- 每次导出后在操作按钮附近显示实际文件位置。

## 非目标

- 不要求必须从 Run 页面进入终端。
- 不把独立终端日志注册为 Run 产物。
- 不改变 Agent 执行器与终端模块的职责边界。

## 交互设计

终端配置区增加“关联 Run”选择框。默认值为“不关联 Run”，保持独立终端行为。选择 Run 后，页面加载该 Run 的可绑定节点并显示“绑定节点”选择框。

新建终端前已选择 Run 和节点时，终端创建成功后立即注册 Runtime 终端会话并建立桌面 PTY 与 Runtime 会话的绑定。

已经运行的独立终端允许选择 Run 和节点并点击“绑定到 Run”。绑定成功后：

1. 注册 Runtime 终端会话。
2. 建立桌面会话绑定。
3. 将当前页面已读取到的历史输出按序补写到 Runtime。
4. 后续新输出继续实时写入 Runtime。

绑定操作必须防止重复提交；绑定完成后 Run 和节点选择不可修改，除非停止并新建终端。

## 导出行为

### Run 绑定终端

“导出终端证据”调用现有 Runtime Evidence API。Runtime 在 Run 执行工作区下写入：

```text
.workflow-platform/evidence/<runtime-session-id>-<first-sequence>-<last-sequence>.log
```

API 返回产物 URI。页面在按钮附近显示“Evidence 已保存”及完整 URI，并刷新当前 Run 的产物列表。

### 独立终端

“导出终端日志”由桌面主进程把当前 PTY 输出写入项目根目录：

```text
.workflow-platform/terminal-logs/<desktop-session-id>-<first-sequence>-<last-sequence>.log
```

日志写入前执行与 Runtime 终端输出一致的敏感信息脱敏。桌面 IPC 返回绝对路径，页面在按钮附近显示“终端日志已保存”及完整路径。独立日志不写入 artifacts 表，也不显示为 Run Evidence。

按钮名称根据绑定状态显示：独立终端为“导出终端日志”，Run 绑定终端为“导出终端证据”。没有终端或没有输出时，点击后显示明确原因，不静默失败。

## 数据与接口

`TerminalPage` 接收可用 Run 摘要、选定 Run 的节点列表、注册会话、补写输出和导出 Evidence 回调。

桌面 `TerminalBridge` 增加独立日志导出方法，返回：

```ts
type TerminalLogExport = {
  path: string;
  firstSequence: number;
  lastSequence: number;
};
```

Runtime Evidence 回调返回产物的 `uri`，不再只返回 `void`。

## 错误处理

- Run 或节点失效：保留独立终端状态并显示绑定失败原因。
- 历史输出补写失败：绑定视为失败，不显示已绑定状态；允许重试。
- 空输出：不创建空日志或空 Evidence，显示“终端暂无可导出的输出”。
- 文件写入失败：保留终端会话并显示桌面主进程返回的错误。
- Evidence API 失败：不清除终端输出，允许再次导出。

## 测试

- 新终端在选择 Run 和节点后完成 Runtime 注册与桌面绑定。
- 已运行独立终端绑定 Run 时补写已有输出，后续输出不重复。
- 独立终端导出脱敏日志并返回实际路径。
- Run 绑定终端导出 Evidence 并显示 API 返回 URI。
- 空输出、失效 Run、补写失败和文件写入失败均有可见反馈。
- 现有独立终端、粘贴、危险命令审批和 Agent 终端测试保持通过。

## 操作指引更新

中文使用指南新增两条完整路径：

1. 独立终端：创建终端、执行命令、导出普通终端日志、查看保存路径。
2. Run 终端：选择 Run、选择节点、创建或绑定终端、确认输出已同步、导出 Evidence、在产物模块查看记录和文件 URI。
