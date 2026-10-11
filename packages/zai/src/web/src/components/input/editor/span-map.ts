/**
 * detect 坐标的 span 落点:整个编辑器里唯一一处把数字区间 [start, end)
 * 映射回 Lexical point 并在其上施加编辑的地方。@ 提及插入、slash 命令
 * token 消费、Esc 回退、外部文本插入全部走这里;修订号 CAS 归调用方,
 * 本模块只负责映射与编辑。所有函数必须在 `editor.update()` 内运行。
 *
 * 逐字移植自 deepseek-harness `input/editor/span-map.ts`。
 */
import type { LexicalNode, RangeSelection } from 'lexical';
import { $createRangeSelection, $getRoot, $setSelection } from 'lexical';
import type { ComposerLayout } from './projection.js';
import { $composerLayout } from './projection.js';

/** 一个解析后的选区点(`set()` 的参数三元组) */
interface ResolvedPoint {
  readonly key: string;
  readonly offset: number;
  readonly type: 'text' | 'element';
}

/**
 * 把一个 detect 下标解析成选区点。归属规则:第一个半开区间
 * [start, end) 包含该下标的段负责解析它;文档末尾落到最后一个块。
 * 原子段(chip / linebreak)解析成它们**前导侧**的元素点,所以一个 span
 * 永远只能整体寻址一个 chip —— 这正是「退格一次删净整个 chip」得以成立
 * 的基础;gap 下标解析成前一个块的末尾。
 * @param layout - 当前遍历产物。
 * @param offset - [0, detectLength] 内的 detect 下标。
 * @returns 解析出的点;下标越界时返回 null。
 */
function resolvePoint(layout: ComposerLayout, offset: number): ResolvedPoint | null {
  if (offset < 0 || offset > layout.detectLength) return null;
  for (const segment of layout.segments) {
    if (offset >= segment.detectStart + segment.detectLength) continue;
    if (segment.kind === 'text' && segment.node !== null) {
      return { key: segment.node.getKey(), offset: offset - segment.detectStart, type: 'text' };
    }
    if (segment.kind === 'gap' && segment.gapBetween !== undefined) {
      const before = segment.gapBetween.before;
      return { key: before, offset: layout.children.get(before)?.length ?? 0, type: 'element' };
    }
    // 原子叶节点(chip / linebreak):取前导侧的元素点
    if (segment.node === null) return null;
    const element = segment.node.getParent();
    if (element === null) return null;
    return { key: element.getKey(), offset: segment.node.getIndexWithinParent(), type: 'element' };
  }
  // offset === detectLength:最后一个块的末尾(或空 root)
  const blocks = $getRoot().getChildren();
  const last = blocks[blocks.length - 1];
  if (last === undefined) return { key: $getRoot().getKey(), offset: 0, type: 'element' };
  return { key: last.getKey(), offset: layout.children.get(last.getKey())?.length ?? 0, type: 'element' };
}

/**
 * 在一个 detect span 上构建并施加实时的 RangeSelection。
 * @param layout - 当前遍历产物。
 * @param span - detect span。
 * @returns 施加后的选区;任一端点映射失败返回 null。
 */
function selectSpan(layout: ComposerLayout, span: { start: number; end: number }): RangeSelection | null {
  if (span.start < 0 || span.start > span.end || span.end > layout.detectLength) return null;
  const anchor = resolvePoint(layout, span.start);
  const focus = resolvePoint(layout, span.end);
  if (anchor === null || focus === null) return null;
  const selection = $createRangeSelection();
  selection.anchor.set(anchor.key, anchor.offset, anchor.type);
  selection.focus.set(focus.key, focus.offset, focus.type);
  $setSelection(selection);
  return selection;
}

/**
 * 选中一个 detect span(折叠 span 即放置光标)。对外暴露给上层的
 * 光标放置与测试使用;下面几个 replace helper 建在它之上。
 * @param span - 待选中的 detect span。
 * @returns 两端是否都映射成功。
 */
export function $selectDetectSpan(span: { start: number; end: number }): boolean {
  return selectSpan($composerLayout(), span) !== null;
}

/**
 * 用纯文本替换一个 detect span(空串即删除该 span)。光标落在插入之后。
 * @param span - 待替换的 detect span。
 * @param text - 替换文本。
 * @returns span 是否映射成功且编辑已施加。
 */
export function $replaceDetectSpanWithText(span: { start: number; end: number }, text: string): boolean {
  const selection = selectSpan($composerLayout(), span);
  if (selection === null) return false;
  if (text === '' && !selection.isCollapsed()) selection.removeText();
  else selection.insertText(text);
  return true;
}

/**
 * 用节点替换一个 detect span(chip 插入路径)。光标落在最后插入的节点之后。
 * @param span - 待替换的 detect span。
 * @param nodes - 按序的替换节点。
 * @returns span 是否映射成功且编辑已施加。
 */
export function $replaceDetectSpanWithNodes(
  span: { start: number; end: number },
  nodes: readonly LexicalNode[],
): boolean {
  const selection = selectSpan($composerLayout(), span);
  if (selection === null) return false;
  selection.insertNodes([...nodes]);
  return true;
}