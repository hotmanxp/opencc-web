/**
 * 输入编辑器的私有 Lexical 实例、投影缓存与节点操作。
 *
 * 这是「内容权威」的落点:输入框里的一切内容变更都发生在编辑器里,
 * 投影只是它的一份只读文本视图。上层(AgentInputBox)不再持有 draft
 * 字符串,只读 `projection` 并通过本类的方法施加外部变更
 * (插入引用、恢复草稿、提交后清空、粘贴消毒)。
 *
 * 移植自 deepseek-harness `input/editor/runtime.ts`,已剔除 zai 不存在
 * 的分支:claim token 装饰、textRef 词典订阅、引用点击激活。
 */
import type { LexicalEditor, NodeKey } from 'lexical';
import {
  $addUpdateTag,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  BLUR_COMMAND,
  CLEAR_HISTORY_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  createEditor,
  HISTORY_MERGE_TAG,
  PASTE_TAG,
  RootNode,
  SELECTION_CHANGE_COMMAND,
  SKIP_DOM_SELECTION_TAG,
} from 'lexical';
import { registerPlainText } from '@lexical/plain-text';
import { createEmptyHistoryState, registerHistory } from '@lexical/history';
import { mergeRegister } from '@lexical/utils';
import type { DetectSpan, Occurrence, ReferenceInsert } from '../contract.js';
import { $createReferenceChipNode, ReferenceChipNode } from './chip-node.js';
import type { EditorProjection } from './projection.js';
import { $composerLayout, $projectComposer, detectOffsetOfClipboardOffset } from './projection.js';
import { $replaceDetectSpanWithNodes, $replaceDetectSpanWithText } from './span-map.js';

/**
 * 从一切外部文本(粘贴、持久化草稿播种)里剥掉的占位符:chip 是 detect
 * 投影里 U+FFFC 的唯一合法来源,文本里出现字面量就等于伪造 chip 位置。
 */
export const REFERENCE_PLACEHOLDER_RE = new RegExp('[\\uE100-\\uE11D\\uFFFC]', 'gu');

/** 连续输入的 undo 合并窗口(ms),与旧 InputMachine 的 MERGE_WINDOW_MS 同值 */
const HISTORY_MERGE_DELAY_MS = 1000;

/** 每次注册 / 更新点都要读一遍的模型回调 */
export interface ComposerRuntimeDeps {
  /** 编辑器每次提交后触发(上层在这里重投影 + 推 UI 状态) */
  readonly onUpdate: () => void;
}

/** 一个由上层持有的编辑器实例;注册与销毁也归上层 */
export class ComposerRuntime {
  /** 绑在 contenteditable 宿主上的编辑器 */
  readonly editor: LexicalEditor;
  private projected: EditorProjection = {
    detectText: '',
    clipboardText: '',
    occurrences: [],
    selection: null,
    caret: null,
  };
  /** 每个 chip 节点的稳定 occurrence id(undo 复原节点时 id 依旧) */
  private readonly occurrenceIds = new Map<NodeKey, number>();
  private occurrenceSeq = 0;

  /**
   * @param deps - 模型回调。
   */
  constructor(private readonly deps: ComposerRuntimeDeps) {
    this.editor = createEditor({
      namespace: 'zai-composer',
      nodes: [ReferenceChipNode],
      onError: (error) => {
        throw error;
      },
    });
  }

