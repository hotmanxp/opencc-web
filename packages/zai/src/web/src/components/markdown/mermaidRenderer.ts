// mermaidRenderer.ts — mermaid.js lazy-load + SVG sanitize + 主题映射
//
// 复用 packages/zai/src/web/src/components/markdown/syntaxHighlighter.ts 的
// 模块级 cache + subscribers 模式:首次遇到 ```mermaid 块触发 import,所有
// MarkdownText 实例共享同一引用,避免重渲时反复 fetch。
//
// **2026-10-05 换库**:原先是 beautiful-mermaid(只认 6 类图 + 自绘 SVG,
// 质量对不齐)。现在换成官方 mermaid.js 全量运行时,布局走 dagre/d3-dag,
// 覆盖 flowchart / sequence / class / state / er / gantt / pie / mindmap /
// journey / quadrant / timeline / sankey / gitGraph / requirement 等全谱系。
//
// 体积实测(换库前后都是懒加载,口径一致):gzip 483KB → 597KB,净 +114KB。
// 比预想小很多,因为 beautiful-mermaid 本来就拖了 elkjs —— 而 elk 恰好也是
// mermaid 布局 flowchart 的引擎,同一份依赖换了个前端。首次真正见到 ```mermaid
// 才会下载这 597KB。
//
// 历史上这里还有「双 renderer」结构(beautiful-mermaid 主力 + 官方库兜底
// 冷门类型),在 60d5f906 被合并成单 renderer 并删掉官方库;本次是把它换回来,
// 但作为**唯一**渲染器而非 fallback。
//
// sanitize 仍用极简自写正则(剥 <script>/<foreignObject> + on* 事件属性 +
// javascript: href),不复用 dompurify:happy-dom 下 dompurify 会把含 <style>
// 标签的 SVG 整段剥光(测试环境 over-aggressive,生产行为不一致);自写
// sanitizer 在 happy-dom / jsdom / 真实浏览器三个环境行为一致。mermaid 自身
// 的 securityLevel:'strict' 是第一道防线,这里是第二道。

// 主题 token 集合——从 CSS 变量读出(见 MermaidBlock.readThemeTokens),
// 映射到 mermaid 的 themeVariables。
export interface MermaidTheme {
  bg: string;
  fg: string;
  line: string;
  accent: string;
  muted: string;
  surface: string;
  border: string;
  /** 浅/深色标记。mermaid 的 themeVariables 里很多 token 没有"自动反色"语义,
   * 需要按 mode 分别给值。缺省时按 bg 亮度推断,所以老调用方不传也能跑。 */
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
   *   'mermaid'    — 官方 mermaid.js 渲染(成功或解析报错)
   *   'unsupported' — 连图类型都认不出(空 / 非 mermaid 语法),降级为源码
   */
  kind?: "mermaid" | "unsupported";
}

/** 取首行有效声明(跳过空行与 %% 注释)。 */
function firstMeaningfulLine(code: string): string {
  return (
    code.split("\n").find((l) => l.trim().length > 0 && !l.trim().startsWith("%%")) ??
    ""
  );
}

// 图类型 → 中文标签,只用于容器头部条的标题展示(不参与渲染决策)。
// 这里**不做**支持与否的判断 —— 全谱系都交给 mermaid 自己解析,认不出的
// 类型由它抛错,再走 error 降级。
const TYPE_LABELS: Array<[RegExp, string]> = [
  [/^sequenceDiagram\b/i, "时序图"],
  [/^(flowchart|graph)\b/i, "流程图"],
  [/^classDiagram\b/i, "类图"],
  [/^stateDiagram(-v2)?\b/i, "状态图"],
  [/^erDiagram\b/i, "ER 图"],
  [/^(pie|xychart|quadrantChart|requirementDiagram)\b/i, "图表"],
  [/^gantt\b/i, "甘特图"],
  [/^(mindmap|gitGraph)\b/i, "思维导图"],
  [/^(journey|timeline)\b/i, "旅程图"],
  [/^(sankey-beta|sankey)\b/i, "桑基图"],
  [/^(C4Context|C4Container|C4Component|C4Dynamic|C4Deployment)\b/i, "架构图"],
  [/^(block-beta|packet-beta|architecture-beta|kanban|radar|treemap|zenuml)\b/i, "图"],
];

/** 取图类型的中文名;识别不出返回「图表」。export 给单测用。 */
export function mermaidDiagramLabel(code: string): string {
  const first = firstMeaningfulLine(code).trim();
  return TYPE_LABELS.find(([re]) => re.test(first))?.[1] ?? "图表";
}

