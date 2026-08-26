/**
 * 输入状态机(zai 版,核心手法移植自 deepseek-harness
 * `ui-conversation/src/client/input/machine.ts`):
 *
 * draft 里每个文件引用「chip」只占一个 U+FFFC 占位符;出现次数表
 * (occurrences)记录 chip 的身份/offset/展示 label/剪贴板投影。
 * 每次 draft 变更都是一笔事务 — draft 编辑、occurrence 校正、undo 日志
 * 入栈在 dispatch() 内原子完成,并递增 draftRev(供 span CAS 用)。
 *
 * 相比 DSH 原始版去掉:paste 组件化 / submit·adjudication 平面 / claim /
 * queue / image(那些由 AgentInputBox 原有逻辑负责)。保留:
 * - 事务式 draft 修改 + reconcile(删除/替换穿过 placeholder 时整 chip 消失)
 * - undo/redo(机器持有日志,防止浏览器原生 undo 搅乱占位符与 occurrence)
 * - 引用插入(token span → U+FFFC + occurrence + 尾随空格)
 * - projectClipboard(发送/复制时把 U+FFFC 展开为剪贴板投影文本)
 * - 外部纯文本插入(事件桥 / 命令填充,光标处)
 *
 * 纯 TS,无 React / DOM 依赖,可用 vitest 直接测试。
 */

/** 每个 chip 在 draft 中占用的占位符字符 */
export const PLACEHOLDER = '\uFFFC'

/** 一次文件引用在 draft 中的占位记录(一个 U+FFFC ↔ 一条 occurrence) */
export interface InputOccurrence {
  /** 机器自增稳定身份(同名引用互相独立) */
  readonly occurrenceId: number
  /** 引用来源(zai 目前只有 'fs') */
  readonly source: string
  /** 引用 id(文件相对路径) */
  readonly ref: string
  /** 占位符在 draft 中的 offset(占据 [offset, offset+1)) */
  readonly offset: number
  /** chip 展示 label(文件 basename) */
  readonly label: string
  /** 剪贴板 / 持久化投影(如 `@src/foo.ts`),U+FFFC 永不直接落盘 */
  readonly clipboardText: string
  /** 引用失效标记(如文件已删除 → chip 置灰/删除线) */
  readonly invalid?: boolean
}

/** 一次引用插入所需的投影(插入时缓存到 occurrence) */
export interface InputReference {
  readonly source: string
  readonly ref: string
  readonly label: string
  readonly clipboardText: string
}

/** 已发布状态快照(组件渲染读这个) */
export interface InputState {
  readonly draft: string
  /** 单调递增修订号: span CAS 退化为修订号相等判定 */
  readonly draftRev: number
  /** chip 出现次数表,按 offset 排序 */
  readonly occurrences: readonly InputOccurrence[]
}

/** [start, end) 半开区间 + 插入长度(前一个 draft 坐标) */
export interface EditRange {
  readonly start: number
  readonly end: number
  readonly insertedLength: number
}

/** 触发 token 的区间快照 + CAS 修订号 */
export interface TokenSpan {
  readonly start: number
  readonly end: number
  readonly draftRev: number
}

/** 机器的唯一写路径(事件) */
export type InputEvent =
  /** textarea 全文变更(打字/删除/粘贴消毒后);editRange 缺省时 diff 恢复 */
  | { readonly type: 'draft-changed'; readonly draft: string; readonly editRange?: EditRange }
  /** 把 token span 替换为一个引用 chip(尾随空格除非已存在) */
  | { readonly type: 'insert-reference'; readonly reference: InputReference; readonly span: TokenSpan; readonly tailSpace?: boolean }
  /** 删除一段原 textarea 文本(如 Escape 关闭 @ 菜单时删除 active token) */
  | { readonly type: 'consume-span'; readonly span: TokenSpan }
  /** 发送成功 / 切会话:清空 draft + occurrences + 全部日志(已提交内容不可 undo) */
  | { readonly type: 'clear' }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' }

