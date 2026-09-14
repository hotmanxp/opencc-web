// 块级数学公式容器 —— 仿 MermaidBlock 的卡片化 + 全屏 portal 模式。
//
// 来源:rehype-katex 把 $$...$$ 渲染成 <span class="katex-display">...</span>。
// 上游的 rehype 包装插件(见 ./markdownPlugins.ts)把这个 span 包成自定义元素
// <math-block>{...}</math-block>,本组件在 react-markdown 的 components 映射
// 里接管这个元素,加上头部条 / 菜单 / 全屏。
//
// 范围:只处理块级公式。行内 $...$ 由 KaTeX 直接渲染,不包容器 —— 行内公式嵌在
// 正文流里,加头部条会破坏排版。
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// 与 MermaidBlock 共用同一组工具按钮样式,保持两块代码视觉一致。
const TOOL_BUTTON_CLASS =
  "rounded border border-[var(--border-subtle)] bg-[var(--bg-card-hover)] px-1.5 py-0.5 " +
  "text-[10px] leading-[16px] text-[var(--text-tertiary)] cursor-pointer " +
  "hover:text-[var(--text-primary)] hover:border-[var(--border-active)]";
const MENU_ITEM_CLASS =
  "block w-full px-3 py-1.5 text-left text-xs whitespace-nowrap cursor-pointer " +
  "text-[var(--text-secondary)] hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-primary)]";

export interface MathBlockProps {
  /**
   * 已渲染的 KaTeX DOM(由 react-markdown 传入)。原本是
   * `<span class="katex-display"><span class="katex">...</span></span>`。
   */
  children?: React.ReactNode;
}

/**
 * 从已渲染的 KaTeX 节点里提取 LaTeX 源码,供「复制源码」用。
 * 优先级:.katex-mathml 里的 annotation(语义 MathML,最准) > .katex 文本
 * 近似(可能丢空白)。
 */
function extractLatex(node: React.ReactNode): string {
  // 1. 找 .katex-mathml > annotation[encoding="application/x-tex"]
  const collected = collectLatexFromDom(node);
  if (collected) return collected;
  return collapseText(node).trim();
}

function collectLatexFromDom(node: React.ReactNode): string | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const got = collectLatexFromDom(child);
      if (got) return got;
    }
    return null;
  }
  const el = node as React.ReactElement<{
    className?: string;
    children?: React.ReactNode;
    "encoding"?: string;
  }>;
  if (!el || typeof el !== "object" || !("props" in el)) return null;
  const props = el.props ?? {};
  const cls = typeof props.className === "string" ? props.className.split(/\s+/) : [];
  // annotation[encoding=application/x-tex] 携带完整 LaTeX 源
  if (el.type === "annotation" && props.encoding === "application/x-tex") {
    const txt = collapseText(props.children);
    if (txt) return txt;
  }
  // 递归(优先 .katex-mathml 路径)
  if (cls.includes("katex-mathml")) {
    const got = collectLatexFromDom(props.children);
    if (got) return got;
  }
  return collectLatexFromDom(props.children);
}

function collapseText(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collapseText).join("");
  const el = node as React.ReactElement<{ children?: React.ReactNode }>;
  return el && "props" in el ? collapseText(el.props?.children) : "";
}

export function MathBlock({ children }: MathBlockProps) {
  const [fullscreen, setFullscreen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const latex = React.useMemo(() => extractLatex(children), [children]);
  // 显示用的简短标题(超长截断,只用于头部条)
  const shortLabel = latex.length > 60 ? `${latex.slice(0, 60)}…` : latex;
  const fullLabel = latex || "公式";

  const copySource = useCallback((): void => {
    setMenuOpen(false);
    try {
      const p = navigator.clipboard?.writeText(latex);
      setCopied(true);
      if (p && typeof p.catch === "function") p.catch(() => setCopied(false));
    } catch {
      setCopied(false);
    }
  }, [latex]);

  const openFullscreen = useCallback((): void => {
    setMenuOpen(false);
    setFullscreen(true);
  }, []);

  // 菜单:点击外部 / Esc 关闭
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  // 全屏:Esc 关闭 + 锁背景滚动
  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setFullscreen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [fullscreen]);

  // 「已复制」1.5s 自动消失
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <>
      {/* 卡片容器:头部条(标签 + 菜单)+ 主体(KaTeX 渲染产物)。
          与 MermaidBlock 视觉对齐,共用同一组 CSS 变量与工具按钮样式。 */}
      <div
        data-testid="math-block"
        className="relative my-2 w-full min-w-0 max-w-full rounded-md border border-[var(--border-light)] bg-[var(--bg-card)]"
      >
        <div
          data-testid="math-block-header"
          className="flex items-center justify-between gap-2 border-b border-[var(--border-light)] px-2.5 py-1"
        >
          <span
            className="truncate font-mono text-[11px] leading-[18px] text-[var(--text-tertiary)]"
            title={fullLabel}
          >
            KaTeX · {shortLabel || "公式"}
          </span>

          <div className="relative shrink-0" ref={menuRef}>
            <button
              type="button"
              data-testid="math-block-menu-button"
              aria-label="公式操作"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className={TOOL_BUTTON_CLASS}
              onClick={() => setMenuOpen((open) => !open)}
            >
              ⋯
            </button>
            {menuOpen && (
              <div
                role="menu"
                data-testid="math-block-menu"
                className="absolute right-0 top-full z-20 mt-1 min-w-[120px] rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] py-1 shadow-[0_4px_16px_rgba(0,0,0,0.35)]"
              >
                <button
                  type="button"
                  role="menuitem"
                  data-testid="math-block-fullscreen-item"
                  className={MENU_ITEM_CLASS}
                  onClick={openFullscreen}
                >
                  全屏预览
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="math-block-copy-item"
                  className={MENU_ITEM_CLASS}
                  onClick={copySource}
                >
                  {copied ? "已复制" : "复制 LaTeX"}
                </button>
              </div>
            )}
          </div>
        </div>

        <div
          data-testid="math-block-body"
          className="w-full min-w-0 overflow-x-auto p-3 text-center"
        >
          {children}
        </div>
      </div>

      {/* 全屏预览:portal 到 body,避免被消息列的 transform/overflow 裁掉。 */}
      {fullscreen &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            data-testid="math-fullscreen"
            role="dialog"
            aria-modal="true"
            aria-label="公式全屏预览"
            className="fixed inset-0 z-[1200] flex flex-col bg-[var(--bg-card)]"
          >
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border-light)] px-4 py-2">
              <span className="truncate font-mono text-xs text-[var(--text-tertiary)]">
                KaTeX · 全屏预览
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className={TOOL_BUTTON_CLASS}
                  onClick={copySource}
                >
                  {copied ? "已复制" : "复制 LaTeX"}
                </button>
                <button
                  type="button"
                  data-testid="math-fullscreen-close"
                  aria-label="关闭全屏预览"
                  className={TOOL_BUTTON_CLASS}
                  onClick={() => setFullscreen(false)}
                >
                  ✕ 关闭
                </button>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6 text-center [&_.katex-display]:m-0">
              <div className="text-[1.5em]">{children}</div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

export default React.memo(MathBlock);
