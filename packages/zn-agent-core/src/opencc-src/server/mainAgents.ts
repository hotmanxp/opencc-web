/**
 * 主 Agent 插槽配置(zai patch 2026-08-20)。
 *
 * 主对话的三个插槽点 —— 系统提示词(systemPrompt)、工具列表(tools)、
 * MCP server(mcp)—— 可被 agent 配置整体替换。每个插槽是 `(origin) => new`
 * 纯函数:`origin` 是系统默认值(未选任何 agent 时的产物),返回值替换默认。
 * agent 可省略任意槽(省略 = 用默认)。
 *
 * Agent 两种来源:
 *   1. 内置 —— 每个 agent 一个独立模块,由 `getBuiltinMainAgents()` 聚合:
 *      - default(本模块,不设任何插槽)
 *      - office(mainAgents-office.ts)
 *      - agent-creator(mainAgents-agentCreator.ts,含 ValidateMainAgent 工具)
 *   2. 外置用户配置 —— `~/.zai/main-agents/*.js`(由 zai-server 扫描加载,
 *      重名时外置覆盖内置)
 *
 * 生效时机(见 docs/superpowers/specs/2026-08-20-zai-main-agent-slots-design.md):
 *   - systemPrompt 槽随 QueryEngine 创建固定 → 新会话生效
 *   - tools 槽在 computeTools 每次调用时应用 → 即时生效(仅同步)
 *   - mcp 槽在启动 MCP 连接前应用 → 重启生效
 */
import type { z } from 'zod/v4'
import type { Tool } from '../Tool.js'
import type { ScopedMcpServerConfig } from '../services/mcp/types.js'
import type { buildTool } from '../Tool.js'
import { officeMainAgent } from './mainAgents-office.js'
import { agentCreatorMainAgent } from './mainAgents-agentCreator.js'
import { displayFilesOpenccTool } from './displayFilesOpencc.js'

// agent-creator 域的公共符号(ValidateMainAgent 工具 + 校验函数)定义在
// mainAgents-agentCreator.ts,此处 re-export 保持公共 API 稳定(core 单测
// 与 index.ts 都由此入口取;改动 agent-creator 时不需要动本文件)。
export {
  AGENT_CREATOR_MAIN_AGENT_NAME,
  VALIDATE_MAIN_AGENT_TOOL_NAME,
  validateMainAgentConfig,
  validateMainAgentFile,
  ValidateMainAgentTool,
} from './mainAgents-agentCreator.js'
export type { ValidateMainAgentOutput } from './mainAgents-agentCreator.js'

/** 插槽函数:`origin` 为系统默认值,返回替换后的值。允许异步(除 tools 槽)。 */
export type MainAgentSlot<T> = (origin: T) => T | Promise<T>

/**
 * 外置 agent 文件加载上下文(zai patch 2026-08-20)。
 * 文件以 `module.exports = (ctx) => ({ name, description, ... })` 形式导出,
 * 加载时由运行时传入 ctx —— 主要承载工具构建能力(buildTool + z),让外置
 * JS 文件无需自行解析包名即可在 tools 槽里创造自定义工具。
 */
export type MainAgentLoadContext = {
  /** 工具构建器:buildTool(def) 构造一个完整 Tool 实例。 */
  buildTool: typeof buildTool
  /** zod(v4):inputSchema / outputSchema 用。 */
  z: typeof z
}

/** 主 Agent 配置(JS 对象)。name 持久化到 settings.mainAgent。 */
export interface MainAgentConfig {
  /** 唯一 id,内置与外置合并时作为 key(重名外置覆盖内置) */
  name: string
  description: string
  /** 系统提示词插槽:origin 为默认 prompt 数组(string[]) */
  systemPrompt?: MainAgentSlot<string[]>
  /**
   * 工具列表插槽:origin 为最终工具池(内置 + MCP + 权限过滤后)。
   * 注意:computeTools 是同步调用,此槽必须是同步纯函数。
   */
  tools?: (origin: Tool[]) => Tool[]
  /** MCP server 插槽:origin 为解析后的 server 配置表(name → config) */
  mcp?: MainAgentSlot<Record<string, ScopedMcpServerConfig>>
}

/** 内置 agents。default 不改 systemPrompt / mcp,仅通过 tools 槽挂入
 *  displayFilesOpenccTool(把一组本地路径以卡片列表渲染进对话)。
 *  office / agent-creator 不挂 —— 它们面向文档/agent 创作场景,
 *  display_files 跟场景无关。 */
export function getBuiltinMainAgents(): MainAgentConfig[] {
  return [
    {
      name: 'default',
      description: '系统默认 —— 代码编写、程序处理',
      tools: (origin: Tool[]) => {
        // origin 已是 vendor 内置 + MCP + 权限过滤后的最终池。
        // append 避免重名冲突(若 origin 已有 DisplayFiles 同名工具,
        // 跳过;理论上 vendor 不会自带,但防御一下);即时生效。
        if (origin.some((t) => t.name === displayFilesOpenccTool.name)) {
          return origin
        }
        return [...origin, displayFilesOpenccTool]
      },
    },
    officeMainAgent,
    agentCreatorMainAgent,
  ]
}

/**
 * 按名字查找主 Agent;未知名回退到 default(永不返回 undefined)。
 * merged 由调用方提供 —— zai-server 负责把内置与外置合并(重名外置覆盖内置)。
 */
export function resolveMainAgent(
  merged: MainAgentConfig[],
  name: string | undefined,
): MainAgentConfig {
  if (!name) return merged.find((a) => a.name === 'default') ?? merged[0]
  return merged.find((a) => a.name === name) ?? merged[0]
}