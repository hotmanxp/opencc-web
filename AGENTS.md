# AGENTS.md - zn-agent-assets

## 项目概述

**zn-agent-assets** 是一个 AI Agent 配置资源库，专为 Nova CLI 设计。包含可复用的 agent 配置、命令定义、技能模块、扩展及配套发布工具。


## 目录说明

| 目录 | 说明 |
|------|------|
| `assets/` | 核心资源配置（agents, commands, skills, extensions） |
| `plugins/` | 插件市场包，含 LSP 语言服务、superpowers 等插件 |
| `packages/` | 发布、连接、登录工具包 |

## 构建与测试

### publisher

资源发布工具，位于 `packages/publisher`。构建后通过 `node bin/publisher.js` 执行资源安装、列表、更新等操作。

### agent-login

登录配置工具，位于 `packages/agent-login`。CLI 命令 `agent-login` 支持 PA/Qwen/开放平台登录及 OpenCC 同步。

### browser-fetch-mcp

MCP 代理服务器，位于 `packages/mcp-proxy-server`（npm: `@zn-ai/browser-fetch-mcp`）。通过浏览器 WebSocket 桥接实现内网 Node.js 环境访问互联网。

### zn-nova-connector

MCP 连接器，位于 `packages/zn-nova-connector`（npm: `@zn-ai/zn-nova-connector`）。桥接 Nova/OpenCode 与 zn-nova-ai MCP 服务。

## 提交规范

```
feat: 新功能 | fix: 修复 | docs: 文档 | refactor: 重构
chore: 工具链 | style: 格式 | test: 测试
```

## 平台差异

| 资源 | Nova CLI | OpenCode | OpenCC |
|------|----------|----------|--------|
| agents | `~/.nova/agents/` | `~/.config/opencode/agents/` | `~/.claude/agents/` |
| commands | `~/.nova/commands/` (.toml) | `~/.config/opencode/commands/` (.md) | `~/.claude/commands/` (.md) |
| skills | `~/.agents/skills/` (共享) | `~/.agents/skills/` (共享) | `~/.agents/skills/` (共享) |
| extensions | `~/.nova/extensions/` | 不支持 | 不支持 |

支持 `--project <path>` 参数安装到项目本地对应目录。


<!-- CODEGRAPH_START -->
## CodeGraph

配置了 CodeGraph MCP 服务器，提供基于 AST 解析的代码知识图谱查询。

### 工具选择

| 场景 | 工具 |
|------|------|
| 定义查询 | `codegraph_search` |
| 调用者/被调用者 | `codegraph_callers` / `codegraph_callees` |
| 调用链路 | `codegraph_trace`（支持动态分发） |
| 变更影响分析 | `codegraph_impact` |
| 符号详情 | `codegraph_node` |
| 任务上下文 | `codegraph_context` |
| 批量源码查看 | `codegraph_explore` |
| 文件列表 | `codegraph_files` |
| 索引状态 | `codegraph_status` |

### 使用原则

- **直接回答，不委托子任务** — 结构性问题 1-2 次 codegraph 调用即可，无需走 grep + read 轮询
- **信任 AST 结果** — 来自完整 AST 解析，无需 grep 二次验证
- **索引滞后** — 结果横幅列出待索引文件，对此用 Read 核实；其余内容以 codegraph 为准
- **未初始化** — `.codegraph/` 不存在时运行 `codegraph init -i`
<!-- CODEGRAPH_END -->