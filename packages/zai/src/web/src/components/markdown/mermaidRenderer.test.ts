// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// **为什么整份文件都 mock 掉 mermaid**:官方 mermaid.js 靠
// getBBox() / getComputedTextLength() / getBoundingClientRect() 做文本度量,
// dagre 直接消费这些 box。happy-dom 里这三个全是**返回 0 的桩**,于是
// mermaid 静默产出空 SVG(实测 svg len=0,不抛错)。真实渲染效果由
// ego-browser 在真浏览器里验 —— 那里 layout API 是真的。
//
// 所以这里的分工是:
//   - 单测断言**我们自己的**逻辑(类型门 / 主题映射 / sanitize / 响应式 /
//     cache 订阅),不再断言第三方库的输出;
//   - 真库输出对不对,由真实浏览器验收兜底。
const renderMock = vi.fn();
const initializeMock = vi.fn();

vi.mock("mermaid", () => ({
  default: {
    initialize: (...args: unknown[]) => initializeMock(...args),
    render: (...args: unknown[]) => renderMock(...args),
  },
}));

/** 造一个形状接近真实 mermaid 输出的 SVG(带 width/height/viewBox + 文字)。 */
function fakeSvg(width = 1370, height = 628): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" style="background:var(--bg)">` +
    `<g class="node"><rect width="80" height="30"/><text>Start</text></g>` +
    `</svg>`
  );
}

const LIGHT = {
  bg: "#f1f5f5",
  fg: "#0f172a",
  line: "rgba(249, 115, 22, 0.55)",
  accent: "#f97316",
  muted: "#64748b",
  surface: "#e2e8f0",
  border: "rgba(249, 115, 22, 0.20)",
  mode: "light" as const,
};

const DARK = {
  bg: "#12121a",
  fg: "#f8fafc",
  line: "rgba(249, 115, 22, 0.45)",
  accent: "#f97316",
  muted: "#94a3b8",
  surface: "#1a1a2e",
  border: "rgba(249, 115, 22, 0.18)",
  mode: "dark" as const,
};

