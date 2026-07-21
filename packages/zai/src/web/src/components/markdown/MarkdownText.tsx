// Extracted verbatim from MessageBubble.tsx (formerly lines 39-228):
// - markdownComponents custom renderer map (p/h1-h4/ul/ol/li/code/pre/table/thead/tbody/tr/th/td/blockquote/a/hr)
// - MarkdownText memoized wrapper around ReactMarkdown + remark-gfm
// - CODE_BG / CODE_FONT_FAMILY constants
// No behavior change — this is the same renderer used inside chat bubbles,
// now reusable for the FsTab file preview path.
import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

const CODE_BG = "#282c34";
const CODE_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

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
  code: ({ className, children }: any) => {
    const match = /language-(\w+)/.exec(className || "");
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
        {String(children).replace(/\n$/, "")}
      </SyntaxHighlighter>
    );
  },
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
    <thead style={{ background: "rgba(255,255,255,0.05)" }}>{children}</thead>
  ),
  tbody: ({ children }: any) => <tbody>{children}</tbody>,
  tr: ({ children }: any) => (
    <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
      {children}
    </tr>
  ),
  th: ({ children }: any) => (
    <th
      style={{
        padding: "6px 10px",
        textAlign: "left",
        fontWeight: 600,
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      {children}
    </th>
  ),
  td: ({ children }: any) => (
    <td
      style={{
        padding: "6px 10px",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      {children}
    </td>
  ),
  blockquote: ({ children }: any) => (
    <blockquote
      style={{
        borderLeft: "3px solid rgba(255,255,255,0.2)",
        paddingLeft: 12,
        margin: "4px 0 8px 0",
        color: "rgba(255,255,255,0.7)",
      }}
    >
      {children}
    </blockquote>
  ),
  a: ({ href, children }: any) => (
    <a
      href={href}
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
        borderTop: "1px solid rgba(255,255,255,0.08)",
        margin: "12px 0",
      }}
    />
  ),
};

export const MarkdownText = React.memo(function MarkdownText({ text }: { text: string }) {
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
