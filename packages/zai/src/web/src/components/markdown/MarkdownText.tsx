// Extracted verbatim from MessageBubble.tsx (formerly lines 39-228):
// - markdownComponents custom renderer map (p/h1-h4/ul/ol/li/code/pre/table/thead/tbody/tr/th/td/blockquote/a/hr)
// - MarkdownText memoized wrapper around ReactMarkdown + remark-gfm + remark-math/rehype-katex
// - CODE_BG / CODE_FONT_FAMILY constants
//
// 数学公式:插件链在 ./markdownPlugins.ts(与 TaskDrawer / SuperTaskDetailDrawer
// 共用),KaTeX 样式在这里引入 —— @font-face 的字体浏览器按需下载,没公式不拉。
//
// Code-block highlight is now lazy: react-syntax-highlighter (~610 KB raw,
// 224 KB gzip) is only fetched the first time a fenced ```lang block is
// rendered. Until the chunk arrives we render a plain <pre><code> so the
// user never sees a blank box. Once loaded, a cached effect re-renders
// highlighted code for the same text. CODE_BG / CODE_FONT_FAMILY are
// referenced from the lazy shim too — keep them here as the single source
// of truth.
import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import "katex/dist/katex.min.css";
import { remarkPlugins, rehypePlugins } from "./markdownPlugins.js";
import { MermaidBlock } from "./MermaidBlock.js";
import { MathBlock } from "./MathBlock.js";
import { ensureMermaidBundle, hasMermaidBundle } from "./mermaidRenderer.js";
import { FilePathChip } from "./FilePathChip.js";
import { isFilePath, splitFilePaths } from "../../lib/filePathDetect.js";

const CODE_BG = "#282c34";
const CODE_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

// react-syntax-highlighter + Prism stylesheet are ESM and huge. Loading
// both lazily defers ~610 KB out of the initial bundle. We resolve them
// via a dynamic import that vite splits into its own chunk; first fenced
// code block triggers the load. Until the chunk lands, the placeholder
// <pre> below keeps layout intact.
type SyntaxHighlighterComponent = React.ComponentType<{
  language?: string;
  style?: Record<string, React.CSSProperties>;
  customStyle?: React.CSSProperties;
  codeTagProps?: React.HTMLAttributes<HTMLElement>;
  wrapLongLines?: boolean;
  showLineNumbers?: boolean;
  children?: React.ReactNode;
}>;
type SyntaxLoader = {
  SyntaxHighlighter: SyntaxHighlighterComponent;
  oneDark: Record<string, React.CSSProperties>;
} | null;

// Module-scoped cache: once the dynamic import resolves, every MarkdownText
// instance shares the same component reference, avoiding re-fetches on
// remount. We also expose `subscribe` so a freshly mounted MarkdownText can
// learn about an already-cached value without waiting a tick.
let cachedHighlighter: SyntaxLoader = null;
const subscribers = new Set<() => void>();

function ensureSyntaxBundle(): Promise<SyntaxLoader> {
  if (cachedHighlighter) return Promise.resolve(cachedHighlighter);
  return import(
    /* webpackChunkName: "syntax-highlight" */
    "./syntaxHighlighter.js"
  ).then((m) => {
    cachedHighlighter = {
      SyntaxHighlighter: m.SyntaxHighlighter,
      oneDark: m.oneDark,
    };
    // Notify other waiting MarkdownText instances.
    subscribers.forEach((cb) => cb());
    subscribers.clear();
    return cachedHighlighter;
  });
}

const syntaxStylesheetInjected = { value: false };
// OneDark ships unhighlighted plaintext in some happy-dom test envs,
// and injects its own <style> at runtime in others. We don't import
// its CSS file (which would defeat lazy loading). For prod use, the
// bundled SyntaxHighlighter applies inline styles; no extra CSS needed.
void syntaxStylesheetInjected;

/**
 * 标记「这段 <code> 处于 fenced 代码块内」。
 * pre 是透明渲染(<>{children}</>),所以无语言标注的 ``` 块和行内代码
 * 传给 CodeBlock 的 props 完全一样 —— 只有靠 context 才能区分,
 * 否则一个内容恰好是 `package.json` 的代码块会被误判成文件 chip。
 */
const InFencedCode = React.createContext(false);

