/**
 * 编辑器投影:一份 EditorState → 两种纯文本视图。
 *
 * - `detectText` 喂触发探测与 token span 坐标(**每个 chip 恰好占 1 个
 *   U+FFFC** —— 这条不变量让 detect 坐标与旧 draft 字符串下标完全等价,
 *   `activeAtToken` 因此一行都不用改);
 * - `clipboardText` 喂持久化与提交(把 chip 展开成 `@path` 文本)。
 *
 * 所有 `$` 函数必须在 `editor.read()` / `editor.update()` 内运行。
 *
 * 移植自 deepseek-harness 同名文件,差异一处:occurrence 的 offset 取
 * `segment.detectStart`(detect 坐标),而 dsh 用的是 clipboard 坐标。
 * zai 只在提交那一刻需要 clipboard 形态(投影直接给字符串),所以
 * occurrence 全程待在 detect 坐标里,可与现有 token span 直接比较。
 */
import type { ElementNode, LexicalNode, NodeKey, Point } from 'lexical';
import {
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
} from 'lexical';
import type { Occurrence } from '../contract.js';
import { $isReferenceChipNode } from './chip-node.js';

/** detect 投影里一个 chip 的替身(对象替换字符) */
export const ATOMIC_CHAR = '\uFFFC';

/** composer 文档的一叶(或间隙),带双坐标 */
export interface ComposerSegment {
  /** text/linebreak 携带节点;chip 原子;gap 是块元素之间的换行 */
  readonly kind: 'text' | 'chip' | 'linebreak' | 'gap';
  /** 承载节点;仅 gap 为 null */
  readonly node: LexicalNode | null;
  readonly detectStart: number;
  readonly detectLength: number;
  readonly clipboardStart: number;
  readonly clipboardLength: number;
  /** 仅 gap:这段换行隔开的两个块元素 */
  readonly gapBetween?: { readonly before: NodeKey; readonly after: NodeKey };
}

/** 一次遍历的产物:段序列 + point 映射需要的索引 */
export interface ComposerLayout {
  readonly segments: readonly ComposerSegment[];
  readonly detectLength: number;
  readonly detectText: string;
  readonly clipboardText: string;
  /** 叶节点键 → 其所属段 */
  readonly byKey: ReadonlyMap<NodeKey, ComposerSegment>;
  /** 元素键 → 有序子键(root 与每个块元素) */
  readonly children: ReadonlyMap<NodeKey, readonly NodeKey[]>;
  /** 元素键 → 其内容的 detect 边界(不含 gap) */
  readonly bounds: ReadonlyMap<NodeKey, { readonly start: number; readonly end: number }>;
}

/**
 * 遍历 composer 文档一次,按文档序产出全部投影段。块元素(段落)之间
 * 在两种文本投影里各贡献一个换行。
 * @returns 当前 EditorState 的布局。
 */
export function $composerLayout(): ComposerLayout {
  const segments: ComposerSegment[] = [];
  const byKey = new Map<NodeKey, ComposerSegment>();
  const children = new Map<NodeKey, readonly NodeKey[]>();
  const bounds = new Map<NodeKey, { start: number; end: number }>();
  let detect = '';
  let clipboard = '';

  const pushLeaf = (
    kind: 'text' | 'chip' | 'linebreak',
    node: LexicalNode,
    detectPiece: string,
    clipboardPiece: string,
  ): void => {
    const segment: ComposerSegment = {
      kind,
      node,
      detectStart: detect.length,
      detectLength: detectPiece.length,
      clipboardStart: clipboard.length,
      clipboardLength: clipboardPiece.length,
    };
    segments.push(segment);
    byKey.set(node.getKey(), segment);
    detect += detectPiece;
    clipboard += clipboardPiece;
  };

  const walkElement = (element: ElementNode): void => {
    const start = detect.length;
    const kids = element.getChildren();
    children.set(element.getKey(), kids.map((kid) => kid.getKey()));
    for (const kid of kids) {
      if ($isReferenceChipNode(kid)) {
        pushLeaf('chip', kid, ATOMIC_CHAR, kid.getTextContent());
      } else if ($isTextNode(kid)) {
        const text = kid.getTextContent();
        pushLeaf('text', kid, text, text);
      } else if ($isLineBreakNode(kid)) {
        pushLeaf('linebreak', kid, '\n', '\n');
      } else if ($isElementNode(kid)) {
        walkElement(kid);
      }
      // 其余未知内联装饰不贡献任何内容:本 composer 只注册 chip 一种
      // 装饰节点,这条分支按构造不可达。
    }
    bounds.set(element.getKey(), { start, end: detect.length });
  };

  const root = $getRoot();
  const blocks = root.getChildren();
  children.set(root.getKey(), blocks.map((block) => block.getKey()));
  const rootStart = detect.length;
  blocks.forEach((block, index) => {
    const previous = blocks[index - 1];
    if (index > 0 && previous !== undefined) {
      segments.push({
        kind: 'gap',
        node: null,
        detectStart: detect.length,
        detectLength: 1,
        clipboardStart: clipboard.length,
        clipboardLength: 1,
        gapBetween: { before: previous.getKey(), after: block.getKey() },
      });
      detect += '\n';
      clipboard += '\n';
    }
    if ($isElementNode(block)) walkElement(block);
  });
  bounds.set(root.getKey(), { start: rootStart, end: detect.length });

  return {
    segments,
    detectLength: detect.length,
    detectText: detect,
    clipboardText: clipboard,
    byKey,
    children,
    bounds,
  };
}

