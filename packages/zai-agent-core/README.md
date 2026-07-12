# @zn-ai/zai-agent-core

知鸟AI agent runtime core — 进程内 agent runtime。

## 安装

```bash
pnpm add @zn-ai/zai-agent-core
```

## 快速开始

```ts
import { DefaultAgentRuntime } from '@zn-ai/zai-agent-core'

const runtime = new DefaultAgentRuntime({ dataDir: '~/.zai' })

async function main() {
  const stream = runtime.run({ prompt: '你好', cwd: '/project' })
  for await (const event of stream) {
    console.log(event.type, event)
  }
}
```

## 架构

- `src/opencc-internals/` — 上游同步过来的模块镜像（TUI 剔除）
- `src/runtime/` — runtime facade（`query()`, `DefaultAgentRuntime`, `streamAdapter`）
- `src/transcript/` — JSON 文件 transcript 存储
- `src/data/` — dataDir 路径解析

## 子项目衔接

- 子项目 B（zai-server）：通过 `AgentRuntime` interface 接入，加 HTTP/SSE 路由
- 子项目 C（zai-web-agent）：by browser SSE → React 聊天 UI

## 测试

```bash
pnpm test          # unit + integration
pnpm test:e2e      # 真实 LLM（需配置凭据）
```

## AskUserQuestionTool

`AskUserQuestion` 工具允许 LLM 在关键决策点向用户提出 1-4 个多选问题, 等待答案后继续流程.

**Server 集成**: 通过 `RuntimeConfig.askRegistry` 注入 server 端的等待表 (`AskRegistry` 实现), tool 在 `ctx.awaitAskUserQuestion` 内挂起, 注册 resolver 后由 server 路由 `/api/agent/answer` 注入答案.

**Web 集成**: SSE 流上 `tool_use:ask_pending` 事件携带 `{toolUseId, questions}`, web 渲染问题组件, 用户提交答案后 POST 到 `/api/agent/answer`.

示例 schema 片段:

```ts
import { AskUserQuestionTool, ASK_USER_QUESTION_TOOL_NAME } from '@zn-ai/zai-agent-core/runtime'

AskUserQuestionTool.inputSchema.parse({
  questions: [
    {
      question: '下一步做什么?',
      header: 'Action',
      options: [
        { label: '实现', description: '写代码' },
        { label: '测试', description: '验证功能' },
      ],
      multiSelect: false,
    },
  ],
})
```

## 同步上游

```bash
pnpm sync-from-opencc --dry-run   # 预览变更
pnpm sync-from-opencc --apply     # 落地
```

## 许可

MIT