/**
 * Code-block renderer. Async-loads SyntaxHighlighter the first time any
 * fenced ```lang block appears. While the chunk is in flight (typically
 * a single tick on local builds) we fall back to a styled <pre><code>
 * with the same padding/mono font, so the user sees prose immediately.
 */
function CodeBlock({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  const inFenced = React.useContext(InFencedCode);
  const match = /language-(\w+)/.exec(className || "");
  const [hl, setHl] = useState<SyntaxLoader>(cachedHighlighter);

  useEffect(() => {
    if (cachedHighlighter || hl) return;
    let cancelled = false;
    const subscribe = () => {
      if (cancelled) return;
      setHl(cachedHighlighter);
    };
    if (!cachedHighlighter) {
      subscribers.add(subscribe);
      void ensureSyntaxBundle();
    }
    return () => {
      cancelled = true;
      subscribers.delete(subscribe);
    };
  }, [hl]);

  if (!match) {
    // 行内代码:agent 输出里 `` `src/a.ts` `` 这种写法最常见,
    // 判定为文件路径就换成可点击 chip,否则保持原样。
    // 围栏代码块(哪怕没有语言标注)一律不进这个分支。
    const inline = String(children).trim();
    if (!inFenced && isFilePath(inline)) return <FilePathChip path={inline} />;
    return (
      <code
        className="bg-transparent text-[#a78bfa] py-[1px] px-[6px] rounded-[3px] text-[0.9em] font-[ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace] font-medium"
      >
        {children}
      </code>
    );
  }
  const text = String(children).replace(/\n$/, "");
  // Mermaid 路由:```mermaid``` 块走独立渲染器(beautiful-mermaid + 自写正则
  // sanitize),见 mermaidRenderer.ts。其它语言继续走 syntax highlighter。
  if (match[1] === "mermaid") {
    return <MermaidBlock code={text} />;
  }
  if (!hl) {
    // Fallback: identical padding/colors to the highlighted block so the
    // layout doesn't jump when SyntaxHighlighter arrives a tick later.
    return (
      <pre
        className="my-[6px_0_10px_0] py-3 px-[14px] rounded-md text-xs leading-[1.55] overflow-auto"
        style={{
          background: CODE_BG,
          color: "var(--text-dim-85)",
          fontFamily: CODE_FONT_FAMILY,
        }}
      >
        <code>{text}</code>
      </pre>
    );
  }
  const { SyntaxHighlighter, oneDark } = hl;
  return (
    <SyntaxHighlighter
      language={match[1]}
      style={oneDark}
      customStyle={{
        margin: "6px 0 10px 0",
        padding: "12px 14px",
        borderRadius: 6,
        fontSize: 12,
        lineHeight: 1.55,
        background: CODE_BG,
      }}
      codeTagProps={{
        style: { fontFamily: CODE_FONT_FAMILY },
      }}
      wrapLongLines={false}
      showLineNumbers={false}
    >
      {text}
    </SyntaxHighlighter>
  );
}

/**
 * 把已渲染成 React 节点的正文再扫一遍:命中文件路径的纯文本换成可点击 chip。
 * 行内代码走 CodeBlock 自己的分支,这里只捞"裸文本"(agent 常在正文里直接
 * 写 `改好了 src/a.ts`)。
 *
 * 为什么在 React 子树里做而不是写 remark 插件:
 *   - 到这一步行内代码 / 链接 / 代码块已经是元素(children 非 string),天然跳过,
 *     不用维护一份 AST 白名单(插件访问不到这些区别,反而容易误伤链接文字);
 *   - 不必为类型引入 @types/mdast(pnpm 严格 node_modules 下要单独声明依赖)。
 * 代价是纯 O(len) 的字符串扫描,发生在段落级渲染,可忽略。
 */
function renderWithFilePaths(node: React.ReactNode): React.ReactNode {
  if (typeof node === "string") {
    const segments = splitFilePaths(node);
    if (segments.length === 1 && segments[0]?.kind === "text") return node;
    return segments.map((seg, i) =>
      seg.kind === "path" ? <FilePathChip key={i} path={seg.value} /> : seg.value,
    );
  }
  if (Array.isArray(node)) {
    // 只有真的出现路径才重建数组 —— 普通段落原样返回,不额外套 Fragment
    let changed = false;
    const next = node.map((child) => {
      const rendered = renderWithFilePaths(child);
      if (rendered !== child) changed = true;
      return rendered;
    });
    return changed
      ? next.map((child, i) => <React.Fragment key={i}>{child}</React.Fragment>)
      : node;
  }
  return node;
}

const markdownComponents = {
  p: ({ children }: any) => <p className="mb-2">{renderWithFilePaths(children)}</p>,
  h1: ({ children }: any) => (
    <h1 className="text-[20px] font-semibold my-3 mb-2">{renderWithFilePaths(children)}</h1>
  ),
  h2: ({ children }: any) => (
    <h2 className="text-[18px] font-semibold my-3 mb-2">{renderWithFilePaths(children)}</h2>
  ),
  h3: ({ children }: any) => (
    <h3 className="text-base font-semibold my-[10px] mb-[6px]">{renderWithFilePaths(children)}</h3>
  ),
  h4: ({ children }: any) => (
    <h4 className="text-[14px] font-semibold my-2 mb-1">{renderWithFilePaths(children)}</h4>
  ),
  ul: ({ children }: any) => (
    <ul className="mb-2 pl-5">{children}</ul>
  ),
  ol: ({ children }: any) => (
    <ol className="mb-2 pl-5">{children}</ol>
  ),
  li: ({ children }: any) => <li className="mb-1">{renderWithFilePaths(children)}</li>,
  code: CodeBlock,
  // 块级公式容器 —— 由 markdownPlugins.ts 的 rehypeKatexContainer 注入。
  // 行内公式不在这里处理,直接走 .katex(嵌在正文流)。
  "math-block": ({ children }: any) => <MathBlock>{children}</MathBlock>,
  // 透明渲染,只负责给内部 <code> 打上「在围栏块里」的标记(见 InFencedCode)
  pre: ({ children }: any) => (
    <InFencedCode.Provider value={true}>{children}</InFencedCode.Provider>
  ),
  table: ({ children }: any) => (
    <table
      className="border-collapse my-1 mb-2 text-[13px] w-full"
    >
      {children}
    </table>
  ),
  thead: ({ children }: any) => (
    <thead className="bg-[var(--bg-faint-05)]">{children}</thead>
  ),
  tbody: ({ children }: any) => <tbody>{children}</tbody>,
  tr: ({ children }: any) => (
    <tr className="border-b border-[var(--border-light)]">
      {children}
    </tr>
  ),
  th: ({ children }: any) => (
    <th
      className="py-[6px] px-[10px] text-left font-semibold border border-[var(--border-light)]"
    >
      {renderWithFilePaths(children)}
    </th>
  ),
  td: ({ children }: any) => (
    <td
      className="py-[6px] px-[10px] border border-[var(--border-light)]"
    >
      {renderWithFilePaths(children)}
    </td>
  ),
  blockquote: ({ children }: any) => (
    <blockquote
      className="border-l-[3px] border-l-[var(--border-mid)] pl-3 my-1 mb-2 text-[var(--text-dim-70)]"
    >
      {renderWithFilePaths(children)}
    </blockquote>
  ),
  a: ({ href, children }: any) => (
    <a
      href={href}
      aria-label={`外部链接 ${typeof children === 'string' ? children : ''}`}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[#1677ff] underline"
    >
      {children}
    </a>
  ),
  hr: () => (
    <hr
      className="border-none border-t border-t-[var(--border-light)] my-3"
    />
  ),
};

export const MarkdownText = React.memo(function MarkdownText({ text }: { text: string }) {
  // Auto-warm SyntaxHighlighter if the message is large or contains a
  // fenced code marker, so by the time the user scrolls down the chunk
  // is already cached. We avoid warming on small prose-only messages to
  // keep low-cost renders truly low-cost.
  const warmedRef = useRef(false);
  useEffect(() => {
    if (warmedRef.current) return;
    if (cachedHighlighter) return;
    if (text.length > 256 && /```/.test(text)) {
      warmedRef.current = true;
      void ensureSyntaxBundle();
    }
    // Mermaid renderer 也按需预热(cache 由 ensureMermaidBundle 内部接管),
    // 等真正看到 mermaid 块时已就绪
    if (!hasMermaidBundle() && /```mermaid\b/.test(text)) {
      ensureMermaidBundle();
    }
  }, [text]);

  return (
    <div
      className="text-[14px] leading-[1.6] break-words"
      style={{ color: "inherit" }}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={markdownComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});