/**
 * 把一个 clipboard 投影下标折叠回它的 detect 投影孪生下标。落在 chip
 * 展开区间内部的偏移一律吸附到 chip 的尾沿 —— 调用方只会传入「曾经是
 * 文档末尾」的边界(提交快照),不会从中间切开 chip。
 * @param layout - 当前遍历产物。
 * @param clipboardOffset - clipboard 投影下标。
 * @returns 覆盖同一文档位置的 detect 下标。
 */
export function detectOffsetOfClipboardOffset(layout: ComposerLayout, clipboardOffset: number): number {
  for (const segment of layout.segments) {
    const end = segment.clipboardStart + segment.clipboardLength;
    if (clipboardOffset > end) continue;
    if (clipboardOffset === end) return segment.detectStart + segment.detectLength;
    if (segment.kind === 'chip') return segment.detectStart + segment.detectLength;
    return segment.detectStart + (clipboardOffset - segment.clipboardStart);
  }
  return layout.detectLength;
}

/** 每次更新后交给上层的投影产物 */
export interface EditorProjection {
  /** 触发探测 / token span 坐标文本(chip = 1 个 U+FFFC) */
  readonly detectText: string;
  /** 提交 / 持久化文本(chip = clipboardText) */
  readonly clipboardText: string;
  /** occurrence 视图(detect 坐标) */
  readonly occurrences: readonly Occurrence[];
  /** RangeSelection 的 detect 坐标(已排序);无选区或非 range 时为 null */
  readonly selection: { readonly start: number; readonly end: number } | null;
  /** 折叠光标的 detect 坐标;选区缺失或为范围选区时为 null */
  readonly caret: number | null;
}

/**
 * 把一个选区点折叠成 detect 下标。
 * @param layout - 当前遍历产物。
 * @param point - 选区 anchor/focus 点。
 * @returns detect 下标;point 指向未知节点时返回 null。
 */
export function $detectOffsetOfPoint(layout: ComposerLayout, point: Point): number | null {
  if (point.type === 'text') {
    const segment = layout.byKey.get(point.key);
    return segment === undefined ? null : segment.detectStart + Math.min(point.offset, segment.detectLength);
  }
  const kids = layout.children.get(point.key);
  const elementBounds = layout.bounds.get(point.key);
  if (kids === undefined || elementBounds === undefined) return null;
  if (point.offset >= kids.length) return elementBounds.end;
  const childKey = kids[point.offset];
  if (childKey === undefined) return elementBounds.end;
  const childSegment = layout.byKey.get(childKey);
  if (childSegment !== undefined) return childSegment.detectStart;
  const childBounds = layout.bounds.get(childKey);
  return childBounds === undefined ? null : childBounds.start;
}

/**
 * 投影 composer 文档与其光标。
 * @param idOf - 按 chip NodeKey 分配稳定 occurrence id(映射由调用方持有,
 * 同一节点在多次投影间 id 不变)。
 * @returns 投影产物。
 */
export function $projectComposer(idOf: (key: NodeKey) => number): EditorProjection {
  const layout = $composerLayout();
  const occurrences: Occurrence[] = [];
  for (const segment of layout.segments) {
    if (segment.kind !== 'chip' || !$isReferenceChipNode(segment.node)) continue;
    const chip = segment.node;
    occurrences.push({
      occurrenceId: idOf(chip.getKey()),
      source: chip.getSource(),
      ref: chip.getReference(),
      offset: segment.detectStart,
      label: chip.getLabel(),
      clipboardText: chip.getTextContent(),
      ...(chip.isInvalid() ? { invalid: true } : {}),
    });
  }
  const selection = $getSelection();
  let range: { start: number; end: number } | null = null;
  if ($isRangeSelection(selection)) {
    const anchor = $detectOffsetOfPoint(layout, selection.anchor);
    const focus = $detectOffsetOfPoint(layout, selection.focus);
    if (anchor !== null && focus !== null) {
      range = { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
    }
  }
  return {
    detectText: layout.detectText,
    clipboardText: layout.clipboardText,
    occurrences,
    selection: range,
    caret: range !== null && range.start === range.end ? range.start : null,
  };
}