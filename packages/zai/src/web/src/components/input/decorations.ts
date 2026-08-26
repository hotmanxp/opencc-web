/**
 * draft 装饰纯函数核心(zai 版,手法移植自 deepseek-harness
 * `ui-conversation/src/client/input/decorations.ts` 的 chip 派生):
 *
 * chip 的渲染指令全部由「occurrence 表」派生 — draft 中每个 U+FFFC 占位
 * 符按 occurrences 在 backdrop 层渲染成一个可见 chip。decoration 是纯数据
 * 指令,DOM 层负责画;测试直接驱动这里。
 *
 * token 高亮(/命令 token、@ 活跃 token)不在这里 — AgentInputBox 已有
 * deriveCommandToken / activeAtToken 各自产出,改成以「指令」形式传入
 * backdrop 渲染层,此处只做 chip 派生。
 */

import type { InputState } from './inputMachine.js'

/** 一条 chip 渲染指令:占位符 offset 处以 `label` 绘制 */
export interface ChipDecoration {
  /** 稳定渲染 key(同名 chip 相互独立) */
  readonly occurrenceId: number
  /** 占位符在 draft 中的 offset(占据 [offset, offset+1)) */
  readonly offset: number
  readonly label: string
  /** 引用目标(文件/目录路径,dir 以 `/` 结尾) */
  readonly path: string
  /** 引用失效样式位(文件已删除等) */
  readonly invalid: boolean
}

/**
 * 由输入状态派生 chip 渲染指令(occurrence 表按 offset 排序,输出保持序)。
 */
export function deriveChipDecorations(state: Pick<InputState, 'occurrences'>): readonly ChipDecoration[] {
  return state.occurrences.map(o => ({
    occurrenceId: o.occurrenceId,
    offset: o.offset,
    label: o.label,
    path: o.ref,
    invalid: o.invalid === true,
  }))
}