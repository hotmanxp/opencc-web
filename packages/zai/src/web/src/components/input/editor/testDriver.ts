/**
 * 测试驱动的输入面辅助(happy-dom)。
 *
 * 输入面已经是 Lexical contenteditable,`fireEvent.change` 那套「改 value」
 * 的写法对它无效,而 happy-dom 里也没有真实输入法可派发按键。因此测试
 * 走编辑器的命令面:从根元素拿到编辑器实例,用 `insertText` 模拟打字,
 * 用真实 `keydown` 事件走 Lexical → keymap 的完整分发(含 IME 守卫与
 * Enter 仲裁)。这样测试仍覆盖用户真实路径,而不是绕开 keymap 直接调
 * 组件内部函数。
 *
 * 仅被 *.test.tsx 引用,应用代码不导入。
 */
import { act } from "@testing-library/react";
import { $getRoot } from "lexical";
import type { LexicalEditor } from "lexical";
import { $composerLayout } from "./projection.js";
import { $selectDetectSpan } from "./span-map.js";

/** 取输入面的 contenteditable 根元素 */
export function editorRoot(container?: HTMLElement): HTMLElement {
  const scope = container ?? document;
  const el = scope.querySelector<HTMLElement>('[data-testid="agent-input-editor"]');
  if (el === null) throw new Error("输入面未挂载:[data-testid=agent-input-editor] 不存在");
  return el;
}

/**
 * 取编辑器实例。Lexical 把 `__lexicalEditor` 挂在根元素上(与 devtools
 * 同一入口),测试无需组件额外导出句柄。
 * @param el - contenteditable 根元素。
 * @returns 该元素绑定的编辑器。
 */
export function editorOf(el: HTMLElement): LexicalEditor {
  const editor = (el as unknown as { __lexicalEditor?: LexicalEditor }).__lexicalEditor;
  if (editor === undefined) throw new Error("该元素未绑定 Lexical 编辑器");
  return editor;
}

/**
 * 整段替换草稿(等价于「清空后一次性输入」,用于铺设测试前置状态)。
 * @param el - 输入面根元素。
 * @param text - 目标草稿文本。
 */
export function setDraftText(el: HTMLElement, text: string): void {
  const editor = editorOf(el);
  act(() => {
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        if (text === "") return;
        // 空 root 上 selectEnd + insertText 会自动长出首段,与真实输入一致
        root.selectEnd().insertText(text);
      },
      { discrete: true },
    );
  });
}

/**
 * 在光标处追加文本(模拟逐字打字)。
 * @param el - 输入面根元素。
 * @param text - 追加文本。
 */
export function typeIntoEditor(el: HTMLElement, text: string): void {
  const editor = editorOf(el);
  act(() => {
    editor.update(
      () => {
        $getRoot().selectEnd().insertText(text);
      },
      { discrete: true },
    );
  });
}

/**
 * 在输入面上派发一次真实 keydown(Lexical 内部把它翻译成命令分发)。
 * @param el - 输入面根元素。
 * @param key - 键名。
 * @param init - 其余 KeyboardEvent 字段(shiftKey / isComposing 等)。
 */
export function pressEditorKey(el: HTMLElement, key: string, init: KeyboardEventInit = {}): void {
  // 包在 act 里:keymap 的仲裁会 setState(高亮索引),不刷出的话下一次按键
  // 拿到的是上一次渲染的闭包,测试就会读到过期状态。
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true, ...init }),
    );
  });
}

/** Enter 发送(无修饰键) */
export function pressEnter(el: HTMLElement): void {
  pressEditorKey(el, "Enter");
}

/** 读取输入面当前的可见文本(装饰节点按其可复制投影展开) */
export function draftTextOf(el: HTMLElement): string {
  return el.textContent ?? "";
}

/**
 * 读取输入面的 detect 投影文本(chip 记作 1 个 U+FFFC)—— 应用层真正拿去
 * 做 token 探测的那份坐标文本。
 * @param el - 输入面根元素。
 * @returns detectText。
 */
export function detectTextOf(el: HTMLElement): string {
  return editorOf(el)
    .getEditorState()
    .read(() => $composerLayout().detectText);
}

/**
 * 把光标放到 detect 坐标的指定偏移(折叠选区)。
 * @param el - 输入面根元素。
 * @param offset - detect 下标。
 */
export function setCaretAt(el: HTMLElement, offset: number): void {
  const editor = editorOf(el);
  act(() => {
    editor.update(
      () => {
        $selectDetectSpan({ start: offset, end: offset });
      },
      { discrete: true },
    );
  });
}

/**
 * 查找承载激活 token 高亮的文本片段(行内样式 `--cmd-token-color`)。
 * @param container - 搜索范围,通常传 render 的 container。
 * @returns 命中的元素,没有则 null。
 */
export function tokenMarkOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[style*="--cmd-token-color"]');
}