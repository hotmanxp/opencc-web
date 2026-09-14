// mermaidRenderer.ts — beautiful-mermaid lazy-load + SVG sanitize + rect 色块修正
//
// 复用 packages/zai/src/web/src/components/markdown/syntaxHighlighter.ts 的
// 模块级 cache + subscribers 模式:首次遇到 ```mermaid 块触发 import,所有
// MarkdownText 实例共享同一引用,避免重渲时反复 fetch。
//
// 只保留 beautiful-mermaid 单 renderer,覆盖 flowchart/graph、sequenceDiagram、
// classDiagram、stateDiagram(-v2)、erDiagram、xychart-beta 这 6 类最常见图表。
// **体积实测(2026-09-14)**:beautiful-mermaid 的 dist/index.js ~335KB,但它
// 依赖 elkjs(~1.2MB 布局引擎),Vite 打出来的 mermaid-beautiful chunk
// ~1.59MB / gzip ~490KB —— 早先注释里的 "~30KB" 是错的。
//
// 历史上这里还有一条 `mermaid` 官方库的 fallback(mermaidjs,支撑 block-beta/
// gantt/pie/gitGraph/journey/C4*/kanban/radar/treemap 等冷门类型)。该依赖已被
// 移除:遇到不在这 6 类白名单里的图类型时直接返回 {ok:false, kind:'unsupported'},
// 由 MermaidBlock 走 <details> 源码降级。
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
  /**
   * 浅/深色标记,只影响 `rect` 色块的透明度(见 applyRectBands)。
   * 缺省时按 bg 的亮度推断,所以老调用方不传也能跑。
   */
  mode?: "light" | "dark";
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

// 图类型 → 中文标签,只用于容器头部条的标题展示(不参与渲染决策)。
const TYPE_LABELS: Array<[RegExp, string]> = [
  [/^sequenceDiagram\b/i, "时序图"],
  [/^(flowchart|graph)\b/i, "流程图"],
  [/^classDiagram\b/i, "类图"],
  [/^stateDiagram(-v2)?\b/i, "状态图"],
  [/^erDiagram\b/i, "ER 图"],
  [/^xychart-beta\b/i, "图表"],
];