/**
 * 这段源码看起来是否像一段 mermaid 声明。用于在**调用 mermaid 之前**挡掉
 * 空串 / 纯文本,避免为一个必然失败的图白等一次 dynamic import + 解析。
 * 真正的类型合法性交给 mermaid 自己判断。
 */
export function isSupportedMermaid(code: string): boolean {
  const first = firstMeaningfulLine(code).trim();
  if (!first) return false;
  // mermaid 声明要么是 `type ...` 开头,要么是 %%{init}%% 指令块
  return /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|xychart|pie|gantt|mindmap|journey|timeline|sankey|gitGraph|quadrantChart|requirementDiagram|C4\w+|block|packet|architecture|kanban|radar|treemap|zenuml|%%\{)/i.test(
    first,
  );
}

// ---- cache + subscribers --------------------------------------------------
//
// 模块级引用 + Set<callback> 模式跟 syntaxHighlighter.ts 一致;每个
// MarkdownText 实例独立订阅,首个解析完成时统一 setState 触发重渲。
type MermaidLib = {
  initialize: (cfg: Record<string, unknown>) => void;
  render: (id: string, code: string) => Promise<{ svg: string }>;
};

let cachedMermaid: MermaidLib | null = null;
const subscribers = new Set<() => void>();

function ensureMermaid(): Promise<MermaidLib> {
  if (cachedMermaid) return Promise.resolve(cachedMermaid);
  return import(/* webpackChunkName: "mermaid" */ "mermaid").then((m) => {
    cachedMermaid = (m as { default?: MermaidLib }).default ?? (m as unknown as MermaidLib);
    notifyAll();
    return cachedMermaid;
  });
}

function notifyAll(): void {
  subscribers.forEach((cb) => cb());
  subscribers.clear();
}

// ---- theme → themeVariables ------------------------------------------------

