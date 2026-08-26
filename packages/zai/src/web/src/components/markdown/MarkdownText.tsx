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
        style={{
          background: "transparent",
          color: "#a78bfa",
          padding: "1px 6px",
          borderRadius: 3,
          fontSize: "0.9em",
          fontFamily: CODE_FONT_FAMILY,
          fontWeight: 500,
        }}
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
        style={{
          margin: "6px 0 10px 0",
          padding: "12px 14px",
          borderRadius: 6,
          fontSize: 12,
          lineHeight: 1.55,
          background: CODE_BG,
          color: "var(--text-dim-85)",
          fontFamily: CODE_FONT_FAMILY,
          overflow: "auto",
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
  p: ({ children }: any) => <p style={{ margin: "0 0 8px 0" }}>{children}</p>,
  h1: ({ children }: any) => (
    <h1 style={{ fontSize: 20, fontWeight: 600, margin: "12px 0 8px 0" }}>
      {children}
    </h1>
  ),
  h2: ({ children }: any) => (
    <h2 style={{ fontSize: 18, fontWeight: 600, margin: "12px 0 8px 0" }}>
      {children}
    </h2>
  ),
  h3: ({ children }: any) => (
    <h3 style={{ fontSize: 16, fontWeight: 600, margin: "10px 0 6px 0" }}>
      {children}
    </h3>
  ),
  h4: ({ children }: any) => (
    <h4 style={{ fontSize: 14, fontWeight: 600, margin: "8px 0 4px 0" }}>
      {children}
    </h4>
  ),
  ul: ({ children }: any) => (
    <ul style={{ margin: "0 0 8px 0", paddingLeft: 20 }}>{children}</ul>
  ),
  ol: ({ children }: any) => (
    <ol style={{ margin: "0 0 8px 0", paddingLeft: 20 }}>{children}</ol>
  ),
  li: ({ children }: any) => <li style={{ marginBottom: 4 }}>{children}</li>,
  code: CodeBlock,
  pre: ({ children }: any) => <>{children}</>,
  table: ({ children }: any) => (
    <table
      style={{
        borderCollapse: "collapse",
        margin: "4px 0 8px 0",
        fontSize: 13,
        width: "100%",
      }}
    >
      {children}
    </table>
  ),
  thead: ({ children }: any) => (
    <thead style={{ background: "var(--bg-faint-05)" }}>{children}</thead>
  ),
  tbody: ({ children }: any) => <tbody>{children}</tbody>,
  tr: ({ children }: any) => (
    <tr style={{ borderBottom: "1px solid var(--border-light)" }}>
      {children}
    </tr>
  ),
  th: ({ children }: any) => (
    <th
      style={{
        padding: "6px 10px",
        textAlign: "left",
        fontWeight: 600,
        border: "1px solid var(--border-light)",
      }}
    >
      {children}
    </th>
  ),
  td: ({ children }: any) => (
    <td
      style={{
        padding: "6px 10px",
        border: "1px solid var(--border-light)",
      }}
    >
      {children}
    </td>
  ),
  blockquote: ({ children }: any) => (
    <blockquote
      style={{
        borderLeft: "3px solid var(--border-mid)",
        paddingLeft: 12,
        margin: "4px 0 8px 0",
        color: "var(--text-dim-70)",
      }}
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
      style={{ color: "#1677ff", textDecoration: "underline" }}
    >
      {children}
    </a>
  ),
  hr: () => (
    <hr
      style={{
        border: "none",
        borderTop: "1px solid var(--border-light)",
        margin: "12px 0",
      }}
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
      style={{
        fontSize: 14,
        lineHeight: 1.6,
        color: "inherit",
        wordBreak: "break-word",
      }}
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
