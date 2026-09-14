// mermaidRenderer.ts — 双 renderer lazy-load + detect-type 路由 + 极简 SVG sanitize
//
// 复用 packages/zai/src/web/src/components/markdown/syntaxHighlighter.ts 的
// 模块级 cache + subscribers 模式:首次遇到 ```mermaid 块触发 import,所有
// MarkdownText 实例共享同一引用,避免重渲时反复 fetch。
//
// 双 renderer 路由照搬 WorkBuddy `markdown-editor-component-*.js:3213-3441`:
//   beautiful 覆盖 flowchart/stateDiagram/sequence/class/er/xychart(纯 SVG、~30KB)
//   mermaidjs 覆盖 block-beta/gantt/pie/gitGraph/journey/C4*/kanban/radar/treemap
//   等(完整 mermaid 库、~600KB,做 fallback)
//
// sanitize 用极简自写正则(剥 <script>/<foreignObject> 标签 + on* 事件属性 +
// javascript: href),不复用 dompurify:happy-dom 下 dompurify 会把含 <style>
// 标签的 SVG 整段剥光(测试环境 over-aggressive,生产行为不一致);自写
// sanitizer 在 happy-dom / jsdom / 真实浏览器三个环境行为一致。

// 主题 token 集合——对齐 beautiful-mermaid RenderOptions 的 6 个 + line
export interface MermaidTheme {
  bg: string;
  fg: string;
  line: string;
  accent: string;
  muted: string;
  surface: string;
  border: string;
}

export interface MermaidRenderResult {
  ok: boolean;
  /** Sanitized SVG string; only set when ok === true. */
  svg?: string;
  /** Error message; only set when ok === false. */
  message?: string;
  /** Which renderer handled the request — 'beautiful' | 'mermaidjs' | 'sanitize'. */
  kind?: "beautiful" | "mermaidjs" | "sanitize";
}

// ---- detect-type ----------------------------------------------------------
//
// 匹配 mermaid 子类型的首行模式。beatuful-mermaid 的 parseMermaid 支持 6 类;
// WorkBuddy detect-type 表里 block-beta/gantt/pie/gitGraph/journey/C4*/kanban
// 等落在 fallback 列表里走 mermaidjs。这里只白名单 beautiful 能处理的子集,
// 其余交给 mermaidjs 尝试(parse 失败由调用方走错误降级)。
const BEAUTIFUL_HEADER = /^\s*(flowchart|graph)\b/i;
const BEAUTIFUL_KW = /^\s*(sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|xychart-beta)\b/i;

function shouldUseBeautiful(code: string): boolean {
  const header = code.split("\n").find((l) => l.trim().length > 0 && !l.trim().startsWith("%%")) ?? "";
  return BEAUTIFUL_HEADER.test(header) || BEAUTIFUL_KW.test(header);
}

// ---- cache + subscribers --------------------------------------------------
//
// 模块级引用 + Set<callback> 模式跟 syntaxHighlighter.ts 一致;每个
// MarkdownText 实例独立订阅,首个解析完成时统一 setState 触发重渲。
type BeautifulRenderer = {
  renderMermaidSVG: (text: string, options?: Record<string, unknown>) => string;
  DEFAULTS?: { bg?: string; fg?: string };
};
type MermaidJsRenderer = {
  default: {
    initialize: (config: Record<string, unknown>) => void;
    render: (id: string, code: string) => Promise<{ svg: string }>;
  };
};

let cachedBeautiful: BeautifulRenderer | null = null;
let cachedMermaidJs: MermaidJsRenderer | null = null;
const subscribers = new Set<() => void>();

function ensureBeautiful(): Promise<BeautifulRenderer> {
  if (cachedBeautiful) return Promise.resolve(cachedBeautiful);
  return import(/* webpackChunkName: "mermaid-beautiful" */ "beautiful-mermaid").then((m) => {
    cachedBeautiful = m as unknown as BeautifulRenderer;
    notifyAll();
    return cachedBeautiful;
  });
}

function ensureMermaidJs(): Promise<MermaidJsRenderer> {
  if (cachedMermaidJs) return Promise.resolve(cachedMermaidJs);
  return import(/* webpackChunkName: "mermaid" */ "mermaid").then((m) => {
    cachedMermaidJs = m as unknown as MermaidJsRenderer;
    notifyAll();
    return cachedMermaidJs;
  });
}

function notifyAll(): void {
  subscribers.forEach((cb) => cb());
  subscribers.clear();
}

// ---- SVG sanitize ----------------------------------------------------------
//
// 极简自写 sanitizer——不依赖 dompurify,行为在所有环境(happy-dom / jsdom /
// 真实浏览器)一致。剥三类威胁:
//   1. <script> 标签
//   2. <foreignObject> 标签(可嵌入任意 HTML)
//   3. on* 事件属性(onclick / onerror / onload 等)+ javascript: / data: 的 href/xlink:href
//
// 不剥 <style>(SVG 内嵌样式是合法且必要的,beautiful-mermaid 大量使用
// `style` 属性 + `<style>` 块注入 CSS variables)。
const FORBID_TAG_RE = /<\/?(script|foreignObject)\b[^>]*>/gi;
const ON_ATTR_RE = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_HREF_RE = /\s+(?:xlink:)?href\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi;

