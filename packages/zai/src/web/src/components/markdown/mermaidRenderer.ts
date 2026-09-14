// mermaidRenderer.ts — beautiful-mermaid lazy-load + SVG sanitize
//
// 复用 packages/zai/src/web/src/components/markdown/syntaxHighlighter.ts 的
// 模块级 cache + subscribers 模式:首次遇到 ```mermaid 块触发 import,所有
// MarkdownText 实例共享同一引用,避免重渲时反复 fetch。
//
// 只保留 beautiful-mermaid 单 renderer(~30KB 产物、安装体积 ~2.5MB),覆盖
// flowchart/graph、sequenceDiagram、classDiagram、stateDiagram(-v2)、
// erDiagram、xychart-beta 这 6 类最常见图表。
//
// 历史上这里还有一条 `mermaid` 官方库的 fallback(mermaidjs,~600KB bundle、
// 83MB 安装体积,支撑 block-beta/gantt/pie/gitGraph/journey/C4*/kanban/
// radar/treemap 等冷门类型)。该依赖已被移除:遇到不在这 6 类白名单里的
// 图类型时直接返回 {ok:false, kind:'unsupported'},由 MermaidBlock 走
// <details> 源码降级,不再为一个冷门类型背 600KB chunk。
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
  /**
   * Which path produced the result:
   *   'beautiful'   — beautiful-mermaid 渲染(成功或渲染中报错)
   *   'unsupported' — 图类型不在支持白名单,未经渲染直接降级
   */
  kind?: "beautiful" | "unsupported";
}

// ---- supported-type gate ---------------------------------------------------
//
// beautiful-mermaid 的 parseMermaid 只认这 6 类子图;把白名单前置到 import
// 之前,冷门类型(block-beta/gantt/pie/...)既不用等 dynamic import,也不会
// 让 parser 抛一堆难懂的错——直接给出可读的降级原因。
const SUPPORTED_HEADER_RE =
  /^\s*(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|xychart-beta)\b/i;

/** 取首行有效声明(跳过空行与 %% 注释)。 */
function firstMeaningfulLine(code: string): string {
  return (
    code.split("\n").find((l) => l.trim().length > 0 && !l.trim().startsWith("%%")) ??
    ""
  );
}

/**
 * 该 mermaid 源码的类型是否在 beautiful-mermaid 支持范围内。export 给单测用。
 */
export function isSupportedMermaid(code: string): boolean {
  return SUPPORTED_HEADER_RE.test(firstMeaningfulLine(code));
}

// ---- cache + subscribers --------------------------------------------------
//
// 模块级引用 + Set<callback> 模式跟 syntaxHighlighter.ts 一致;每个
// MarkdownText 实例独立订阅,首个解析完成时统一 setState 触发重渲。
type BeautifulRenderer = {
  renderMermaidSVG: (text: string, options?: Record<string, unknown>) => string;
  DEFAULTS?: { bg?: string; fg?: string };
};

let cachedBeautiful: BeautifulRenderer | null = null;
const subscribers = new Set<() => void>();

function ensureBeautiful(): Promise<BeautifulRenderer> {
  if (cachedBeautiful) return Promise.resolve(cachedBeautiful);
  return import(/* webpackChunkName: "mermaid-beautiful" */ "beautiful-mermaid").then((m) => {
    cachedBeautiful = m as unknown as BeautifulRenderer;
    notifyAll();
    return cachedBeautiful;
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
  if (!isSupportedMermaid(code)) {
    const header = firstMeaningfulLine(code).trim().slice(0, 40) || "(空)";
    return {
      ok: false,
      kind: "unsupported",
      message: `不支持的图类型 "${header}" — 仅支持 flowchart / sequenceDiagram / classDiagram / stateDiagram / erDiagram / xychart`,
    };
  }

  try {
    const lib = await ensureBeautiful();
    const rawSvg = lib.renderMermaidSVG(code, {
      bg: theme.bg,
      fg: theme.fg,
      line: theme.line,
      accent: theme.accent,
      muted: theme.muted,
      surface: theme.surface,
      border: theme.border,
      font: "Inter",
    });
    const safeSvg = sanitizeSvg(rawSvg);
    if (!safeSvg || !safeSvg.includes("<svg")) {
      // 调试用:把 raw 前 120 字符也带上,方便看出 beautiful 到底产出什么
      const preview = rawSvg.replace(/\s+/g, " ").slice(0, 120);
      return {
        ok: false,
        message: `sanitize 后为空或不含 <svg>;raw[${rawSvg.length}]="${preview}"`,
        kind: "beautiful",
      };
    }
    return { ok: true, svg: safeSvg, kind: "beautiful" };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      kind: "beautiful",
    };
  }
}

/**
 * 同步检查 cache 状态。给 warm-up effect 用——不必 await,只判断是否要触发
 * dynamic import。
 */
export function hasMermaidBundle(): boolean {
  return cachedBeautiful !== null;
}

/**
 * 预热入口。MarkdownText 在 text.length > 256 且包含 ```mermaid 时调一次,
 * 把 chunk 提前拉下来;等用户真正看到 mermaid 块时已经 cached,首屏不抖。
 * 同步 fire-and-forget,内部 Promise 由 cache + subscribers 接管。
 */
export function ensureMermaidBundle(): void {
  void ensureBeautiful();
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
