// Lazy-loaded shim for react-syntax-highlighter. The actual import is
// huge (~610 KB raw, ~224 KB gzip) so it must NOT live in the initial
// bundle. MarkdownText dynamically imports this module the first time
// a fenced ```lang code block needs rendering; vite splits this file
// into its own chunk via the /* webpackChunkName */ comment.
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

export { SyntaxHighlighter, oneDark };
