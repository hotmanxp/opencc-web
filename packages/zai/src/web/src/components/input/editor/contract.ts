/**
 * 输入编辑器模块的共享契约(手法移植自 deepseek-harness
 * `ui-conversation/src/client/input/contract/draft-editor.ts`)。
 *
 * 这一层只放类型,没有运行时 —— 目的是让 chip 节点、投影、span 映射、
 * 运行时之间不互相 import 具体实现,只认这里的形状。
 *
 * ⚠️ 坐标系只有一种:**detect 坐标**。composer 文档里每个 chip 在
 * detectText 中恰好占 1 个 U+FFFC,所以「draft 字符串下标」与
 * 「detect offset」是同一个东西 —— `activeAtToken` / 现有的 token
 * span 计算全部可以原样用,不需要换坐标系。clipboard 坐标(把 chip
 * 展开成 `@path` 文本)只在提交/复制那一刻出现,由投影直接产出字符串。
 */

/** 一次引用插入所需的全部投影(插入时缓存在 chip 节点上) */
export interface ReferenceInsert {
  /** 引用来源(zai 目前只有 'fs') */
  readonly source: string;
  /** 引用 id(相对 cwd 的文件路径,目录以 `/` 结尾) */
  readonly ref: string;
  /** 展示 label(文件 basename) */
  readonly label: string;
  /** 剪贴板 / 持久化投影(如 `@src/foo.ts`),永不直接落盘 */
  readonly clipboardText: string;
}

/**
 * 一次引用在 detectText 中的占位记录(一个 U+FFFC ↔ 一条 occurrence)。
 * 与旧 `InputOccurrence` 形状一致,区别只有 offset 语义从「自维护 draft
 * 的下标」变成「投影下标」—— 数值含义相同,不需要迁移。
 */
export interface Occurrence {
  /** 稳定身份:同一个 chip 节点在多次投影间保持不变(undo 复原节点也保持) */
  readonly occurrenceId: number;
  readonly source: string;
  readonly ref: string;
  /** 在 detectText 中的下标(占据 [offset, offset+1)) */
  readonly offset: number;
  readonly label: string;
  readonly clipboardText: string;
  /** 引用失效(文件已删除)→ chip 置灰 + 删除线 */
  readonly invalid?: boolean;
}

/** 半开区间 [start, end),detect 坐标 */
export interface DetectSpan {
  readonly start: number;
  readonly end: number;
}

/** 需要由上层裁决的按键(菜单打开时的键盘仲裁) */
export type ArbitrateKey = 'up' | 'down' | 'enter' | 'escape' | 'tabBack';

/** 裁决结果:'pass' = 交回默认行为;'consumed' = 本层吃掉该按键 */
export type ArbitrateOutcome = 'pass' | 'consumed';