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
 * - `rehypeKatexContainer`:rehype-katex 跑完后,把块级 KaTeX 输出
 *   (`<span class="katex-display">...</span>`)包成自定义元素 `<math-block>`,
 *   这样 react-markdown 的 components 映射就能把它接到 MathBlock 组件
 *   —— 加上头部条 / 菜单 / 全屏 portal。行内公式(`<span class="katex">`)
 *   留在正文流,不动。**必须排在 rehype-katex 之后**,因为我们要找的是
 *   KaTeX 渲染好的产物,不是原始 math 节点。
 *
 * 配套的 KaTeX 样式由渲染入口 `import "katex/dist/katex.min.css"` 引入
 * (见 MarkdownText.tsx / TaskDrawer.tsx)。静态引入不拖首屏 —— CSS 里
 * @font-face 声明的字体由浏览器按需下载,页面上没出现公式就不会拉字体。
 */
import type { Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

// 自定义 hast 元素标签名 —— react-markdown 会在 components 映射里查
// `math-block` 这个 key。未知元素 react-markdown 会原样渲染,所以必须注册。
const MATH_BLOCK_TAG = "math-block";

// 极简 hast 节点结构 —— 我们只读 tagName / properties / children,没必要引
// `@types/hast`(transitive 已有,但 pnpm 严格模式下不直接 hoist,加 dep 浪费)。
interface HastElement {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}
interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function getClassNames(node: HastElement): string[] {
  const cls = node.properties?.className;
  if (Array.isArray(cls)) return cls.map(String);
  if (typeof cls === "string") return cls.split(/\s+/);
  return [];
}

/**
 * 把 <span class="katex-display">...</span> 包成 <math-block>...</math-block>。
 * 块级公式($$...$$)经 rehype-katex 渲染后的产物是 katex-display 节点;
 * 行内公式是 katex(无 -display),留在原位不动 —— 行内嵌在正文流,加容器
 * 会破坏排版。
 *
 * 用极简的内嵌 visitor,不引 unist-util-visit(rehype-katex 内部也是直接
 * 调 unist-util-visit-parents,我们的需求简单:替换兄弟元素就够)。
 *
 * Plugin 形态:unified 期望 attacher 是 `(options) => transformer`。我们
 * 不需要 options,所以工厂函数体为空,只返回 transformer。
 */
function rehypeKatexContainer() {
  return (tree: HastNode): void => {
    walk(tree);
  };
}

function walk(node: HastNode): void {
  if (!Array.isArray(node.children)) return;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (!child || child.type !== "element") continue;
    // 递归先于替换 —— 子树里可能还有 katex-display 节点(嵌套公式罕见但合法)
    walk(child);
    if (
      child.type === "element" &&
      child.tagName === "span" &&
      getClassNames(child as HastElement).includes("katex-display")
    ) {
      const wrapper: HastNode = {
        type: "element",
        tagName: MATH_BLOCK_TAG,
        properties: { "data-math-block": "" },
        children: [child],
      };
      node.children[i] = wrapper;
    }
  }
}

export const remarkPlugins: Options["remarkPlugins"] = [remarkGfm, remarkMath];

// 顺序敏感:rehype-katex 先跑把 math 节点转成 HTML,然后我们再包容器
export const rehypePlugins: Options["rehypePlugins"] = [
  [rehypeKatex, { throwOnError: false }],
  rehypeKatexContainer,
];