/** 取图类型的中文名;识别不出返回「图表」。export 给单测用。 */
export function mermaidDiagramLabel(code: string): string {
  const first = firstMeaningfulLine(code).trim();
  return TYPE_LABELS.find(([re]) => re.test(first))?.[1] ?? "图表";
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

// ---- rect band post-process ------------------------------------------------
//
// mermaid 的 sequenceDiagram 里 `rect <color> ... end` 是"底色带":给一段消息
// 铺一层背景色,本身不显示任何文字。beautiful-mermaid(1.1.3)虽然把 `rect`
// 收进了 block 类型白名单(`loop|alt|opt|par|critical|break|rect`),但渲染
// 走的是通用 block 分支:
//   <rect ... fill="none" stroke="var(--_node-stroke)" />   ← 块底 = 不填充
//   <rect ... fill="var(--_group-hdr)" />                    ← 左上角 tab
//   <text ...>rect [rgb(245,245,245)]</text>                 ← 把颜色字面量当标题
// 于是 LLM 生成的 `rect rgb(245,245,245)` 既没铺底色,又在左上角多出一串
// "rect [rgb(245,245,245)]" 垃圾文本(2026-09-14 用户反馈的截图)。
//
// 在 sanitize 之后补一道字符串后处理,把 rect 块改回语义:
//   1. 块底 rect 用 label 里的颜色填充;
//   2. 删掉 tab rect 与标题文本。
//
// 颜色只接受严格合法的 CSS 字面量(hex / rgb[a]() / 字母颜色名),不接受任意
// 字符串——data-label 的内容最终会写进 fill 属性,不能当自由文本用。
//
// 透明度:深色主题下压到 DARK_BAND_OPACITY。LLM 写 mermaid 时默认面向浅色
// 画布,颜色几乎都是 `rgb(245,245,245)` 这类高亮度值;深色主题下原样铺满会
// 把深色文字压死,所以深色一律走低调底色(浅色主题保持原色,与官方 mermaid
// 行为一致)。
//
// 对比度下限:浅色画布 + `rgb(245,245,245)` 这类颜色,原样铺上去跟画布几乎
// 同色(白底上的 #f5f5f5),看上去"还是没有底色"。所以当色块颜色与画布底色
// 的亮度差 < BAND_MIN_LUM_DELTA 时,朝文字色混 BAND_CONTRAST_MIX 比例,保证
// 这条带看得见。
export const DARK_BAND_OPACITY = 0.18;
const BAND_MIN_LUM_DELTA = 0.05;
const BAND_CONTRAST_MIX = 0.12;

const RECT_BLOCK_RE = /<g class="block" data-type="rect"([^>]*)>([\s\S]*?)<\/g>/g;
/** 左上角的 tab rect(beautiful-mermaid 固定用 --_group-hdr 填充,height=18)。 */
const RECT_TAB_RE = /\s*<rect\b[^>]*fill="var\(--_group-hdr\)"[^>]*\/>/;
/** rect 块内唯一的文本元素就是那句 "rect [color]" 标题,整段删掉。 */
const TEXT_EL_RE = /\s*<text\b[^>]*>[\s\S]*?<\/text>/g;
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_COLOR_RE = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/i;
const NAMED_COLOR_RE = /^[a-z]{3,20}$/i;

interface ParsedColor {
  /** 归一化后可以直接写进 fill 的字符串。 */
  css: string;
  /** 可解析的 RGB 分量;字母颜色名为 null。 */
  rgb: [number, number, number] | null;
}

/** 解析 data-label 里的颜色字面量;非法则返回 null。 */
function parseCssColor(raw: string): ParsedColor | null {
  const v = raw.trim();
  if (!v || /["'<>;\\]/.test(v)) return null;
  if (HEX_COLOR_RE.test(v)) {
    const hex = v.slice(1);
    const full =
      hex.length <= 4
        ? hex
            .slice(0, 3)
            .split("")
            .map((c) => c + c)
            .join("")
        : hex.slice(0, 6);
    const rgb: [number, number, number] = [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ];
    return { css: `rgb(${rgb.join(",")})`, rgb };
  }
  const m = RGB_COLOR_RE.exec(v);
  if (m) {
    const rgb = [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number];
    if (rgb.some((c) => c > 255)) return null;
    return { css: `rgb(${rgb.join(",")})`, rgb };
  }
  if (NAMED_COLOR_RE.test(v)) return { css: v, rgb: null };
  return null;
}

/** 相对亮度(0=黑,1=白);用于判断主题明暗 / 解析 bg token。 */
function relativeLuminance(rgb: [number, number, number]): number {
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}

/** 主题是否为深色:优先用显式 mode,否则按 bg 亮度推断(解析不出则当浅色)。 */
function isDarkTheme(theme: MermaidTheme): boolean {
  if (theme.mode) return theme.mode === "dark";
  const bg = parseCssColor(theme.bg);
  if (!bg?.rgb) return false;
  return relativeLuminance(bg.rgb) < 0.5;
}

/**
 * 色块的最终填充色——与画布底色太接近时朝文字色混一点,避免"看不见的底色"。
 */
function bandFill(parsed: ParsedColor, theme: MermaidTheme): string {
  const bg = parseCssColor(theme.bg);
  const fg = parseCssColor(theme.fg);
  if (!parsed.rgb || !bg?.rgb || !fg?.rgb) return parsed.css;
  const delta = Math.abs(relativeLuminance(parsed.rgb) - relativeLuminance(bg.rgb));
  if (delta >= BAND_MIN_LUM_DELTA) return parsed.css;
  const mixed = parsed.rgb.map((c, i) =>
    Math.round(c + (fg.rgb![i]! - c) * BAND_CONTRAST_MIX),
  );
  return `rgb(${mixed.join(",")})`;
}

/**
 * 把生成 SVG 里的 `rect` 色块改成真正的底色带。export 给单测用。
 */
export function applyRectBands(svg: string, theme: MermaidTheme): string {
  if (!svg.includes('data-type="rect"')) return svg;
  const opacity = isDarkTheme(theme) ? DARK_BAND_OPACITY : 1;

  return svg.replace(RECT_BLOCK_RE, (whole, attrs: string, inner: string) => {
    const labelMatch = /\bdata-label="([^"]*)"/.exec(attrs);
    const parsed = labelMatch
      ? parseCssColor(labelMatch[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&"))
      : null;

    let body = inner.replace(RECT_TAB_RE, "").replace(TEXT_EL_RE, "");
    if (parsed) {
      const opacityAttr = opacity < 1 ? ` fill-opacity="${opacity}"` : "";
      const fill = `fill="${bandFill(parsed, theme)}"${opacityAttr}`;
      // 只替换块底 rect 的 fill="none",其它 rect(节点、tab)已在上一步删/不受影响
      body = body.replace('fill="none"', fill);
    } else {
      // 没有颜色(裸 `rect`):用主题的 group header 底色兜底,至少是个可见的带
      body = body.replace('fill="none"', 'fill="var(--_group-hdr)"');
    }
    return `<g class="block" data-type="rect"${attrs.replace(/\s*data-label="[^"]*"/, "")}>${body}</g>`;
  });
}

// ---- responsive svg root ---------------------------------------------------
//
// beautiful-mermaid 按文本度量算出绝对画布尺寸,svg 根是
// `<svg width="1370" height="628" viewBox="0 0 1370 628" style="--bg:…">` ——
// 没有 max-width,宽图(多 participant / 长标签)直接比消息列还宽,会被裁在
// 面板外面(信息真的丢了)。
//
// 这里给根 svg 补两条内联样式,*强制*缩到容器内、整张可见:
//   max-width:100% —— 不超出容器宽度
//   height:auto    —— 等比缩放(靠 viewBox + preserveAspectRatio 维持比例)
//
// **不再设 min-width 下限**。旧实现留了 `min-width: 原宽 * 0.75` 的缩放下限 +
// 外层 overflow-auto,结果是"缩不下就横向滚动"——图依旧被裁在可视区外,和用户
// 诉求相反。现在一律缩到底(整图可见),缩太小(<100%)时图文交互层给出实时缩放
// 百分比 + 「全屏预览」入口(见 MermaidBlock),放大读细节交给全屏。
const SVG_ROOT_RE = /<svg\b([^>]*)>/;
const SVG_STYLE_ATTR_RE = /\sstyle="([^"]*)"/;

/** 给根 svg 补 max-width / height:auto(缩到容器内)。export 给单测用。 */
export function makeSvgResponsive(svg: string): string {
  return svg.replace(SVG_ROOT_RE, (tag, attrs: string) => {
    const extra = "max-width:100%;height:auto";

    const styleMatch = SVG_STYLE_ATTR_RE.exec(attrs);
    if (styleMatch) {
      const merged = `${styleMatch[1]};${extra}`;
      return `<svg${attrs.replace(styleMatch[0], ` style="${merged}"`)}>`;
    }
    return `<svg${attrs} style="${extra}">`;
  });
}

const SVG_ROOT_WIDTH_ATTR_RE = /<svg\b[^>]*\swidth="([\d.]+)"/;

/**
 * 取根 svg 的原始(未缩放)画布宽度,即 beautiful-mermaid 算出的自然宽度。
 * MermaidBlock 用它除以实测渲染宽度算缩放百分比;取不到返回 null。
 */
export function naturalSvgWidth(svg: string): number | null {
  const raw = SVG_ROOT_WIDTH_ATTR_RE.exec(svg)?.[1];
  const width = raw ? Number(raw) : NaN;
  return Number.isFinite(width) && width > 0 ? width : null;
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
    const safeSvg = applyRectBands(makeSvgResponsive(sanitizeSvg(rawSvg)), theme);
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