describe("mermaidRenderer: type gate", () => {
  beforeEach(() => {
    vi.resetModules();
    renderMock.mockReset();
    initializeMock.mockReset();
    renderMock.mockResolvedValue({ svg: fakeSvg() });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 换库的核心收益:以前只有 6 种能过门,现在全谱系都放行给 mermaid 解析。
  it("admits the 6 formerly-supported types", async () => {
    const { isSupportedMermaid } = await import("./mermaidRenderer.js");
    for (const ok of [
      "flowchart LR\n A-->B",
      "graph TD\n A-->B",
      "sequenceDiagram\n A->>B: hi",
      "classDiagram\n class A",
      "stateDiagram-v2\n [*] --> A",
      "stateDiagram\n [*] --> A",
      "erDiagram\n USER ||--o{ POST : has",
      'xychart-beta\n line [1,2]\n x ["a","b"]',
      "%% comment first\nflowchart LR\n A-->B",
    ]) {
      expect(isSupportedMermaid(ok), ok).toBe(true);
    }
  });

  it("admits the types that used to be rejected (the point of the swap)", async () => {
    const { isSupportedMermaid } = await import("./mermaidRenderer.js");
    for (const ok of [
      "pie\n title A\n \"x\" : 10",
      "gantt\n title A\n dateFormat YYYY-MM-DD",
      "mindmap\n root",
      "gitGraph\n commit",
      "journey\n title T",
      "quadrantChart\n x-axis L",
      "timeline\n title T",
      "sankey-beta\na,b,1",
      "requirementDiagram\n requirement r",
      "block-beta\n columns 1\n block:A\n end",
      "kanban\n  col1\n task1",
      "radar-beta\n  axis a,b",
    ]) {
      expect(isSupportedMermaid(ok), ok).toBe(true);
    }
  });

  it("rejects empty / non-mermaid input before paying for the dynamic import", async () => {
    const { isSupportedMermaid } = await import("./mermaidRenderer.js");
    for (const bad of ["", "   ", "%% only a comment", "const x = 1;", "<div>hi</div>"]) {
      expect(isSupportedMermaid(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("does not call mermaid at all for a non-mermaid block", async () => {
    const { renderMermaidDiagram } = await import("./mermaidRenderer.js");
    const result = await renderMermaidDiagram("const x = 1;", LIGHT);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("unsupported");
    expect(result.message).toContain("无法识别");
    // 关键:门在前,不为必然失败的图白等一次 dynamic import
    expect(renderMock).not.toHaveBeenCalled();
  });
});

describe("mermaidRenderer: labels", () => {
  it("maps diagram type to the container title, including newly-supported types", async () => {
    const { mermaidDiagramLabel } = await import("./mermaidRenderer.js");
    expect(mermaidDiagramLabel("sequenceDiagram\n A->>B: hi")).toBe("时序图");
    expect(mermaidDiagramLabel("flowchart LR\n A-->B")).toBe("流程图");
    expect(mermaidDiagramLabel("graph TD\n A-->B")).toBe("流程图");
    expect(mermaidDiagramLabel("classDiagram\n class A")).toBe("类图");
    expect(mermaidDiagramLabel("stateDiagram-v2\n [*] --> A")).toBe("状态图");
    expect(mermaidDiagramLabel("erDiagram\n A ||--o{ B : has")).toBe("ER 图");
    expect(mermaidDiagramLabel("xychart-beta\n line [1,2]")).toBe("图表");
    expect(mermaidDiagramLabel("gantt\n title A")).toBe("甘特图");
    expect(mermaidDiagramLabel("pie\n title A")).toBe("图表");
    expect(mermaidDiagramLabel("mindmap\n root")).toBe("思维导图");
    // 认不出类型也不空标题
    expect(mermaidDiagramLabel("wat\n ???")).toBe("图表");
    // 前面有注释/空行同样能认
    expect(mermaidDiagramLabel("%% c\n\n  flowchart LR\n A-->B")).toBe("流程图");
  });
});

describe("mermaidRenderer: initialize config", () => {
  beforeEach(() => {
    vi.resetModules();
    renderMock.mockReset();
    initializeMock.mockReset();
    renderMock.mockResolvedValue({ svg: fakeSvg() });
  });

  it("sets htmlLabels:false — otherwise mermaid emits <foreignObject> that our sanitizer strips", async () => {
    const { renderMermaidDiagram } = await import("./mermaidRenderer.js");
    await renderMermaidDiagram("flowchart LR\n A-->B", LIGHT);
    const cfg = initializeMock.mock.calls[0]![0] as Record<string, unknown>;
    // 开着的话 mermaid 用 foreignObject 画标签,而 sanitizeSvg 会剥掉它 → 标签消失
    expect(cfg.htmlLabels).toBe(false);
    expect(cfg.flowchart).toMatchObject({ htmlLabels: false });
    expect(cfg.sequence).toMatchObject({ htmlLabels: false });
  });

  it("sets securityLevel:strict as the first line of defense", async () => {
    const { renderMermaidDiagram } = await import("./mermaidRenderer.js");
    await renderMermaidDiagram("flowchart LR\n A-->B", LIGHT);
    const cfg = initializeMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(cfg.securityLevel).toBe("strict");
  });

  it("re-initializes with the new theme on every render (mermaid bakes theme in at render time)", async () => {
    const { renderMermaidDiagram } = await import("./mermaidRenderer.js");
    await renderMermaidDiagram("flowchart LR\n A-->B", DARK);
    await renderMermaidDiagram("flowchart LR\n A-->B", LIGHT);
    expect(initializeMock).toHaveBeenCalledTimes(2);
    // calls[n][0] 就是第 n 次 initialize 收到的 config
    const darkCfg = initializeMock.mock.calls[0]![0] as Record<string, unknown>;
    const lightCfg = initializeMock.mock.calls[1]![0] as Record<string, unknown>;
    expect((darkCfg.themeVariables as Record<string, string>).background).toBe(DARK.bg);
    expect((lightCfg.themeVariables as Record<string, string>).background).toBe(LIGHT.bg);
  });

  it("gives every render a unique DOM id (mermaid appends a temp node to body)", async () => {
    const { renderMermaidDiagram } = await import("./mermaidRenderer.js");
    await renderMermaidDiagram("flowchart LR\n A-->B", LIGHT);
    await renderMermaidDiagram("flowchart LR\n A-->B", LIGHT);
    const id1 = renderMock.mock.calls[0]![0] as string;
    const id2 = renderMock.mock.calls[1]![0] as string;
    expect(id1).not.toBe(id2);
  });

  // 回归:实测宽图被压到 116px / 5%(祖先 ant-space-item 是 flex:0 1 auto,
  // width="100%" 对 shrink-to-fit 容器解析成 min-content)。useMaxWidth 开着
  // 时 mermaid 就是输出 width="100%"。
  it("disables useMaxWidth on every diagram type — percentage width collapses in a shrink-to-fit parent", async () => {
    const { renderMermaidDiagram } = await import("./mermaidRenderer.js");
    await renderMermaidDiagram("flowchart LR\n A-->B", LIGHT);
    const cfg = initializeMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(cfg.useMaxWidth).toBe(false);
    // per-diagram 配置**不继承**顶层默认值,漏写一个就退回 width="100%"
    for (const key of [
      "flowchart",
      "sequence",
      "class",
      "state",
      "er",
      "gantt",
      "pie",
      "mindmap",
      "journey",
      "timeline",
      "gitGraph",
      "quadrantChart",
      "xychart",
      "sankey",
    ]) {
      expect((cfg[key] as { useMaxWidth?: boolean } | undefined)?.useMaxWidth, key).toBe(false);
    }
  });

  // 回归:实测解析失败时 mermaid 会往 document.body 留一个 1417px 宽的
  // "Syntax error in text" SVG,脱离 React root 盖住输入框;流式输出时
  // 每个半截代码触发一次。suppressErrorRendering:true 让它只 throw 不渲染。
  it("sets suppressErrorRendering so a parse failure leaves no error SVG in the DOM", async () => {
    const { renderMermaidDiagram } = await import("./mermaidRenderer.js");
    await renderMermaidDiagram("flowchart LR\n A-->B", LIGHT);
    const cfg = initializeMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(cfg.suppressErrorRendering).toBe(true);
  });
});

describe("mermaidRenderer: buildThemeVariables", () => {
  it("maps the zai tokens onto mermaid's canvas/line/text variables", async () => {
    const { buildThemeVariables } = await import("./mermaidRenderer.js");
    const v = buildThemeVariables(DARK);
    expect(v.background).toBe(DARK.bg);
    expect(v.mainBkg).toBe(DARK.surface);
    expect(v.lineColor).toBe(DARK.line);
    expect(v.textColor).toBe(DARK.fg);
    expect(v.primaryColor).toBe(DARK.accent);
    // 节点描边走和箭头同一条 token(缺省那条 rgba(...,0.18) 在两种主题下
    // 都几乎看不见)
    expect(v.nodeBorder).toBe(DARK.line);
  });

  // 回归:用户报「流程图对比度太低」。mermaid base 主题把 nodeTextColor /
  // stateLabelColor / titleColor 等一批 token 缺省派生自 primaryTextColor,
  // 而 primaryTextColor 是给品牌橙底准备的深色 —— 于是暗色主题下节点字
  // 跟着变近黑(深字深底)、浅色主题下跟 primaryTextColor 的另一分支变白
  // (白字浅底),两种主题的节点文字全读不出来。
  it("never derives label text from the accent-side color (contrast regression)", async () => {
    const { buildThemeVariables } = await import("./mermaidRenderer.js");
    for (const t of [LIGHT, DARK]) {
      const v = buildThemeVariables(t);
      // 落在 surface / 画布上的字,必须等于该主题的前景字色
      expect(v.nodeTextColor, t.mode).toBe(t.fg);
      expect(v.textColor, t.mode).toBe(t.fg);
      expect(v.stateLabelColor, t.mode).toBe(t.fg);
      expect(v.titleColor, t.mode).toBe(t.fg);
      expect(v.classText, t.mode).toBe(t.fg);
      expect(v.actorTextColor, t.mode).toBe(t.fg);
      expect(v.labelTextColor, t.mode).toBe(t.fg);
      // 节点字色绝不能等于给 accent 用的那个色(近黑),否则暗色主题下
      // 就是本次报的「深字深底」
      expect(v.nodeTextColor, t.mode).not.toBe(v.primaryTextColor);
      // 边标签的底要贴着节点面,不能是缺省那条从中灰派生的药丸
      expect(v.edgeLabelBackground, t.mode).toBe(t.surface);
    }
  });

  it("pins the surface/neutral text pair so no label falls back to a mid-gray or its own fill", async () => {
    const { buildThemeVariables } = await import("./mermaidRenderer.js");
    const dark = buildThemeVariables(DARK);
    const light = buildThemeVariables(LIGHT);
    // 状态名缺省会被染成 stateBkg(= mainBkg,即节点底色本身)
    expect(dark.stateLabelColor).not.toBe(dark.mainBkg);
    expect(light.stateLabelColor).not.toBe(light.mainBkg);
    // 分组容器缺省 = tertiaryColor(中灰块)
    expect(dark.clusterBkg).toBe(DARK.bg);
    expect(light.clusterBkg).toBe(LIGHT.bg);
    // 复合状态内层缺省 = tertiaryColor
    expect(dark.altBackground).toBe(DARK.surface);
  });

  it("flips mermaid's own dark derivation with the theme (cScale / rowOdd-Even)", async () => {
    const { buildThemeVariables } = await import("./mermaidRenderer.js");
    // 只在 themeVariables 里给这个键才生效 —— 缺省一律按浅色推
    expect(buildThemeVariables(DARK).darkMode).toBe(true);
    expect(buildThemeVariables(LIGHT).darkMode).toBe(false);
    // 平涂,不要同色系渐变
    expect(buildThemeVariables(DARK).useGradient).toBe(false);
    // 暗色下关掉 neo look 的浅灰投影(深底上会变成每节点一道灰边);
    // 浅色下保留 mermaid 默认的柔和投影
    expect(buildThemeVariables(DARK).dropShadow).toBe("none");
    expect(buildThemeVariables(LIGHT).dropShadow).toBeUndefined();
  });

  it("picks a readable actor/note palette in dark vs light", async () => {
    const { buildThemeVariables } = await import("./mermaidRenderer.js");
    // 深色下 note 用深一档的底,浅色下用暖白 —— 两者都必须在各自画布上可见
    expect(buildThemeVariables(DARK).noteBkgColor).toBe("#1f2937");
    expect(buildThemeVariables(LIGHT).noteBkgColor).toBe("#fffbeb");
  });

  it("infers dark from bg luminance when mode is omitted", async () => {
    const { buildThemeVariables } = await import("./mermaidRenderer.js");
    const t = { ...DARK };
    delete (t as { mode?: string }).mode;
    expect(buildThemeVariables(t).noteBkgColor).toBe("#1f2937");
  });
});

describe("mermaidRenderer: sanitize + responsive", () => {
  it("sanitize strips <script> / <foreignObject> / on* / javascript: href", async () => {
    const { sanitizeSvg } = await import("./mermaidRenderer.js");
    const malicious = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert('xss')</script><foreignObject><iframe src="evil"></iframe></foreignObject><a href="javascript:alert(1)" onclick="evil()">x</a><rect onmouseover="x()" x="0" y="0" width="10" height="10"/></svg>`;
    const safe = sanitizeSvg(malicious);
    expect(safe).not.toMatch(/<script/i);
    expect(safe).not.toMatch(/<foreignObject/i);
    expect(safe).not.toMatch(/onclick=/i);
    expect(safe).not.toMatch(/onmouseover=/i);
    expect(safe).not.toMatch(/javascript:/i);
    // 安全部分保留
    expect(safe).toMatch(/<svg/i);
    expect(safe).toMatch(/<rect/i);
    expect(safe).toMatch(/<a>/);
  });

  it("keeps <style> — mermaid injects its CSS variables through it", async () => {
    const { sanitizeSvg } = await import("./mermaidRenderer.js");
    const svg = '<svg><style>.node{fill:#333}</style><g/></svg>';
    expect(sanitizeSvg(svg)).toContain("<style>");
  });

  it("clamps the svg root to the container (max-width + height:auto, no min-width floor)", async () => {
    const { makeSvgResponsive } = await import("./mermaidRenderer.js");
    const svg = fakeSvg();
    const out = makeSvgResponsive(svg);
    expect(out).toContain("max-width:100%");
    expect(out).toContain("height:auto");
    // 关键回归:留了 min-width 下限 → 缩不到容器内,被裁在面板外
    expect(out).not.toContain("min-width");
    // 原有的内联样式要保留,只是追加两条
    expect(out).toContain("background:var(--bg)");
  });

  it("preserves the intrinsic width/height/viewBox so aspect ratio survives", async () => {
    const { makeSvgResponsive } = await import("./mermaidRenderer.js");
    const out = makeSvgResponsive(fakeSvg(440, 120));
    expect(out).toContain('width="440"');
    expect(out).toContain('height="120"');
    expect(out).toContain("viewBox");
  });

  it("is a no-op for markup without an <svg> root", async () => {
    const { makeSvgResponsive } = await import("./mermaidRenderer.js");
    expect(makeSvgResponsive("<div>x</div>")).toBe("<div>x</div>");
  });

  it("naturalSvgWidth reads the intrinsic canvas width for the scale hint", async () => {
    const { naturalSvgWidth } = await import("./mermaidRenderer.js");
    expect(naturalSvgWidth('<svg width="1370" height="628"></svg>')).toBe(1370);
    expect(naturalSvgWidth("<svg></svg>")).toBeNull();
    expect(naturalSvgWidth("<div>x</div>")).toBeNull();
  });

  it("end-to-end: rendered svg is sanitized AND fit-to-container", async () => {
    vi.resetModules();
    renderMock.mockReset();
    renderMock.mockResolvedValue({
      svg: fakeSvg().replace("<g class=", '<g onclick="evil()" class='),
    });
    const { renderMermaidDiagram } = await import("./mermaidRenderer.js");
    const result = await renderMermaidDiagram("flowchart LR\n A-->B", DARK);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("mermaid");
    expect(result.svg).toContain("max-width:100%");
    expect(result.svg).not.toContain("min-width");
    expect(result.svg).not.toMatch(/onclick=/i);
  });
});

describe("mermaidRenderer: label contrast for author-styled nodes", () => {
  // 回归:LLM 生成的图爱写 `style D fill:#fde68a`,而 mermaid 的标签字色只认
  // 主题 token —— 深色主题下「白字压浅黄」1.2:1,整块读不出来。
  it("picks the higher-contrast text color for a given fill", async () => {
    const { labelColorOn, contrastRatio } = await import("./mermaidRenderer.js");
    // 浅底 → 深字
    expect(labelColorOn("rgb(253, 230, 138)")).toBe("#0a0a0f");
    expect(labelColorOn("#fca5a5")).toBe("#0a0a0f");
    // 深底 → 浅字
    expect(labelColorOn("#1a1a2e")).toBe("#f8fafc");
    expect(labelColorOn("rgba(18, 18, 26, 1)")).toBe("#f8fafc");
    // 主题面(浅色主题的 surface)也要落到深字
    expect(labelColorOn("#e2e8f0")).toBe("#0a0a0f");
    // 结果必须真的达标,而不是只挑了个相对好的
    expect(contrastRatio(labelColorOn("#fde68a")!, "#fde68a")!).toBeGreaterThan(4.5);
    expect(contrastRatio(labelColorOn("#1a1a2e")!, "#1a1a2e")!).toBeGreaterThan(4.5);
  });

  it("bails out on fills it cannot read (none / gradients) so the theme token wins", async () => {
    const { labelColorOn, contrastRatio, parseCssColor } = await import("./mermaidRenderer.js");
    expect(labelColorOn("none")).toBeNull();
    expect(labelColorOn("url(#gradient)")).toBeNull();
    expect(parseCssColor("rgb(1, 2, 3)")).toEqual([1, 2, 3]);
    expect(parseCssColor("#abc")).toEqual([170, 187, 204]);
    expect(parseCssColor("var(--x)")).toBeNull();
    expect(contrastRatio("#fff", "none")).toBeNull();
  });
});

describe("mermaidRenderer: error paths", () => {
  beforeEach(() => {
    vi.resetModules();
    renderMock.mockReset();
    initializeMock.mockReset();
  });

  it("surfaces a mermaid parse error instead of throwing", async () => {
    renderMock.mockRejectedValue(new Error("Parse error on line 2"));
    const { renderMermaidDiagram } = await import("./mermaidRenderer.js");
    const result = await renderMermaidDiagram("flowchart LR\n A[", DARK);
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("mermaid");
    expect(result.message).toContain("Parse error");
  });

  it("flags the empty-SVG case that happy-dom produces (no layout metrics)", async () => {
    renderMock.mockResolvedValue({ svg: "" });
    const { renderMermaidDiagram } = await import("./mermaidRenderer.js");
    const result = await renderMermaidDiagram("flowchart LR\n A-->B", DARK);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("空 SVG");
  });
});

describe("mermaidRenderer: cache + subscribe", () => {
  it("hasMermaidBundle flips false → true after the first render", async () => {
    vi.resetModules();
    renderMock.mockReset();
    renderMock.mockResolvedValue({ svg: fakeSvg() });
    const { renderMermaidDiagram, hasMermaidBundle } = await import("./mermaidRenderer.js");
    expect(hasMermaidBundle()).toBe(false);
    await renderMermaidDiagram("flowchart LR\n A-->B", DARK);
    expect(hasMermaidBundle()).toBe(true);
  });

  it("subscribeMermaidReady fires when the bundle becomes ready", async () => {
    vi.resetModules();
    renderMock.mockReset();
    renderMock.mockResolvedValue({ svg: fakeSvg() });
    const { subscribeMermaidReady, renderMermaidDiagram } = await import("./mermaidRenderer.js");
    let fired = false;
    subscribeMermaidReady(() => {
      fired = true;
    });
    await renderMermaidDiagram("flowchart LR\n A-->B", DARK);
    expect(fired).toBe(true);
  });

  it("subscribeMermaidReady still notifies when the bundle is already warm", async () => {
    vi.resetModules();
    renderMock.mockReset();
    renderMock.mockResolvedValue({ svg: fakeSvg() });
    const { subscribeMermaidReady, renderMermaidDiagram } = await import("./mermaidRenderer.js");
    await renderMermaidDiagram("flowchart LR\n A-->B", DARK);
    let fired = false;
    subscribeMermaidReady(() => {
      fired = true;
    });
    // 已经就绪 → 走 queueMicrotask,让出一个 microtask 再断言
    await new Promise((r) => setTimeout(r, 0));
    expect(fired).toBe(true);
  });
});
