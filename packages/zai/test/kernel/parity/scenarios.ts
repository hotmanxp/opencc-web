/**
 * Parity Scenario 定义 — B6 T6.1。
 *
 * 6 类场景（对话 / 工具链 / 审批 / 后台任务 / skill 触发 / slash 命令），
 * 每类至少 1 个场景。每个场景至少覆盖 1 个事件组（11 组 ServerEvent 中）。
 */

import type { Scenario } from './harness.js'

// ─── 1. 对话 ─────────────────────────────────────────────────────────

export const SCENARIO_DIALOG_BASIC: Scenario = {
  id: 'dialog-basic',
  name: '基础对话（user → assistant → done）',
  input: {
    scenarioId: 'dialog-basic',
    prompt: '你好',
    expectedEventTypes: [
      'runtime.started',
      'runtime.delta',
      'runtime.thinking',
      'runtime.done',
    ],
  },
}

export const SCENARIO_DIALOG_MULTI_TURN: Scenario = {
  id: 'dialog-multi-turn',
  name: '多轮对话 + 压缩（runtime.compacted）',
  input: {
    scenarioId: 'dialog-multi-turn',
    prompt: '继续',
    expectedEventTypes: [
      'runtime.started',
      'runtime.delta',
      'runtime.done',
      'runtime.compacted',
      'session.renamed',
      'queue.changed',
    ],
  },
}

// ─── 2. 工具链 ───────────────────────────────────────────────────────

export const SCENARIO_TOOL_CHAIN: Scenario = {
  id: 'tool-chain',
  name: '工具调用链（tool_use → tool_result）',
  input: {
    scenarioId: 'tool-chain',
    prompt: '读 foo.ts 然后总结',
    expectedEventTypes: [
      'runtime.started',
      'runtime.tool_call',
      'runtime.tool_result',
      'runtime.delta',
      'runtime.done',
    ],
    // dsh 工具 schema 严格校验：可能多推一个 tool schema error 事件
    dshOnlyEventTypes: [],
  },
}

// ─── 3. 审批 ─────────────────────────────────────────────────────────

export const SCENARIO_APPROVAL: Scenario = {
  id: 'approval',
  name: '权限审批（prompt.approve）',
  input: {
    scenarioId: 'approval',
    prompt: '写文件',
    expectedEventTypes: [
      'runtime.started',
      'runtime.tool_call',
      'prompt.approve',
      'runtime.tool_result',
      'runtime.done',
    ],
  },
}

export const SCENARIO_PERMISSION: Scenario = {
  id: 'permission',
  name: '权限询问（prompt.permission）',
  input: {
    scenarioId: 'permission',
    prompt: '读 ~/.ssh/id_rsa',
    expectedEventTypes: [
      'runtime.started',
      'runtime.tool_call',
      'prompt.permission',
      'runtime.tool_result',
      'runtime.done',
    ],
  },
}

export const SCENARIO_ASK: Scenario = {
  id: 'ask-user',
  name: 'AskUserQuestion（prompt.ask）',
  input: {
    scenarioId: 'ask-user',
    prompt: '选个模型',
    expectedEventTypes: [
      'runtime.started',
      'runtime.tool_call',
      'prompt.ask',
      'runtime.tool_result',
      'runtime.done',
    ],
  },
}

// ─── 4. 后台任务 ─────────────────────────────────────────────────────

export const SCENARIO_BACKGROUND_TASK: Scenario = {
  id: 'background-task',
  name: '后台任务（job.* + state.agent_task.changed）',
  input: {
    scenarioId: 'background-task',
    prompt: '跑一个长任务',
    expectedEventTypes: [
      'runtime.started',
      'job.started',
      'job.progress',
      'job.done',
      'state.agent_task.changed',
      'runtime.done',
    ],
  },
}

// ─── 5. Skill 触发 ───────────────────────────────────────────────────

export const SCENARIO_SKILL: Scenario = {
  id: 'skill-trigger',
  name: 'Skill 触发（命令 fallthrough → skill）',
  input: {
    scenarioId: 'skill-trigger',
    prompt: '/some-skill arg',
    expectedEventTypes: [
      'command.run',
      'command.done',
      'runtime.started',
      'runtime.delta',
      'runtime.done',
    ],
  },
}

// ─── 6. Slash 命令 ───────────────────────────────────────────────────

export const SCENARIO_SLASH_COMMAND_COMPACT: Scenario = {
  id: 'slash-command-compact',
  name: 'Slash 命令 /compact（command.run + runtime.compacted）',
  input: {
    scenarioId: 'slash-command-compact',
    prompt: '/compact',
    expectedEventTypes: [
      'command.run',
      'command.done',
      'runtime.compacted',
      'session.renamed',
    ],
  },
}

export const SCENARIO_SLASH_COMMAND_HELP: Scenario = {
  id: 'slash-command-help',
  name: 'Slash 命令 /help（command.run + command.done）',
  input: {
    scenarioId: 'slash-command-help',
    prompt: '/help',
    expectedEventTypes: ['command.run', 'command.done'],
  },
}

// ─── Instance / Projection / System / StreamError 覆盖 ──────────────

export const SCENARIO_INSTANCE_LIFECYCLE: Scenario = {
  id: 'instance-lifecycle',
  name: '实例生命周期（instance.changed）',
  input: {
    scenarioId: 'instance-lifecycle',
    prompt: '',
    expectedEventTypes: [
      'instance.changed',
      'server.connected',
      'toast',
    ],
  },
}

export const SCENARIO_PROJECTION_PUSH: Scenario = {
  id: 'projection-push',
  name: '派生投影推送（session/projection）',
  input: {
    scenarioId: 'projection-push',
    prompt: '',
    expectedEventTypes: [
      'session/projection',
    ],
    // dsh 派生事件更密集：多推一个 projection
    dshOnlyEventTypes: [],
  },
}

export const SCENARIO_SYSTEM_RESTART: Scenario = {
  id: 'system-restart',
  name: '系统重启流程（system.restarting + system.stopping）',
  input: {
    scenarioId: 'system-restart',
    prompt: '',
    expectedEventTypes: [
      'system.restarting',
      'system.stopping',
      'system.restart.canceled',
    ],
  },
}

export const SCENARIO_STREAM_ERROR: Scenario = {
  id: 'stream-error',
  name: '流错误（stream/error）',
  input: {
    scenarioId: 'stream-error',
    prompt: '',
    expectedEventTypes: [
      'runtime.started',
      'runtime.error',
      'stream/error',
    ],
  },
}

// ─── 总场景清单 ─────────────────────────────────────────────────────

export const ALL_SCENARIOS: Scenario[] = [
  SCENARIO_DIALOG_BASIC,
  SCENARIO_DIALOG_MULTI_TURN,
  SCENARIO_TOOL_CHAIN,
  SCENARIO_APPROVAL,
  SCENARIO_PERMISSION,
  SCENARIO_ASK,
  SCENARIO_BACKGROUND_TASK,
  SCENARIO_SKILL,
  SCENARIO_SLASH_COMMAND_COMPACT,
  SCENARIO_SLASH_COMMAND_HELP,
  SCENARIO_INSTANCE_LIFECYCLE,
  SCENARIO_PROJECTION_PUSH,
  SCENARIO_SYSTEM_RESTART,
  SCENARIO_STREAM_ERROR,
]