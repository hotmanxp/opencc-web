// MermaidBlock.tsx — ```mermaid``` fenced code block 的渲染入口
//
// MarkdownText 里的 CodeBlock 看到 className 匹配 `language-mermaid` 时
// 把 code 文本透传给本组件;本组件负责 lazy 加载 + 渲染 + sanitize +
// 主题切换重渲。
//
// 状态机:
//   loading — chunk 还没到,显示和 syntax highlighter 一致的 <pre> 占位
//   rendered — sanitize 后的 SVG 用 dangerouslySetInnerHTML 注入
//   error — 渲染失败/语法错/半截代码 → <details>{code}</details> 降级
//
// 主题切换:<html data-theme> 变化时 MutationObserver 触发 themeKey++,
// useEffect 依赖 themeKey 重渲 SVG。
//
// 尺寸:beautiful-mermaid 按文本度量算出绝对画布尺寸(如 1370x628),宽图会
// 顶破消息列。这里由外层容器强制「缩到全部可见」:
//   - svg 内联 max-width:100% + height:auto(见 mermaidRenderer.
//     makeSvgResponsive),等比缩到容器宽度,不做横向滚动;
//   - 缩放到 <100% 时工具栏浮出实时百分比提示(点它进全屏);
//   - 容器右上角常驻菜单:全屏预览(按视口再放大一次 + 居中,带 Esc/关闭
//     按钮)/ 复制源码。
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ensureMermaidBundle,
  hasMermaidBundle,
  mermaidDiagramLabel,
  naturalSvgWidth,
  renderMermaidDiagram,
  subscribeMermaidReady,
  type MermaidTheme,
} from "./mermaidRenderer.js";

// 复用 syntax highlighter 的占位样式常量,保持 layout 一致(MarkdownText.tsx:17-19)
const CODE_BG_FALLBACK = "#282c34";
const CODE_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

// 缩放到低于这个比例时,图里的字已经不太读得清,工具栏浮出「缩至 NN%」提示
// (点它直接进全屏)。
const SCALE_HINT_THRESHOLD = 0.85;

const TOOL_BUTTON_CLASS =
  "rounded border border-[var(--border-subtle)] bg-[var(--bg-card-hover)] px-1.5 py-0.5 " +
  "text-[10px] leading-[16px] text-[var(--text-tertiary)] cursor-pointer " +
  "hover:text-[var(--text-primary)] hover:border-[var(--border-active)]";
const MENU_ITEM_CLASS =
  "block w-full px-3 py-1.5 text-left text-xs whitespace-nowrap cursor-pointer " +
  "text-[var(--text-secondary)] hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-primary)]";

type State =
  | { status: "loading" }
  | { status: "rendered"; svg: string }
  | { status: "error"; message: string };

interface MermaidBlockProps {
  code: string;
}

