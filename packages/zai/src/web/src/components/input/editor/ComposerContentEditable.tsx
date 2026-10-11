/**
 * 输入面的 contenteditable 宿主:把一个上层持有的 Lexical 编辑器绑到常驻
 * div 上。`editor` 为 null 时渲染同一个 DOM 但不可编辑(会话未就绪态),
 * 这样两种态之间切换不会重建元素树。
 *
 * 移植自 deepseek-harness `input/editor/ComposerContentEditable.tsx`。
 */
import { useLayoutEffect, useRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import type { LexicalEditor } from 'lexical';

export interface ComposerContentEditableProps extends HTMLAttributes<HTMLDivElement> {
  /** 上层持有的编辑器;null 渲染同一个未绑定的 div(惰性态) */
  readonly editor: LexicalEditor | null;
  /** 用户是否可编辑(只读 / 禁用态都折进这里) */
  readonly editable: boolean;
}

/**
 * 渲染输入框的可编辑面。
 * @param props - 编辑器绑定、可编辑性与 div 透传属性。
 * @returns 常驻的 contenteditable div。
 */
export function ComposerContentEditable({
  editor,
  editable,
  ...rest
}: ComposerContentEditableProps): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (editor === null || el === null) return;
    editor.setRootElement(el);
    return () => {
      editor.setRootElement(null);
    };
  }, [editor]);
  useLayoutEffect(() => {
    if (editor !== null) editor.setEditable(editable);
  }, [editor, editable]);
  return (
    <div
      ref={ref}
      // Lexical 的 setRootElement 不碰 contenteditable:由这里渲染,
      // 上面那个 effect 负责把编辑器自己的开关对齐
      contentEditable={editor !== null && editable}
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      data-composer-input=""
      {...rest}
    />
  );
}