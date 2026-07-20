# Sub-agent 工具输入单行展示设计

- 日期：2026-07-16
- 范围：`packages/zai/src/web/src/components/TaskDrawer.tsx`
- 目标：子代理输出面板隐藏工具结果，仅保留工具输入，并将每次工具调用压缩为一行。

## 需求

工具调用完成后显示工具名、输入摘要和状态，例如：

```text
Read: @/Users/liangxuechao572/code/zn-agentic-ppt/package.json (Done)
```

不得在面板中显示工具 `output` 或错误正文。文本消息、运行时状态和任务状态保持现状。

## 方案

采用前端时间线脱敏方案，不修改后端接口和 SSE 协议：

1. `tool_use:start` 创建工具条目时保留 `name`、`input` 和内部状态。
2. `tool_use:done/error/invalid/denied` 只更新状态，不再把 `output` 或 `error` 写入条目。
3. `ToolCallCard` 改为单行渲染 `工具名: 输入摘要`，状态独立靠右显示。
4. 状态颜色固定为：完成绿色、进行中黄色、失败/非法/拒绝红色。
5. `Read` 等路径类工具使用路径摘要；`Read` 的格式为 `Read: @${input.file_path}`。
6. 其他工具优先提取命令、查询或路径字段；无法识别时使用压缩后的单行 JSON。
7. 单行内容超长时不换行，使用省略号截断，并通过 `title` 保留完整内容。

状态映射：`running`、`done`、`error`、`invalid`、`denied` 分别显示运行中、Done、Error、Invalid、Denied。

## 数据流与边界

- SSE 继续接收完整事件，但工具时间线模型不保存结果正文。
- `buildTimeline` 仍按 `toolUseId` 合并工具事件，保证运行中的工具可以更新状态。
- 仅工具卡片行为变化；文本事件、`runtime.done`、`runtime.error`、`runtime.aborted` 和任务结束事件不变。
- 不新增接口，不改变其他 SSE 消费者。

## 测试与验收

增加时间线纯逻辑测试，覆盖：

- `Read` 输入格式化为 `Read: @/path/package.json`。
- 完成工具显示 `(Done)`，不包含 `output`。
- 失败、非法、拒绝状态只显示状态，不包含错误正文。
- 非路径工具仍能生成单行输入摘要。
- 文本消息和运行时事件保持原有时间线行为。

验收时运行 `packages/zai` 现有测试和类型检查，并确认面板 DOM 中不会出现工具结果正文。

## 非目标

- 不修改后台 Agent 执行逻辑。
- 不修改工具实际返回值。
- 不修改 SSE 服务端事件结构。
- 不增加工具结果的折叠、查看或调试入口。