/** 相对亮度(0=黑,1=白);WCAG 定义,仅用于按底色挑文字色。 */
function relativeLuminance(color: string): number | null {
  const rgb = parseCssColor(color);
  if (!rgb) return null;
  const lin = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

/** CSS 颜色 → [r,g,b](0-255)。支持 #rgb / #rrggbb / rgb() / rgba();解析不出返回 null。 */
export function parseCssColor(color: string): [number, number, number] | null {
  const c = color.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(c);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = h.split("").map((x) => x + x).join("");
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(c);
  if (!rgb) return null;
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
}

/** WCAG 对比度(1:1 ~ 21:1)。任一颜色解析不出返回 null。 */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** 深浅两个候选字色;与主题无关 —— 底是作者写死的,和当前主题没关系。 */
const DARK_TEXT = "#0a0a0f";
const LIGHT_TEXT = "#f8fafc";

/**
 * 给某个底色挑对比度更高的字色。底解析不出(如 `none` / `url(#grad)` 渐变)
 * 返回 null,交给主题 token 决定。
 */
export function labelColorOn(fill: string, dark = DARK_TEXT, light = LIGHT_TEXT): string | null {
  if (relativeLuminance(fill) === null) return null;
  const onDark = contrastRatio(dark, fill) ?? 0;
  const onLight = contrastRatio(light, fill) ?? 0;
  return onLight >= onDark ? light : dark;
}

/** 主题是否为深色:优先用显式 mode,否则按 bg 亮度推断(解析不出则当浅色)。 */
function isDarkTheme(theme: MermaidTheme): boolean {
  if (theme.mode) return theme.mode === "dark";
  const lum = relativeLuminance(theme.bg);
  return lum !== null ? lum < 0.5 : false;
}

/**
 * 把 7 个 zai token 映射到 mermaid 的 themeVariables。
 *
 * mermaid 的 base 主题 token 远比 zai 的 7 个多,这里只覆盖视觉上真正会
 * 被看到的那些;其余走 mermaid base 默认值,靠 `theme: 'base'` 兜底 ——
 * base 的所有 token 都可被 themeVariables 逐项覆盖,没覆盖的保持默认。
 *
 * 深浅色分别给值:序列图 actor、note、rect 色带在深色下用 theme.bg 兜底会
 * 看不见,所以 dark 走深一档的 surface。
 *
 * **文字色必须和它实际落在的底成对**(2026-10-14 修):mermaid base 主题
 * 有一大批 token 缺省**派生自 primaryTextColor**(theme-base 的 updateColors
 * 里清一色是 `this.x = this.x || this.primaryTextColor`,覆盖 nodeTextColor /
 * actorTextColor / labelTextColor / stateLabelColor …)。而 primaryTextColor
 * 本该只服务 accent 底(品牌橙是亮色,压深字),之前只覆盖了它 → 那批派生
 * token 全跟着 accent 的反色走:暗色主题下 surface 底配近黑字、浅色主题下
 * 配漂白字,两种主题的节点文字都读不出来。所以这里分两类文字色,凡是底是
 * surface / 画布的文字 token 一律显式压回 onSurface,不再靠派生链。
 */
export function buildThemeVariables(
  theme: MermaidTheme,
): Record<string, string | boolean> {
  const dark = isDarkTheme(theme);
  // 两类文字色:onSurface 落在 surface/mainBkg/画布上;onAccent 落在品牌橙上
  // —— 橙是亮色,只有深字压得住,与主题明暗无关。
  const onSurface = theme.fg;
  const onAccent = "#0a0a0f";
  return {
    // 画布
    background: theme.bg,
    mainBkg: theme.surface,
    secondBkg: dark ? theme.bg : theme.muted,
    // 明暗派生开关:mermaid 只在 themeVariables 里认这个键(顶层的
    // config.darkMode 不参与 base 主题推导),它决定 cScale* / rowOdd-Even /
    // edgeLabelBackground 等一批 token 往哪边推;不给就一律按浅色推,暗色下
    // ER / gitGraph / 多色 class 会拿到浅色系。
    darkMode: dark,
    // 节点填充保持平涂:缺省 useGradient 会拿主/次边框色拉渐变,同色系渐变在
    // 小图里等于削弱文字与底的对比。
    useGradient: false,
    // flowchart 的 per-diagram 配置自带 look:"neo"(压过根配置的 classic),neo
    // 给节点矩形挂的是近不透明的浅灰投影 —— 浅色主题下是正常投影,暗色主题下
    // 等于在深底上给每个节点镶一道灰边(用户截图里那圈灰)。暗色下关掉。
    ...(dark ? { dropShadow: "none" } : {}),
    // 线与字
    lineColor: theme.line,
    textColor: onSurface,
    // 节点
    nodeBorder: theme.line,
    nodeTextColor: onSurface,
    mainColor: onSurface,
    // 强调
    primaryColor: theme.accent,
    primaryBorderColor: theme.accent,
    primaryTextColor: onAccent,
    // 次级 / 第三级配色(gantt / pie / quadrant 多系列)
    secondaryColor: dark ? theme.muted : theme.surface,
    secondaryTextColor: onSurface,
    tertiaryColor: theme.muted,
    tertiaryTextColor: onSurface,
    // 标题 / 分组标签(cluster)落在画布上;缺省 titleColor 派生自
    // tertiaryTextColor(tertiaryColor 的反色),暗色下是深棕,画布上读不出。
    titleColor: onSurface,
    // 分组容器:缺省 clusterBkg = tertiaryColor(一块中灰)/ clusterBorder 是它
    // 的边框 —— 浅色下深灰底、暗色下浅灰底,都不是「容器」该有的样子。这里让
    // 容器退成画布色 + 品牌橙描边,靠里面节点的填充把层次浮出来。
    clusterBkg: theme.bg,
    clusterBorder: theme.line,
    // 边标签(labelBkg):缺省浅色下拿 secondaryColor、暗色下拿它再压暗 30%,
    // 在暗色主题里是一块中灰药丸;压回节点同色,标签文字(onSurface)才压得住。
    edgeLabelBackground: theme.surface,
    // 字体 —— 与 CODE_FONT_FAMILY 保持同一族,避免图内文字和代码块跳字体
    fontFamily:
      'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontSize: "14px",
    // 时序图
    actorBkg: theme.surface,
    actorBorder: theme.line,
    actorTextColor: onSurface,
    actorLineColor: theme.muted,
    signalColor: theme.fg,
    signalTextColor: onSurface,
    labelBoxBkgColor: theme.surface,
    labelBoxBorderColor: theme.line,
    labelTextColor: onSurface,
    loopTextColor: onSurface,
    noteBkgColor: dark ? "#1f2937" : "#fffbeb",
    noteBorderColor: theme.border,
    noteTextColor: onSurface,
    activationBkgColor: theme.muted,
    activationBorderColor: theme.border,
    // 类图
    classText: onSurface,
    // 状态图
    labelColor: onSurface,
    // 缺省 stateLabelColor = stateBkg(= mainBkg)—— 状态名被染成底色本身,
    // 直接消失;显式压回 onSurface。
    stateLabelColor: onSurface,
    // 缺省 altBackground = tertiaryColor(中灰):复合状态/分隔条的内层在暗色
    // 主题下会是整块亮灰。
    altBackground: theme.surface,
    // 统计图 / 甘特。pie1..3 不再手写 —— mermaid 由 primaryColor 派生 pie1、由
    // secondaryColor / tertiaryColor 派生 pie2/3、再按色相轮转出 pie4..12,
    // 手写的那版把 pie3 设成 textColor(浅色主题下几乎全黑的扇区)。
    pieSectionTextColor: onAccent,
    pieStrokeColor: theme.bg,
    pieOuterStrokeColor: theme.border,
    todayLineColor: theme.accent,
    taskBkgColor: theme.surface,
    taskBorderColor: theme.border,
    taskTextColor: onSurface,
    taskTextDarkColor: onSurface,
    taskTextLightColor: theme.bg,
    activeTaskBkgColor: theme.accent,
    activeTaskBorderColor: theme.accent,
    doneTaskBkgColor: theme.muted,
    gridColor: theme.border,
    sectionBkgColor: theme.surface,
    altSectionBkgColor: theme.bg,
  };
}

// ---- SVG sanitize ----------------------------------------------------------
//
// 极简自写 sanitizer——不依赖 dompurify,行为在所有环境(happy-dom / jsdom /
// 真实浏览器)一致。剥三类威胁:
//   1. <script> 标签
//   2. <foreignObject> 标签(可嵌入任意 HTML)
//   3. on* 事件属性(onclick / onerror / onload 等)+ javascript: 的 href/xlink:href
//
// 不剥 <style>(SVG 内嵌样式是合法且必要的,mermaid 靠它注入 CSS variables)。
//
// 注意 mermaid 默认 htmlLabels:true 会用 <foreignObject> 包标签 —— 我们在
// initialize 里显式关掉(htmlLabels:false),所以这里剥掉 foreignObject 不会
// 误伤正常标签文本。
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

// ---- 作者写死底色的节点:标签字色跟着底走 -----------------------------------
//
// `style X fill:#fde68a` / `classDef` 这类作者样式, mermaid 只打到节点**形状**
// 上, 标签字色仍然走主题 token(nodeTextColor)。于是「浅底 + 主题的浅字」在深色
// 主题下必然撞车:白字压浅黄 1.2:1, 整块读不出来 —— 而 LLM 生成的图很爱写这种
// 硬编码底色(用户那张「三层静默」图就是 style D fill:#fde68a)。
//
// 渲染后按节点**自己的**底色核对标签字色, 只救对比度低于阈值的(>= 阈值说明是
// 作者有意配的色, 不动);主题驱动的节点算出来就是主题那个色, 观感不变。

/** 低于这个对比度就认为读不出来, 需要改字色。 */
const MIN_LABEL_CONTRAST = 3;

/**
 * 校正渲染结果里各节点的标签字色。入参是已注入 SVG 的容器。
 * 无 DOM/无布局能力的环境(happy-dom)下 `getComputedStyle` 拿不到 CSS 值,
 * 会原样跳过 —— 真实浏览器验收兜底(见 MermaidBlock 的 layout effect)。
 */
export function adaptNodeLabelColors(root: HTMLElement): void {
  if (typeof getComputedStyle !== "function") return;
  root.querySelectorAll("g.node").forEach((node) => {
    const shape = node.querySelector("rect, polygon, circle, ellipse, path");
    if (!shape) return;
    const fill = getComputedStyle(shape).fill;
    if (relativeLuminance(fill) === null) return;

    node.querySelectorAll("text").forEach((text) => {
      const current = getComputedStyle(text).fill;
      const ratio = contrastRatio(current, fill);
      if (ratio !== null && ratio >= MIN_LABEL_CONTRAST) return;
      const next = labelColorOn(fill);
      if (next) text.style.fill = next;
    });
  });
}

// ---- responsive svg root ---------------------------------------------------
//
// mermaid 输出的根 svg 带绝对 width/height + viewBox,但**没有** max-width,
// 宽图(多 participant / 长标签)直接比消息列还宽,会被裁在面板外面
// (信息真的丢了)。
//
// 这里给根 svg 补两条内联样式,*强制*缩到容器内、整张可见:
//   max-width:100% —— 不超出容器宽度
//   height:auto    —— 等比缩放(靠 viewBox + preserveAspectRatio 维持比例)
//
// **不再设 min-width 下限**:旧实现留了 `min-width: 原宽 * 0.75` 的缩放下限 +
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
 * 取根 svg 的原始(未缩放)画布宽度,即 mermaid 算出的自然宽度。
 * MermaidBlock 用它除以实测渲染宽度算缩放百分比;取不到返回 null。
 */
export function naturalSvgWidth(svg: string): number | null {
  const raw = SVG_ROOT_WIDTH_ATTR_RE.exec(svg)?.[1];
  const width = raw ? Number(raw) : NaN;
  return Number.isFinite(width) && width > 0 ? width : null;
}

// ---- public render entry ---------------------------------------------------

// mermaid 的 render(id, code) 会往 document.body 挂一个临时节点做测量,
// id 必须全局唯一 —— 单调递增即可。
let renderSeq = 0;

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
      message: `无法识别的图类型 "${header}" — 请以 flowchart / sequenceDiagram / classDiagram / stateDiagram / erDiagram / gantt / pie 等类型声明开头`,
    };
  }

  try {
    const lib = await ensureMermaid();
    // mermaid 是全局单例,主题在 render 时烘进产物 —— 主题切换要重新
    // initialize,不能缓存上一次的配置。
    //
    // useMaxWidth:false(**所有图型都要显式写**,mermaid 的 per-diagram 配置
    // 不继承顶层默认值,漏写一个就退回 width="100%")。开启时 mermaid 给根
    // svg 输出 `width="100%"`,而我们的祖先链是 shrink-to-fit 的
    // ant-space-item(flex:0 1 auto)—— 百分比宽度对 shrink-to-fit 容器解析成
    // min-content,实测 2472px 的宽图被压到 116px(5%),文字完全不可读。
    // 关掉后 mermaid 输出自然像素宽度,缩放交给 makeSvgResponsive 的
    // max-width:100% + height:auto(那条路径容器宽度是确定的,比例正确)。
    const diag = { htmlLabels: false, useMaxWidth: false };
    lib.initialize({
      startOnLoad: false,
      // 不允许 click 回调 / 脚本执行;这是 mermaid 侧的第一道防线。
      securityLevel: "strict",
      // 关掉后 mermaid 用 <text> 而不是 <foreignObject> 画标签;我们的
      // sanitizer 会剥掉 foreignObject,开着等于标签全丢。
      htmlLabels: false,
      useMaxWidth: false,
      // 渲染失败时**不要**把 "Syntax error in text" 品牌 SVG 画进 DOM。
      // mermaid 的 draw() 抛错路径默认会调 errorRenderer.draw(...),而
      // removeTempElements() 在 throw 之后才执行 —— 于是那个临时节点
      // (内含 1417px 宽的错误 SVG)留在 document.body 上,脱离 React root,
      // 实际盖住输入框。流式输出时每个半截代码都会触发一次。
      // 置 true 后走 removeTempElements() 分支,只 throw 不渲染。
      suppressErrorRendering: true,
      theme: "base",
      themeVariables: buildThemeVariables(theme),
      flowchart: { ...diag },
      sequence: { ...diag },
      class: { ...diag },
      state: { ...diag },
      er: { ...diag },
      gantt: { useMaxWidth: false },
      pie: { useMaxWidth: false },
      mindmap: { useMaxWidth: false },
      journey: { useMaxWidth: false },
      timeline: { useMaxWidth: false },
      gitGraph: { useMaxWidth: false },
      quadrantChart: { useMaxWidth: false },
      xychart: { useMaxWidth: false },
      sankey: { useMaxWidth: false },
    });

    const id = `zai-mermaid-${++renderSeq}`;
    const { svg: rawSvg } = await lib.render(id, code);

    if (!rawSvg) {
      return {
        ok: false,
        message: "mermaid 渲染返回空 SVG(可能是测试环境缺少 layout 度量)",
        kind: "mermaid",
      };
    }
    const safeSvg = makeSvgResponsive(sanitizeSvg(rawSvg));
    if (!safeSvg.includes("<svg")) {
      return { ok: false, message: "sanitize 后不含 <svg>", kind: "mermaid" };
    }
    return { ok: true, svg: safeSvg, kind: "mermaid" };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      kind: "mermaid",
    };
  }
}

/**
 * 同步检查 cache 状态。给 warm-up effect 用——不必 await,只判断是否要触发
 * dynamic import。
 */
export function hasMermaidBundle(): boolean {
  return cachedMermaid !== null;
}

/**
 * 预热入口。MarkdownText 在 text.length > 256 且包含 ```mermaid 时调一次,
 * 把 chunk 提前拉下来;等用户真正看到 mermaid 块时已经 cached,首屏不抖。
 * 同步 fire-and-forget,内部 Promise 由 cache + subscribers 接管。
 */
export function ensureMermaidBundle(): void {
  void ensureMermaid();
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
