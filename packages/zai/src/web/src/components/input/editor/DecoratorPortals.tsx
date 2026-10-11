/**
 * 装饰节点渲染循环:把每个 chip 节点的 React 面 portal 进它的宿主元素
 * (@lexical/react 的 ContentEditable 内部就是干这件事,这里只保留本输入框
 * 需要的最小面)。chip 的 DOM 身份挂在 NodeKey 上 —— chip 周围的文本编辑
 * 不会导致它的 portal 重挂载。
 *
 * 移植自 deepseek-harness `input/editor/DecoratorPortals.tsx`。
 */
import * as React from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import type { LexicalEditor, NodeKey } from 'lexical';

export interface DecoratorPortalsProps {
  /** 已绑定的编辑器;null(无会话)不渲染任何东西 */
  readonly editor: LexicalEditor | null;
}

/**
 * 渲染每个装饰节点的 React 面。
 * @param props - 要观察的编辑器。
 * @returns 当前的 portal 集合。
 */
export function DecoratorPortals({ editor }: DecoratorPortalsProps): ReactNode {
  const [decorators, setDecorators] = React.useState<Record<NodeKey, React.JSX.Element>>(() =>
    editor === null ? {} : editor.getDecorators<React.JSX.Element>(),
  );
  React.useLayoutEffect(() => {
    if (editor === null) return;
    setDecorators(editor.getDecorators<React.JSX.Element>());
    return editor.registerDecoratorListener<React.JSX.Element>((next) => {
      setDecorators(next);
    });
  }, [editor]);
  if (editor === null) return null;
  return (
    <>
      {Object.entries(decorators).map(([key, jsx]) => {
        const el = editor.getElementByKey(key);
        return el === null ? null : createPortal(jsx, el, key);
      })}
    </>
  );
}