  /**
   * 在上层持有本运行时之后安装编辑器行为。
   * @returns 反注册回调(同时摘掉 root 元素)。
   */
  register(): () => void {
    // 保留的草稿选区不得把键盘焦点从别的控件抢回来
    const preserveExternalSelection = (): false => {
      const root = this.editor.getRootElement();
      if (root !== null && !root.contains(root.ownerDocument.activeElement)) {
        $addUpdateTag(SKIP_DOM_SELECTION_TAG);
      }
      return false;
    };
    const unregister = mergeRegister(
      registerPlainText(this.editor),
      this.editor.registerCommand(
        BLUR_COMMAND,
        () => {
          // 先跑完这一批,显式 focus 才能拿到它自己更新过的选区
          this.editor.update(preserveExternalSelection, { discrete: true });
          return false;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      this.editor.registerCommand(SELECTION_CHANGE_COMMAND, preserveExternalSelection, COMMAND_PRIORITY_CRITICAL),
      this.editor.registerNodeTransform(RootNode, preserveExternalSelection),
      registerHistory(this.editor, createEmptyHistoryState(), HISTORY_MERGE_DELAY_MS),
      this.editor.registerUpdateListener(() => {
        this.deps.onUpdate();
      }),
    );
    return () => {
      unregister();
      this.editor.setRootElement(null);
    };
  }

  /** 最近一次提交的编辑器投影。 */
  get projection(): EditorProjection {
    return this.projected;
  }

  /** 便捷视图:本次更新的 occurrence 列表。 */
  get occurrences(): readonly Occurrence[] {
    return this.projected.occurrences;
  }

  /**
   * 跑一次「返回时即可观察到结果」的编辑器编辑。在顶层是离散更新;在本
   * 编辑器自己的 update 内部(命令处理器就是这么落地的)直接执行函数体,
   * 因为再包一层 update 会把编辑**推迟**到同步返回之后。
   * @param fn - `$` 编辑体。
   * @param tag - 可选的更新标签(PASTE_TAG / HISTORY_MERGE_TAG)。
   */
  private applyEdit(fn: () => void, tag?: string): void {
    if (this.editor._updating) {
      // 嵌套应用并入外层 update(PASTE_COMMAND 分发必然落到这里)
      if (tag !== undefined) $addUpdateTag(tag);
      fn();
      return;
    }
    this.editor.update(fn, { discrete: true, ...(tag === undefined ? {} : { tag }) });
  }

  /**
   * 在现有编辑器 update 回调内重新投影。
   * @returns 本次读取之前的投影。
   */
  refreshProjection(): EditorProjection {
    const prev = this.projected;
    this.projected = this.editor.getEditorState().read(() => $projectComposer((key) => this.occurrenceIdOf(key)));
    return prev;
  }

  private occurrenceIdOf(key: NodeKey): number {
    const existing = this.occurrenceIds.get(key);
    if (existing !== undefined) return existing;
    this.occurrenceSeq += 1;
    this.occurrenceIds.set(key, this.occurrenceSeq);
    return this.occurrenceSeq;
  }

  /**
   * 整体替换草稿(持久化草稿播种、程序化写入)。已做占位符消毒;
   * 换行拆段落;光标落在末尾。作为历史合并项写入,播种不单独成一个撤销步。
   * @param text - 下一份完整草稿。
   */
  setDraft(text: string): void {
    const clean = text.replace(REFERENCE_PLACEHOLDER_RE, '');
    if (clean === this.projected.clipboardText && this.projected.occurrences.length === 0) return;
    this.editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        for (const line of clean.split('\n')) {
          const paragraph = $createParagraphNode();
          if (line !== '') paragraph.append($createTextNode(line));
          root.append(paragraph);
        }
        root.selectEnd();
      },
      { discrete: true, tag: HISTORY_MERGE_TAG },
    );
  }

