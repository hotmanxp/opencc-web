// Extracted verbatim from MessageBubble.tsx (formerly lines 39-228):
// - markdownComponents custom renderer map (p/h1-h4/ul/ol/li/code/pre/table/thead/tbody/tr/th/td/blockquote/a/hr)
// - MarkdownText memoized wrapper around ReactMarkdown + remark-gfm
// - CODE_BG / CODE_FONT_FAMILY constants
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
import remarkGfm from "remark-gfm";

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
    return (
      <code
        className="bg-transparent text-[#a78bfa] py-[1px] px-[6px] rounded-[3px] text-[0.9em] font-[ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace] font-medium"
      >
        {children}
      </code>
    );
  }
  const text = String(children).replace(/\n$/, "");
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

const markdownComponents = {
  p: ({ children }: any) => <p className="mb-2">{children}</p>,
  h1: ({ children }: any) => (
    <h1 className="text-[20px] font-semibold my-3 mb-2">{children}</h1>
  ),
  h2: ({ children }: any) => (
    <h2 className="text-[18px] font-semibold my-3 mb-2">{children}</h2>
  ),
  h3: ({ children }: any) => (
    <h3 className="text-base font-semibold my-[10px] mb-[6px]">{children}</h3>
  ),
  h4: ({ children }: any) => (
    <h4 className="text-[14px] font-semibold my-2 mb-1">{children}</h4>
  ),
  ul: ({ children }: any) => (
    <ul className="mb-2 pl-5">{children}</ul>
  ),
  ol: ({ children }: any) => (
    <ol className="mb-2 pl-5">{children}</ol>
  ),
  li: ({ children }: any) => <li className="mb-1">{children}</li>,
  code: CodeBlock,
  pre: ({ children }: any) => <>{children}</>,
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
      {children}
    </th>
  ),
  td: ({ children }: any) => (
    <td
      className="py-[6px] px-[10px] border border-[var(--border-light)]"
    >
      {children}
    </td>
  ),
  blockquote: ({ children }: any) => (
    <blockquote
      className="border-l-[3px] border-l-[var(--border-mid)] pl-3 my-1 mb-2 text-[var(--text-dim-70)]"
    >
      {children}
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
  }, [text]);

  return (
    <div
      className="text-[14px] leading-[1.6] break-words"
      style={{ color: "inherit" }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});