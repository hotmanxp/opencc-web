/**
 * ReactMarkdown 的 remark / rehype 插件链 —— 单一来源。
 *
 * 三处 ReactMarkdown 实例(markdown/MarkdownText.tsx、TaskDrawer.tsx、
 * superTasks/SuperTaskDetailDrawer.tsx)共用这一份,否则同一段文本在主对话 /
 * 任务抽屉 / 超级任务抽屉里的渲染结果会不一致。
 *
 * - `remark-math`:把 `$...$`(行内)与 `$$...$$`(块级)解析成 math 节点。
 *   单 `$` 行内是刻意保留的 —— 模型输出公式的主流写法就是它,关掉
 *   (`singleDollarTextMath: false`)会让绝大多数公式失效。
 * - `rehype-katex`:把 math 节点交给 KaTeX 转成 HTML。
 *   `throwOnError: false` 是必需的:`$HOME ... $PATH` 这类 shell 变量会被
 *   误判成行内公式,KaTeX 解析失败时应当降级为原文,而不是把整条消息打崩。
 *
 * 配套的 KaTeX 样式由渲染入口 `import "katex/dist/katex.min.css"` 引入
 * (见 MarkdownText.tsx / TaskDrawer.tsx)。静态引入不拖首屏 —— CSS 里
 * @font-face 声明的字体由浏览器按需下载,页面上没出现公式就不会拉字体。
 */
import type { Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

export const remarkPlugins: Options["remarkPlugins"] = [remarkGfm, remarkMath];

export const rehypePlugins: Options["rehypePlugins"] = [
  [rehypeKatex, { throwOnError: false }],
];