/** undo 日志里的前缀/后缀公共扫描(找不到 DOM editRange 时恢复) */
function diffEdit(prev: string, next: string): EditRange {
  let p = 0
  const maxCommon = Math.min(prev.length, next.length)
  while (p < maxCommon && prev[p] === next[p]) p += 1
  let s = 0
  const maxSuffix = Math.min(prev.length, next.length) - p
  while (s < maxSuffix && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s += 1
  return { start: p, end: prev.length - s, insertedLength: next.length - s - p }
}

/** 一次 undo 单元 = 事务应用前的快照 */
interface Transaction {
  readonly draftBefore: string
  readonly occurrencesBefore: readonly InputOccurrence[]
}

/** undo 日志深度上限(有界自管理事务环) */
const LOG_LIMIT = 100

/** 相邻单字符打字合并为一次 undo 的时间窗口(ms) */
const MERGE_WINDOW_MS = 1000

/**
 * 把 state 里所有占位符展开为剪贴板投影(发送 / 复制通用):
 * 一个线性走读按 offset 顺序把 U+FFFC 替换为对应 clipboardText,永远不
 * 让占位符离开机器。
 */
export function projectClipboard(state: Pick<InputState, 'draft' | 'occurrences'>): string {
  const { draft, occurrences } = state
  if (occurrences.length === 0) return draft
  let out = ''
  let cursor = 0
  for (const o of occurrences) {
    out += draft.slice(cursor, o.offset) + o.clipboardText
    cursor = o.offset + 1
  }
  return out + draft.slice(cursor)
}

/**
 * 把一段 draft 文本里的引用片段还原成可读文本的镜像:
 * plainText(draft) — 测试 / 显示辅助,不常用。
 */
export function expandClipboardText(draft: string, occurrences: readonly InputOccurrence[]): string {
  return projectClipboard({ draft, occurrences })
}

/** 输入状态机:事件进、状态出;每个实例独立(per-session 构造) */
export class InputMachine {
  private draft = ''
  private draftRev = 0
  private occurrences: InputOccurrence[] = []
  private occurrenceSeq = 0
  private log: Transaction[] = []
  private redoStack: Transaction[] = []
  /** 开放的单字符打字 run:窗口内下一个连续字符合并为同一 undo 单元 */
  private typingRun: { readonly end: number; readonly at: number } | undefined

  constructor(initial: { draft?: string; occurrences?: readonly InputOccurrence[] } = {}) {
    this.draft = initial.draft ?? ''
    this.occurrences = [...(initial.occurrences ?? [])].sort((a, b) => a.offset - b.offset)
  }

  /** 只读状态快照(渲染层每次事件后读取) */
  get state(): InputState {
    return {
      draft: this.draft,
      draftRev: this.draftRev,
      occurrences: this.occurrences,
    }
  }

  /** 事件分派:单写路径 */
  dispatch(ev: InputEvent): void {
    switch (ev.type) {
      case 'draft-changed':
        return this.onDraftChanged(ev.draft, ev.editRange)
      case 'insert-reference':
        return this.onInsertRef(ev)
      case 'consume-span':
        return this.onConsumeSpan(ev.span)
      case 'clear':
        return this.onClear()
      case 'undo':
        return this.onUndo()
      case 'redo':
        return this.onRedo()
    }
  }

  /** 外部在光标处插入纯文本(事件桥「插入对话」/ 命令填充);文本直接拼入 */
  insertTextAt(text: string, caret: number): void {
    if (text.length === 0) return
    this.pushTxn()
    this.typingRun = undefined
    this.reconcile({ start: caret, end: caret, insertedLength: text.length })
    this.adopt(this.draft.slice(0, caret) + text + this.draft.slice(caret))
  }

  /**
   * 在光标处插入一个引用 chip(事件桥「插入对话」的 chip 化路径):
   * 在插入点 mint occurrence 并写入 U+FFFC 占位符;光标前非空白时补前置
   * 空格,后续非空格/EOS 时补尾随空格 —— 与文本自然分隔又不粘连。
   */
  insertReferenceAt(reference: InputReference, caret: number): void {
    if (caret < 0 || caret > this.draft.length) return
    this.pushTxn()
    this.typingRun = undefined
    const before = caret > 0 && !/\s/u.test(this.draft[caret - 1]!) ? ' ' : ''
    const tail = this.draft.slice(caret)
    const after = tail.length === 0 || tail[0] !== ' ' ? ' ' : ''
    const inserted = before + PLACEHOLDER + after
    const offset = caret + before.length
    this.reconcile({ start: caret, end: caret, insertedLength: inserted.length })
    this.occurrenceSeq += 1
    this.occurrences.push({
      occurrenceId: this.occurrenceSeq,
      source: reference.source,
      ref: reference.ref,
      offset,
      label: reference.label,
      clipboardText: reference.clipboardText,
    })
    this.occurrences.sort((a, b) => a.offset - b.offset)
    this.adopt(this.draft.slice(0, caret) + inserted + tail)
  }

  // ---- 事务 plumbing ----

  private adopt(draft: string): void {
    this.draft = draft
    this.draftRev += 1
  }

  private pushTxn(): void {
    this.log.push({ draftBefore: this.draft, occurrencesBefore: this.occurrences })
    if (this.log.length > LOG_LIMIT) this.log.shift()
    this.redoStack = []
  }

  /**
   * 用一次编辑校正 occurrence 表(旧 draft 坐标):range 之后的条目按
   * 长度差平移;placeholder 落在 range 内的条目整条消失(删除/替换穿过
   * 一个占位符 = 对整个 chip 操作)。
   */
  private reconcile(range: EditRange): void {
    const delta = range.insertedLength - (range.end - range.start)
    const kept: InputOccurrence[] = []
    for (const o of this.occurrences) {
      if (o.offset < range.start) kept.push(o)
      else if (o.offset >= range.end) {
        kept.push(delta === 0 ? o : { ...o, offset: o.offset + delta })
      }
    }
    this.occurrences = kept
  }

  /** span CAS:修订号相等 + 边界合法 */
  private casOk(span: TokenSpan): boolean {
    return span.draftRev === this.draftRev
      && span.start >= 0 && span.start <= span.end && span.end <= this.draft.length
  }

  // ---- 事件处理 ----

  private onDraftChanged(draft: string, editRange?: EditRange): void {
    if (draft === this.draft) return
    const range = editRange ?? diffEdit(this.draft, draft)
    // 相邻单字符打字合并进同一个 undo 事务;其余每次打开新事务。
    const now = Date.now()
    const typing = range.start === range.end && range.insertedLength === 1
    const run = this.typingRun
    const merges = typing && run !== undefined && run.end === range.start && now - run.at <= MERGE_WINDOW_MS
    if (!merges) this.pushTxn()
    this.typingRun = typing ? { end: range.start + 1, at: now } : undefined
    this.reconcile(range)
    this.adopt(draft)
  }

  private onInsertRef(ev: Extract<InputEvent, { type: 'insert-reference' }>): void {
    const { reference, span } = ev
    if (!this.casOk(span)) return
    this.pushTxn()
    this.typingRun = undefined
    const tailSpace = ev.tailSpace !== false
    const tail = this.draft.slice(span.end)
    const gap = tailSpace && (tail.length === 0 || tail[0] !== ' ') ? ' ' : ''
    const inserted = PLACEHOLDER + gap
    this.reconcile({ start: span.start, end: span.end, insertedLength: inserted.length })
    this.occurrenceSeq += 1
    const minted: InputOccurrence = {
      occurrenceId: this.occurrenceSeq,
      source: reference.source,
      ref: reference.ref,
      offset: span.start,
      label: reference.label,
      clipboardText: reference.clipboardText,
    }
    this.occurrences.push(minted)
    this.occurrences.sort((a, b) => a.offset - b.offset)
    this.adopt(this.draft.slice(0, span.start) + inserted + tail)
  }

  private onConsumeSpan(span: TokenSpan): void {
    if (!this.casOk(span) || span.start === span.end) return
    this.pushTxn()
    this.typingRun = undefined
    this.reconcile({ start: span.start, end: span.end, insertedLength: 0 })
    this.adopt(this.draft.slice(0, span.start) + this.draft.slice(span.end))
  }

  /** 发送成功 / 会话切换:重置为干净状态,清空 undo/redo(已提交不复活) */
  private onClear(): void {
    this.draft = ''
    this.draftRev += 1
    this.occurrences = []
    this.log = []
    this.redoStack = []
    this.typingRun = undefined
  }

  private onUndo(): void {
    const entry = this.log.pop()
    if (entry === undefined) return
    this.redoStack.push({ draftBefore: this.draft, occurrencesBefore: this.occurrences })
    this.occurrences = [...entry.occurrencesBefore]
    this.adopt(entry.draftBefore)
    this.typingRun = undefined
  }

  private onRedo(): void {
    const entry = this.redoStack.pop()
    if (entry === undefined) return
    // 手工压回 log:pushTxn 会截断正在走起的 redo 链
    this.log.push({ draftBefore: this.draft, occurrencesBefore: this.occurrences })
    if (this.log.length > LOG_LIMIT) this.log.shift()
    this.occurrences = [...entry.occurrencesBefore]
    this.adopt(entry.draftBefore)
    this.typingRun = undefined
  }
}