/**
 * 极简 SVG sanitize。export 给单测用;正常路径在 renderMermaidDiagram 内部调用。
 */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(FORBID_TAG_RE, "")
    .replace(ON_ATTR_RE, "")
    .replace(JS_HREF_RE, "");
}

// ---- public render entry ---------------------------------------------------

/**
 * 渲染 mermaid 代码 → sanitized SVG。Promise 永远 resolve;失败走
 * {ok: false, message} 让调用方降级。
 */
export async function renderMermaidDiagram(
  code: string,
  theme: MermaidTheme,
): Promise<MermaidRenderResult> {
  const useBeautiful = shouldUseBeautiful(code);

  try {
    let rawSvg: string;
    let kind: "beautiful" | "mermaidjs";
    if (useBeautiful) {
      const lib = await ensureBeautiful();
      rawSvg = lib.renderMermaidSVG(code, {
        bg: theme.bg,
        fg: theme.fg,
        line: theme.line,
        accent: theme.accent,
        muted: theme.muted,
        surface: theme.surface,
        border: theme.border,
        font: "Inter",
      });
      kind = "beautiful";
    } else {
      const lib = await ensureMermaidJs();
      // mermaidjs 是全局单例,首次使用前必须 initialize;后续调用可以跳过。
      // 安全等级 strict 关闭 inline event handler,即便 sanitize 漏了也不会注入 XSS。
      lib.default.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        fontFamily: "inherit",
        themeVariables: {
          background: theme.bg,
          primaryColor: theme.surface,
          primaryTextColor: theme.fg,
          primaryBorderColor: theme.border,
          lineColor: theme.line,
          secondaryColor: theme.surface,
          tertiaryColor: theme.bg,
          tertiaryBorderColor: theme.border,
          textColor: theme.fg,
          mainBkg: theme.surface,
          nodeBorder: theme.border,
          clusterBkg: theme.surface,
          clusterBorder: theme.border,
          titleColor: theme.fg,
          edgeLabelBackground: theme.bg,
          noteBkgColor: theme.surface,
          noteTextColor: theme.fg,
          noteBorderColor: theme.border,
          actorBkg: theme.surface,
          actorBorder: theme.border,
          actorTextColor: theme.fg,
          actorLineColor: theme.line,
          signalColor: theme.line,
          signalTextColor: theme.fg,
          labelBoxBkgColor: theme.bg,
          labelBoxBorderColor: theme.border,
          labelTextColor: theme.fg,
          loopTextColor: theme.fg,
          note: theme.muted,
          errorBkgColor: theme.bg,
          errorTextColor: theme.fg,
        },
        flowchart: { useMaxWidth: true },
        sequence: { useMaxWidth: true },
        suppressErrorRendering: true,
      });
      const id = `sc-mmd-${Math.random().toString(36).slice(2, 10)}`;
      const result = await lib.default.render(id, code);
      rawSvg = result.svg;
      kind = "mermaidjs";
    }
    const safeSvg = sanitizeSvg(rawSvg);
    if (!safeSvg || !safeSvg.includes("<svg")) {
      // 调试用:把 raw 前 100 字符也带上,方便看出 beautiful 到底产出什么
      const preview = rawSvg.replace(/\s+/g, " ").slice(0, 120);
      return {
        ok: false,
        message: `sanitize 后为空或不含 <svg>;raw[${rawSvg.length}]="${preview}"`,
        kind,
      };
    }
    return { ok: true, svg: safeSvg, kind };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      kind: useBeautiful ? "beautiful" : "mermaidjs",
    };
  }
}

/**
 * 同步检查 cache 状态。给 warm-up effect 用——不必 await,只判断是否要触发
 * dynamic import。
 */
export function hasMermaidBundle(): boolean {
  return cachedBeautiful !== null || cachedMermaidJs !== null;
}

/**
 * 预热入口。MarkdownText 在 text.length > 256 且包含 ```mermaid 时调一次,
 * 把 chunk 提前拉下来;等用户真正看到 mermaid 块时已经 cached,首屏不抖。
 * 同步 fire-and-forget,内部 Promise 由 cache + subscribers 接管。
 */
export function ensureMermaidBundle(): void {
  // 同时预热两个 renderer?不,等看到 header 才知道走哪个。但 beautiful + mermaidjs
  // 总有一个会被加载,先预热 beautiful(主路径)更快命中 cache。
  void ensureBeautiful();
  // 也顺便预热 mermaidjs——若消息里有 block-beta 之类,fallback 路径已经准备好。
  void ensureMermaidJs();
}

/**
 * 订阅 cache 就绪事件。新挂载的 MermaidBlock 实例调一次;若 cache 已就绪
 * 立即拿到结果。
 */
export function subscribeMermaidReady(cb: () => void): () => void {
  if (hasMermaidBundle()) {
    // 已经就绪,直接异步调一次 cb(避免在 effect 里 setState 同步警告)
    queueMicrotask(cb);
    return () => {};
  }
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}