  /**
   * 把粘贴的纯文本插到当前选区(已做占位符消毒)。调用方负责抑制粘贴
   * 事件自身的默认行为;PASTE_TAG 让粘贴成为独立的历史边界 —— 一次撤销
   * 不会连带删掉粘贴内容和合并窗口内的后续输入。
   * @param text - 粘贴的纯文本。
   */
  paste(text: string): void {
    const clean = text.replace(REFERENCE_PLACEHOLDER_RE, '');
    if (clean === '') return;
    this.applyEdit(
      () => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText(clean);
          return;
        }
        // 还没有选区(从未聚焦的输入面):落到文档末尾,空树时先长出首段
        const root = $getRoot();
        if (root.getChildrenSize() === 0) root.append($createParagraphNode());
        root.selectEnd().insertText(clean);
      },
      PASTE_TAG,
    );
  }

  /**
   * 当前选区在 detect 坐标下的形态(菜单启动器的合成命中会在选中候选时
   * 顶替它);无选区时回答文档末尾的折叠 span。
   * @returns 有序的 [start, end) 区间。
   */
  caretSpan(): { start: number; end: number } {
    if (this.projected.selection !== null) return this.projected.selection;
    const at = this.projected.detectText.length;
    return { start: at, end: at };
  }

  /**
   * 替换一段可映射的 span。
   * @param span - detect 坐标区间。
   * @param text - 插入文本(空串即删除)。
   * @returns 区间是否映射成功且编辑已施加。
   */
  replaceText(span: DetectSpan, text: string): boolean {
    let applied = false;
    this.applyEdit(() => {
      applied = $replaceDetectSpanWithText(span, text);
    });
    return applied;
  }

  /**
   * 插入一个引用 chip,沿用「尾随空格」规则(下一个字符已经是空格就不补)。
   * @param span - detect 坐标区间。
   * @param ref - 引用投影。
   * @param tail - 编辑前紧跟该区间的一个字符。
   * @returns 区间是否映射成功且编辑已施加。
   */
  insertReference(span: DetectSpan, ref: ReferenceInsert, tail: string): boolean {
    let applied = false;
    this.applyEdit(() => {
      const nodes =
        tail === ' '
          ? [$createReferenceChipNode(ref)]
          : [$createReferenceChipNode(ref), $createTextNode(' ')];
      applied = $replaceDetectSpanWithNodes(span, nodes);
    });
    return applied;
  }

  /**
   * 在当前选区之后插入一串文件引用(附件入框路径),不删除既有选区。
   * 前置空格规则:插入点前不是空白时补一个空格。
   * @param references - 已校验的引用(源序)。
   * @returns 插入位置是否接受了这一批。
   */
  insertFileReferences(references: readonly ReferenceInsert[]): boolean {
    if (references.length === 0) return true;
    let applied = false;
    this.applyEdit(
      () => {
        const projection = $projectComposer((key) => this.occurrenceIdOf(key));
        const at = projection.selection?.end ?? projection.detectText.length;
        const before = projection.detectText.slice(0, at);
        const nodes = references.flatMap((ref) => [$createReferenceChipNode(ref), $createTextNode(' ')]);
        if (before !== '' && !/\s$/u.test(before)) nodes.unshift($createTextNode(' '));
        applied = $replaceDetectSpanWithNodes({ start: at, end: at }, nodes);
      },
      PASTE_TAG,
    );
    return applied;
  }

  /**
   * 按上层的后缀裁决清空已提交内容。
   * @param prefixLength - 返回要移除的 clipboard 前缀长度,或 null 表示整篇清空。
   */
  clearCommittedDraft(prefixLength: (clipboardText: string) => number | null): void {
    this.editor.update(
      () => {
        const layout = $composerLayout();
        const length = prefixLength(layout.clipboardText);
        if (length !== null) {
          $replaceDetectSpanWithText({ start: 0, end: detectOffsetOfClipboardOffset(layout, length) }, '');
          return;
        }
        const root = $getRoot();
        root.clear();
        root.selectEnd();
      },
      { discrete: true, tag: HISTORY_MERGE_TAG },
    );
  }

  /**
   * 用「clipboard 文本 + occurrence」恢复草稿,chip 重新铸成真实节点。
   * @param draft - clipboard 文本。
   * @param occurrences - detect 坐标下的 occurrence(升序)。
   */
  restoreDraft(draft: string, occurrences: readonly Occurrence[]): void {
    this.editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        let paragraph = $createParagraphNode();
        root.append(paragraph);
        const appendText = (text: string): void => {
          const lines = text.replace(REFERENCE_PLACEHOLDER_RE, '').split('\n');
          for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i];
            if (line !== '') paragraph.append($createTextNode(line));
            if (i < lines.length - 1) {
              paragraph = $createParagraphNode();
              root.append(paragraph);
            }
          }
        };
        let cursor = 0;
        for (const occurrence of occurrences) {
          appendText(draft.slice(cursor, occurrence.offset));
          paragraph.append(
            new ReferenceChipNode(
              {
                source: occurrence.source,
                ref: occurrence.ref,
                label: occurrence.label,
                clipboardText: occurrence.clipboardText,
              },
              occurrence.invalid === true,
            ),
          );
          cursor = occurrence.offset + 1;
        }
        appendText(draft.slice(cursor));
        root.selectEnd();
      },
      { discrete: true, tag: HISTORY_MERGE_TAG },
    );
  }

  /** 提交清空或草稿恢复之后,切断编辑器的撤销历史。 */
  clearHistory(): void {
    this.editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
  }
}