// 半截代码启发式检测:围栏已闭合但内容可能未写完
// 见 plan § 半截代码启发式
export function looksComplete(code: string): boolean {
  const bracketBalanced =
    (code.match(/\[/g)?.length ?? 0) === (code.match(/\]/g)?.length ?? 0) &&
    (code.match(/\{/g)?.length ?? 0) === (code.match(/\}/g)?.length ?? 0);
  const hasEnd = /(?:^|\n)\s*end\s*(?:\n|$)/i.test(code);
  const lastLineOk = !/[[{]\s*$/.test(code.trimEnd());
  return bracketBalanced && (hasEnd || lastLineOk);
}

// 读 CSS 变量(默认浅/深色都覆盖到,所以 getComputedStyle 在 :root 上能拿到)
function readThemeTokens(): MermaidTheme {
  const cs = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string): string => {
    const v = cs.getPropertyValue(name).trim();
    return v || fallback;
  };
  return {
    bg: get("--bg-card", "#12121a"),
    fg: get("--text-primary", "#f8fafc"),
    line: get("--border-active", "#f97316"),
    accent: get("--accent-start", "#f97316"),
    muted: get("--text-tertiary", "#94a3b8"),
    surface: get("--bg-card-hover", "#1a1a2e"),
    border: get("--border-subtle", "rgba(249, 115, 22, 0.18)"),
    // rect 色块透明度按主题走(见 mermaidRenderer.applyRectBands)。
    // App.tsx 把生效主题写在 <html data-theme> 上,这里直接读,比从 CSS 颜色
    // 反推亮度可靠。
    mode: document.documentElement.dataset.theme === "light" ? "light" : "dark",
  };
}

/**
 * 实测渲染宽度 / 自然宽度 = 当前缩放比。容器宽度变化时经 ResizeObserver 重算。
 * happy-dom 等无布局环境下 getBoundingClientRect 全 0 → 保持默认 1,不显示提示。
 */
function useRenderScale(
  hostRef: React.RefObject<HTMLDivElement | null>,
  svg: string | null,
): number {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    if (!svg) return;
    const host = hostRef.current;
    if (!host) return;
    const measure = (): void => {
      const natural = naturalSvgWidth(svg);
      const svgEl = host.querySelector("svg");
      if (!natural || !svgEl) return;
      const rendered = svgEl.getBoundingClientRect().width;
      if (!rendered) return;
      setScale(rendered / natural);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, [hostRef, svg]);

  return scale;
}

export function MermaidBlock({ code }: MermaidBlockProps) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [themeKey, setThemeKey] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const lastCodeRef = useRef<string>(code);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const renderedSvg = state.status === "rendered" ? state.svg : null;
  const scale = useRenderScale(hostRef, renderedSvg);
  const label = mermaidDiagramLabel(code);

  // 主题切换监听:MutationObserver 触发 themeKey++,effect 重渲
  useEffect(() => {
    if (typeof document === "undefined") return;
    const obs = new MutationObserver(() => {
      // rAF 合并多次 attribute 变化,避免快速切换时连发重渲
      requestAnimationFrame(() => setThemeKey((k) => k + 1));
    });
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  }, []);

  // 主渲染 effect:依赖 code 和 themeKey
  useEffect(() => {
    if (!looksComplete(code)) {
      // 半截代码不渲染,降级源码占位;渲染效应不应该在后续 code 更新时再被触发
      lastCodeRef.current = code;
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });

    // 触发 lazy load(若未就绪)
    if (!hasMermaidBundle()) {
      ensureMermaidBundle();
    }

    const unsubscribe = subscribeMermaidReady(() => {
      // cache 就绪后由 renderMermaidDiagram 内部 async 跑(已 cached 不再 import)
      void runRender();
    });

    void runRender();

    async function runRender(): Promise<void> {
      // 给 dynamic import 一点点时间(典型本机 ~50ms),避免切到 error 前立刻切回 loading
      if (!hasMermaidBundle()) {
        await new Promise((r) => setTimeout(r, 16));
        if (cancelled) return;
      }
      const theme = readThemeTokens();
      const result = await renderMermaidDiagram(code, theme);
      if (cancelled) return;
      if (result.ok && result.svg) {
        setState({ status: "rendered", svg: result.svg });
      } else {
        setState({
          status: "error",
          message: result.message ?? "render failed",
        });
      }
    }

    lastCodeRef.current = code;
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [code, themeKey]);

  // 菜单:点击外部/Esc 关闭
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

  // 「已复制」提示 1.5s 后自动消失
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copySource = useCallback((): void => {
    setMenuOpen(false);
    try {
      const p = navigator.clipboard?.writeText(code);
      setCopied(true);
      // 权限被拒时把提示收回去(剪贴板 API 在非 https/未授权下会 reject)
      if (p && typeof p.catch === "function") p.catch(() => setCopied(false));
    } catch {
      setCopied(false);
    }
  }, [code]);

  const openFullscreen = useCallback((): void => {
    setMenuOpen(false);
    setFullscreen(true);
  }, []);

  // ---- DOM 渲染 ----------------------------------------------------------
  if (state.status === "rendered") {
    const scaledDown =
      Number.isFinite(scale) && scale > 0 && scale < SCALE_HINT_THRESHOLD;
    const percent = Math.round(scale * 100);

    return (
      <>
        {/* 外层容器 = 卡片(边框 + 头部条 + 图形区),宽度由容器钉住
            (w-full min-w-0 max-w-full,不让内容反推 ant-space-item 的
            min-width:auto);图形区交给 svg 的 max-width:100% 等比缩到容器宽度
            —— 图永远整张可见,不横向滚动。 */}
        <div
          data-testid="mermaid-block"
          className="relative my-2 w-full min-w-0 max-w-full rounded-md border border-[var(--border-light)] bg-[var(--bg-card)]"
        >
          {/* 头部条:左侧标题(图类型),右侧缩放提示 + 菜单 */}
          <div
            data-testid="mermaid-block-header"
            className="flex items-center justify-between gap-2 border-b border-[var(--border-light)] px-2.5 py-1"
          >
            <span
              className="truncate text-[11px] leading-[18px] text-[var(--text-tertiary)]"
              title={`Mermaid ${label}`}
            >
              Mermaid · {label}
            </span>

            <div className="flex shrink-0 items-center gap-1">
              {scaledDown && (
                <button
                  type="button"
                  data-testid="mermaid-block-scale"
                  className={TOOL_BUTTON_CLASS}
                  title="图已等比缩小以保证整张可见,点击全屏放大查看"
                  onClick={openFullscreen}
                >
                  缩至 {percent}%
                </button>
              )}
              <div className="relative" ref={menuRef}>
                <button
                  type="button"
                  data-testid="mermaid-block-menu-button"
                  aria-label="图表操作"
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
                    data-testid="mermaid-block-menu"
                    className="absolute right-0 top-full z-20 mt-1 min-w-[120px] rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] py-1 shadow-[0_4px_16px_rgba(0,0,0,0.35)]"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="mermaid-block-fullscreen-item"
                      className={MENU_ITEM_CLASS}
                      onClick={openFullscreen}
                    >
                      全屏预览
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className={MENU_ITEM_CLASS}
                      onClick={copySource}
                    >
                      {copied ? "已复制" : "复制源码"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div
            ref={hostRef}
            className="w-full min-w-0 p-3 [&_svg]:block [&_svg]:w-auto [&_svg]:h-auto [&_svg]:max-w-full"
            dangerouslySetInnerHTML={{ __html: state.svg }}
          />
        </div>

        {/* 全屏预览:portal 到 body,避免被消息列的 transform/overflow 裁掉。
            svg 同时受 max-w-full + max-h-full 约束 → 整张图按视口再放大一倍,
            居中显示;真正的放大读细节(比例由 preserveAspectRatio 维持)。 */}
        {fullscreen &&
          typeof document !== "undefined" &&
          createPortal(
            <div
              data-testid="mermaid-fullscreen"
              role="dialog"
              aria-modal="true"
              aria-label="Mermaid 图表全屏预览"
              className="fixed inset-0 z-[1200] flex flex-col bg-[var(--bg-card)]"
            >
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border-light)] px-4 py-2">
                <span className="truncate text-xs text-[var(--text-tertiary)]">
                  Mermaid · {label} · 全屏预览
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className={TOOL_BUTTON_CLASS}
                    onClick={copySource}
                  >
                    {copied ? "已复制" : "复制源码"}
                  </button>
                  <button
                    type="button"
                    data-testid="mermaid-fullscreen-close"
                    aria-label="关闭全屏预览"
                    className={TOOL_BUTTON_CLASS}
                    onClick={() => setFullscreen(false)}
                  >
                    ✕ 关闭
                  </button>
                </div>
              </div>
              <div
                className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4 [&_svg]:block [&_svg]:w-auto [&_svg]:h-auto [&_svg]:max-w-full [&_svg]:max-h-full"
                dangerouslySetInnerHTML={{ __html: state.svg }}
              />
            </div>,
            document.body,
          )}
      </>
    );
  }

  // 错误降级:details 折叠源码,同 CodeBlock fallback 风格但给可点开的错误提示
  if (state.status === "error") {
    return (
      <details
        data-testid="mermaid-block-error"
        className="my-2 rounded-md border border-[var(--border-light)] p-3"
      >
        <summary className="cursor-pointer text-[var(--text-tertiary)] text-xs">
          Mermaid 渲染失败 · 点击查看源码
        </summary>
        <pre
          className="mt-2 text-xs overflow-auto"
          style={{
            background: CODE_BG_FALLBACK,
            color: "var(--text-dim-85)",
            fontFamily: CODE_FONT_FAMILY,
            padding: "12px 14px",
            borderRadius: 6,
          }}
        >
          <code>{code}</code>
        </pre>
        <div className="text-[11px] text-[var(--text-tertiary)] mt-1">
          {state.message}
        </div>
      </details>
    );
  }

  // 半截代码 / loading:占位 <pre>,避免 layout shift
  return (
    <pre
      data-testid="mermaid-block-loading"
      className="my-[6px_0_10px_0] py-3 px-[14px] rounded-md text-xs leading-[1.55] overflow-auto"
      style={{
        background: CODE_BG_FALLBACK,
        color: "var(--text-dim-85)",
        fontFamily: CODE_FONT_FAMILY,
      }}
    >
      <code>{code}</code>
    </pre>
  );
}

// React.memo 包裹:code props 不变就不重渲,父级 MarkdownText 重渲时
// 子树稳定
export default React.memo(MermaidBlock);
