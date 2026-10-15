/**
 * 输入面装配:滚动容器 > 内容块 > (可编辑面 / 占位提示 / chip portal)。
 *
 * 取代旧的三层结构(scroll > grow > backdrop + 透明 textarea + 隐藏 mirror):
 * contenteditable 自身就有真实高度,旧的 auto-grow 镜像层(measure → 写
 * 高度)整层删除。滚动封顶仍由 `.agent-input-scroll` 负责。
 *
 * 移植自 deepseek-harness `input/editor/DraftEditor.tsx`,砍掉 workspace
 * trigger / phase / hint 等 zai 没有的槽位。
 */
import type { CSSProperties, ReactNode, RefObject } from 'react';
import type { LexicalEditor } from 'lexical';
import { ComposerContentEditable } from './ComposerContentEditable.js';
import { DecoratorPortals } from './DecoratorPortals.js';

export interface ComposerSurfaceProps {
  /** 上层持有的编辑器;null 渲染惰性(不可编辑)的同一套 DOM */
  readonly editor: LexicalEditor | null;
  readonly editable: boolean;
  /** 滚动容器引用(输入区滚动 / 选中项可见性由上层消费) */
  readonly scrollRef: RefObject<HTMLDivElement>;
  /** 空草稿时显示的提示文案;null = 不显示 */
  readonly placeholder: string | null;
  /** 可编辑面自身的 class(沿用旧 textarea 的度量类名) */
  readonly editorClassName: string;
  /**
   * 命令参数模板的幽灵提示(如 `<patch|minor|major>`)。以 CSS 自定义属性
   * 交给生成内容渲染,不进文档树 —— 因此既不会被选中也不会被发送。
   */
  readonly hint?: string | null;
  /** 组合输入中:挂 data-composer-composing,让 placeholder/幽灵提示让位 */
  readonly composing?: boolean;
  /** 组合输入起止(IME 守卫的权威来源,见 input/editor/keymap.ts) */
  readonly onCompositionStart?: () => void;
  readonly onCompositionEnd?: () => void;
}

/**
 * 渲染输入面的完整 DOM。
 * @param props - 编辑器、可编辑性、滚动引用与占位文案。
 * @returns 滚动容器与可编辑面。
 */
export function ComposerSurface({
  editor,
  editable,
  scrollRef,
  placeholder,
  editorClassName,
  hint = null,
  composing = false,
  onCompositionStart,
  onCompositionEnd,
}: ComposerSurfaceProps): ReactNode {
  return (
    <div ref={scrollRef} className="agent-input-scroll" data-input-scroll>
      <div className="agent-input-grow">
        <ComposerContentEditable
          editor={editor}
          editable={editable}
          className={editorClassName}
          data-composer-composing={composing || undefined}
          data-testid="agent-input-editor"
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          aria-label="输入消息"
          style={
            hint === null
              ? undefined
              : ({ '--agent-input-hint': JSON.stringify(hint) } as CSSProperties)
          }
        />
        {placeholder !== null && (
          <div aria-hidden className="agent-input-placeholder">
            {placeholder}
          </div>
        )}
        <DecoratorPortals editor={editor} />
      </div>
    </div>
  );
}