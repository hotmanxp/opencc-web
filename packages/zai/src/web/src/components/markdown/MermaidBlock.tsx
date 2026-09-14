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
import React, { useEffect, useRef, useState } from "react";
import {
  ensureMermaidBundle,
  hasMermaidBundle,
  renderMermaidDiagram,
  subscribeMermaidReady,
  type MermaidTheme,
} from "./mermaidRenderer.js";

// 复用 syntax highlighter 的占位样式常量,保持 layout 一致(MarkdownText.tsx:17-19)
const CODE_BG_FALLBACK = "#282c34";
const CODE_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

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
  };
}

export function MermaidBlock({ code }: MermaidBlockProps) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [themeKey, setThemeKey] = useState(0);
  const lastCodeRef = useRef<string>(code);

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

  // ---- DOM 渲染 ----------------------------------------------------------
  if (state.status === "rendered") {
    return (
      <div
        data-testid="mermaid-block"
        className="my-2 rounded-md bg-[var(--bg-card)] p-3 overflow-auto"
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
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
