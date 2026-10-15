/**
 * 输入面的 DOM 辅助:滚动容器内的选区可见性与聚焦。
 *
 * 移植自 deepseek-harness `input/editor/view-binding.ts`(只取输入框自身
 * 需要的两个函数;wheel 转交对话层、文件选择器绑定等由各自组件负责)。
 */
import type { LexicalEditor } from 'lexical';
import type { RefObject } from 'react';

/**
 * 在输入框自己的滚动容器里把 DOM 选区滚进可视范围。
 * @param scrollRef - 输入框的滚动容器引用。
 */
export function revealDraftSelection(scrollRef: RefObject<HTMLDivElement | null>): void {
  const scrollEl = scrollRef.current;
  if (scrollEl === null || scrollEl.scrollHeight <= scrollEl.clientHeight) return;
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  let rect = range.getBoundingClientRect();
  if (rect.height === 0 && rect.width === 0) {
    // 空行上的折叠光标在部分引擎里量出零矩形:锚点元素的盒子就是那一行
    const anchor = selection.anchorNode;
    const el = anchor instanceof HTMLElement ? anchor : anchor?.parentElement;
    if (el === undefined || el === null) return;
    rect = el.getBoundingClientRect();
  }
  const box = scrollEl.getBoundingClientRect();
  if (rect.bottom > box.bottom) scrollEl.scrollTop += rect.bottom - box.bottom;
  else if (rect.top < box.top) scrollEl.scrollTop -= box.top - rect.top;
}

/**
 * 聚焦编辑器并让它把选区滚进可视范围。
 * @param editor - 输入框的编辑器。
 * @param revealSelection - Lexical 恢复选区之后执行的回调。
 */
export function focusComposer(editor: LexicalEditor, revealSelection: () => void): void {
  // Lexical 的 focus() 只恢复编辑器选区,不触发 DOM 聚焦;
  // preventScroll 避免把对话层也滚一下
  editor.getRootElement()?.focus({ preventScroll: true });
  editor.focus(() => {
    revealSelection();
  });
}