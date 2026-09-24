// Lazy-loaded shim for react-syntax-highlighter. The actual import is
// huge (~610 KB raw, ~224 KB gzip) so it must NOT live in the initial
// bundle. MarkdownText dynamically imports this module the first time
// a fenced ```lang code block needs rendering; vite splits this file
// into its own chunk via the /* webpackChunkName */ comment.
// 两套配色同时导出:调用方按 <html data-theme> 选 oneDark(暗) / oneLight(亮)。
// 底色不依赖它们自带的 hljs background,统一走 --code-bg(CSS 变量),
// 保证高亮块与未高亮的占位块同底色、切主题不跳版。
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";

export { SyntaxHighlighter, oneDark, oneLight };
