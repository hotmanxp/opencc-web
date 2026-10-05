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
    expect(v.nodeBorder).toBe(DARK.border);
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
