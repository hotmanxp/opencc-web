// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// 直接测 detect-type 路由(sanitize + render 走 happy-dom 不一定稳定,留给
// MermaidBlock.test.tsx 端到端测)。detect 逻辑通过 renderMermaidDiagram
// 返回的 kind 字段验证。

describe("mermaidRenderer detect-type routing", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes flowchart LR to beautiful-mermaid", async () => {
    const { renderMermaidDiagram } = await import("./mermaidRenderer.js");
    const result = await renderMermaidDiagram("flowchart LR\n A-->B", {
      bg: "#fff",
      fg: "#000",
      line: "#888",
      accent: "#f00",
      muted: "#ccc",
      surface: "#eee",
      border: "#333",
    });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("beautiful");
  });

  it("routes graph TD (alias for flowchart) to beautiful-mermaid", async () => {
    const { renderMermaidDiagram } = await import("./mermaidRenderer.js");
    const result = await renderMermaidDiagram("graph TD\n A-->B", {
      bg: "#fff",
      fg: "#000",
      line: "#888",
      accent: "#f00",
      muted: "#ccc",
      surface: "#eee",
      border: "#333",
    });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("beautiful");
  });

  it("routes sequenceDiagram to beautiful-mermaid", async () => {
    const { renderMermaidDiagram } = await import("./mermaidRenderer.js");
    const result = await renderMermaidDiagram("sequenceDiagram\n A->>B: hi", {
      bg: "#fff",
      fg: "#000",
      line: "#888",
      accent: "#f00",
      muted: "#ccc",
      surface: "#eee",
      border: "#333",
    });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("beautiful");
  });

  it("routes stateDiagram-v2 to beautiful-mermaid", async () => {
    const { renderMermaidDiagram } = await import("./mermaidRenderer.js");
    const result = await renderMermaidDiagram("stateDiagram-v2\n [*] --> A", {
      bg: "#fff",
      fg: "#000",
      line: "#888",
      accent: "#f00",
      muted: "#ccc",
      surface: "#eee",
      border: "#333",
    });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("beautiful");
  });

  it("routes classDiagram to beautiful-mermaid", async () => {
    const { renderMermaidDiagram } = await import("./mermaidRenderer.js");
    const result = await renderMermaidDiagram("classDiagram\n class A", {
      bg: "#fff",
      fg: "#000",
      line: "#888",
      accent: "#f00",
      muted: "#ccc",
      surface: "#eee",
      border: "#333",
    });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("beautiful");
  });

  it("routes erDiagram to beautiful-mermaid", async () => {
    const { renderMermaidDiagram } = await import("./mermaidRenderer.js");
    const result = await renderMermaidDiagram(
      "erDiagram\n  USER ||--o{ POST : has\n  POST ||--|{ COMMENT : has",
      {
        bg: "#fff",
        fg: "#000",
        line: "#888",
        accent: "#f00",
        muted: "#ccc",
        surface: "#eee",
        border: "#333",
      },
    );
    if (!result.ok) console.log("erDiagram err:", result.message);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("beautiful");
  });

  it("routes xychart-beta to beautiful-mermaid", async () => {
    const { renderMermaidDiagram } = await import("./mermaidRenderer.js");
    const result = await renderMermaidDiagram(
      "xychart-beta\n  line [1,2]\n  x [\"a\",\"b\"]",
      {
        bg: "#fff",
        fg: "#000",
        line: "#888",
        accent: "#f00",
        muted: "#ccc",
        surface: "#eee",
        border: "#333",
      },
    );
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("beautiful");
  });

  it("rejects block-beta as unsupported (no mermaidjs fallback anymore)", async () => {
    const { renderMermaidDiagram } = await import("./mermaidRenderer.js");
    const result = await renderMermaidDiagram(
      "block-beta\n  columns 1\n  block:A\n  end",
      {
        bg: "#fff",
        fg: "#000",
        line: "#888",
        accent: "#f00",
        muted: "#ccc",
        surface: "#eee",
        border: "#333",
      },
    );
    // 官方 mermaid 库已移除:冷门类型直接降级,不渲染、也不抛错
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("unsupported");
    expect(result.message).toContain("block-beta");
  });

  it("rejects gantt as unsupported (no mermaidjs fallback anymore)", async () => {
    const { renderMermaidDiagram } = await import("./mermaidRenderer.js");
    const result = await renderMermaidDiagram(
      "gantt\n  title A\n  dateFormat YYYY-MM-DD\n  section S\n  Task :a1, 2026-01-01, 1d",
      {
        bg: "#fff",
        fg: "#000",
        line: "#888",
        accent: "#f00",
        muted: "#ccc",
        surface: "#eee",
        border: "#333",
      },
    );
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("unsupported");
  });

  it("isSupportedMermaid accepts the 6 supported types and rejects others", async () => {
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
    for (const bad of ["pie\n title A", "gitGraph\n commit", "mindmap\n root", ""]) {
      expect(isSupportedMermaid(bad), bad).toBe(false);
    }
  });

  it("mermaidDiagramLabel maps the diagram type to the container title", async () => {
    const { mermaidDiagramLabel } = await import("./mermaidRenderer.js");
    expect(mermaidDiagramLabel("sequenceDiagram\n A->>B: hi")).toBe("时序图");
    expect(mermaidDiagramLabel("flowchart LR\n A-->B")).toBe("流程图");
    expect(mermaidDiagramLabel("graph TD\n A-->B")).toBe("流程图");
    expect(mermaidDiagramLabel("classDiagram\n class A")).toBe("类图");
    expect(mermaidDiagramLabel("stateDiagram-v2\n [*] --> A")).toBe("状态图");
    expect(mermaidDiagramLabel("erDiagram\n A ||--o{ B : has")).toBe("ER 图");
    expect(mermaidDiagramLabel("xychart-beta\n line [1,2]")).toBe("图表");
    // 认不出类型(gantt 之类)也不空标题
    expect(mermaidDiagramLabel("gantt\n title A")).toBe("图表");
    // 前面有注释/空行同样能认
    expect(mermaidDiagramLabel("%% c\n\n  flowchart LR\n A-->B")).toBe("流程图");
  });

  it("renders a flowchart into sanitized SVG without dangerous attrs", async () => {
    // 正常路径:有 svg
    const { renderMermaidDiagram } = await import("./mermaidRenderer.js");
    const result = await renderMermaidDiagram(
      "flowchart LR\n  A-->B",
      {
        bg: "#fff",
        fg: "#000",
        line: "#888",
        accent: "#f00",
        muted: "#ccc",
        surface: "#eee",
        border: "#333",
      },
    );
    expect(result.ok).toBe(true);
    expect(result.svg).toBeTruthy();
    // sanitize 后不含危险 attr
    expect(result.svg).not.toMatch(/<script/i);
    expect(result.svg).not.toMatch(/onerror=/i);
    expect(result.svg).not.toMatch(/onclick=/i);
  });

  it("sanitize strips <script> / <foreignObject> / on* / javascript: href", async () => {
    const { sanitizeSvg } = await import("./mermaidRenderer.js");
    const malicious = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert('xss')</script><foreignObject><iframe src="evil"></iframe></foreignObject><a href="javascript:alert(1)" onclick="evil()">x</a><rect onmouseover="x()" x="0" y="0" width="10" height="10"/></svg>`;
    const safe = sanitizeSvg(malicious);
    expect(safe).not.toMatch(/<script/i);
    expect(safe).not.toMatch(/<foreignObject/i);
    expect(safe).not.toMatch(/onclick=/i);
    expect(safe).not.toMatch(/onmouseover=/i);
    expect(safe).not.toMatch(/javascript:/i);
    // 安全部分(<svg>/<a>/<rect>)保留
    expect(safe).toMatch(/<svg/i);
    expect(safe).toMatch(/<rect/i);
    // 注:a 标签的 href="javascript:" 被剥掉,只剩纯 `<a>x</a>`(无 attr)
    expect(safe).toMatch(/<a>/);
  });
});

// ---- rect 色块(sequenceDiagram `rect <color> ... end`)--------------------
//
// 回归用例:beautiful-mermaid 1.1.3 把 rect 当普通 block 渲染 —— 块底
// fill="none"(没有底色)、label(颜色字面量)被当成标题画在左上角。见
// mermaidRenderer.applyRectBands 头注释。

const SEQ_WITH_RECT = [
  "sequenceDiagram",
  "  participant A",
  "  participant B",
  "  rect rgb(245,245,245)",
  "  A->>B: one",
  "  end",
  "  B->>A: two",
].join("\n");

function theme(mode: "light" | "dark"): MermaidThemeLike {
  return {
    bg: mode === "dark" ? "#12121a" : "#ffffff",
    fg: mode === "dark" ? "#f8fafc" : "#1f1f1f",
    line: "#f97316",
    accent: "#f97316",
    muted: "#94a3b8",
    surface: "#1a1a2e",
    border: "rgba(249, 115, 22, 0.18)",
    mode,
  };
}

type MermaidThemeLike = {
  bg: string;
  fg: string;
  line: string;
  accent: string;
  muted: string;
  surface: string;
  border: string;
  mode?: "light" | "dark";
};

describe("mermaidRenderer rect band", () => {
  const RAW_RECT_GROUP =
    '<g class="block" data-type="rect" data-label="rgb(245,245,245)">\n' +
    '  <rect x="30" y="78" width="419" height="60" rx="0" ry="0" fill="none" stroke="var(--_node-stroke)" stroke-width="1" />\n' +
    '  <rect x="30" y="78" width="137.11" height="18" fill="var(--_group-hdr)" stroke="var(--_node-stroke)" stroke-width="1" />\n' +
    '  <text x="36" y="87" font-size="11" font-weight="600" fill="var(--_text-sec)">rect [rgb(245,245,245)]</text>\n' +
    "</g>";

  it("paints the block rect and drops the label tab", async () => {
    const { applyRectBands } = await import("./mermaidRenderer.js");
    const out = applyRectBands(RAW_RECT_GROUP, theme("light"));
    // 块底铺上颜色。rgb(245,245,245) 与浅色画布(#ffffff)几乎同色,按对比度
    // 下限朝文字色(#1f1f1f)混 12% → rgb(219,219,219)
    expect(out).toMatch(/fill="rgb\(219,219,219\)"/);
    expect(out).not.toMatch(/fill="none"/);
    // tab + 垃圾标题都没了
    expect(out).not.toMatch(/var\(--_group-hdr\)/);
    expect(out).not.toContain("rect [rgb(245,245,245)]");
    expect(out).not.toMatch(/<text/);
    // g 保留;data-label(原始颜色字面量)被消费掉,不再留在产物里
    expect(out).toContain('data-type="rect"');
    expect(out).not.toContain("data-label");
  });

  it("keeps the source color when it already contrasts the canvas", async () => {
    const { applyRectBands } = await import("./mermaidRenderer.js");
    const hover = applyRectBands(
      RAW_RECT_GROUP.replace(/rgb\(245,245,245\)/g, "#e0f2fe"),
      theme("light"),
    );
    expect(hover).toMatch(/fill="rgb\(224,242,254\)"/);
    expect(hover).not.toMatch(/fill-opacity/);
  });

  it("dims the band in dark theme so text stays readable", async () => {
    const { applyRectBands } = await import("./mermaidRenderer.js");
    const out = applyRectBands(RAW_RECT_GROUP, theme("dark"));
    expect(out).toMatch(/fill="rgb\(245,245,245\)" fill-opacity="0\.18"/);
  });

  it("infers dark theme from bg luminance when mode is omitted", async () => {
    const { applyRectBands } = await import("./mermaidRenderer.js");
    const t = theme("dark");
    delete t.mode;
    const out = applyRectBands(RAW_RECT_GROUP, t);
    expect(out).toMatch(/fill-opacity="0\.18"/);
  });

  it("falls back to the theme group background for a bare `rect`", async () => {
    const { applyRectBands } = await import("./mermaidRenderer.js");
    const bare = RAW_RECT_GROUP.replace(/ data-label="[^"]*"/, "");
    const out = applyRectBands(bare, theme("dark"));
    expect(out).toMatch(/fill="var\(--_group-hdr\)"/);
    expect(out).not.toMatch(/<text/);
  });

  it("accepts hex labels and rejects non-color labels", async () => {
    const { applyRectBands } = await import("./mermaidRenderer.js");
    const hex = applyRectBands(
      RAW_RECT_GROUP.replace("rgb(245,245,245)", "#e0f2fe").replace(
        "rect [rgb(245,245,245)]",
        "rect [#e0f2fe]",
      ),
      theme("light"),
    );
    expect(hex).toMatch(/fill="rgb\(224,242,254\)"/);

    // 非颜色字符串不能进 fill 属性(潜在注入面)
    const bad = applyRectBands(
      RAW_RECT_GROUP.replace(
        'data-label="rgb(245,245,245)"',
        'data-label="red&quot; onload=&quot;x"',
      ),
      theme("light"),
    );
    expect(bad).not.toMatch(/onload/);
    expect(bad).toMatch(/fill="var\(--_group-hdr\)"/);
  });

  it("leaves svg without rect blocks untouched", async () => {
    const { applyRectBands } = await import("./mermaidRenderer.js");
    const svg = '<svg><g class="block" data-type="loop" data-label="x">t</g></svg>';
    expect(applyRectBands(svg, theme("dark"))).toBe(svg);
  });

  it("end-to-end: sequenceDiagram rect renders a band, not a `rect [...]` label", async () => {
    const { renderMermaidDiagram } = await import("./mermaidRenderer.js");
    const result = await renderMermaidDiagram(SEQ_WITH_RECT, theme("dark"));
    expect(result.ok).toBe(true);
    const svg = result.svg ?? "";
    // 修复前的症状:左上角画出 "rect [rgb(245,245,245)]" 且块底 fill="none"
    expect(svg).not.toContain("rect [rgb(245,245,245)]");
    expect(svg).toMatch(/data-type="rect"/);
    expect(svg).toMatch(/fill="rgb\(245,245,245\)" fill-opacity="0\.18"/);
  });

  it("end-to-end: light theme paints a visible band for a near-canvas rect color", async () => {
    const { renderMermaidDiagram } = await import("./mermaidRenderer.js");
    const result = await renderMermaidDiagram(SEQ_WITH_RECT, theme("light"));
    expect(result.ok).toBe(true);
    const svg = result.svg ?? "";
    expect(svg).not.toContain("rect [rgb(245,245,245)]");
    expect(svg).toMatch(/fill="rgb\(219,219,219\)"/);
    expect(svg).not.toMatch(/fill-opacity/);
  });
});

// ---- 根 svg 尺寸(宽图不能撑破消息列)------------------------------------

describe("mermaidRenderer responsive svg root", () => {
  it("clamps the svg to the container (max-width + height:auto, no min-width floor)", async () => {
    const { makeSvgResponsive } = await import("./mermaidRenderer.js");
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1370 628" width="1370" height="628" style="--bg:#fff;background:var(--bg)"><rect/></svg>';
    const out = makeSvgResponsive(svg);
    expect(out).toContain("max-width:100%");
    expect(out).toContain("height:auto");
    // 关键回归:旧实现留了 min-width 缩放下限 → 图缩不到容器内,被裁在面板外
    expect(out).not.toContain("min-width");
    // 原有主题变量保留
    expect(out).toContain("--bg:#fff");
    // 只改根标签,内容不动
    expect(out).toContain("<rect/>");
  });

  it("keeps the aspect ratio source (width/height attrs + viewBox) intact", async () => {
    const { makeSvgResponsive } = await import("./mermaidRenderer.js");
    const svg = '<svg width="440" height="120" viewBox="0 0 440 120"></svg>';
    const out = makeSvgResponsive(svg);
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

  it("end-to-end: rendered svg carries the fit-to-container style", async () => {
    const { renderMermaidDiagram } = await import("./mermaidRenderer.js");
    const result = await renderMermaidDiagram(SEQ_WITH_RECT, theme("dark"));
    expect(result.svg).toContain("max-width:100%");
    expect(result.svg).not.toContain("min-width");
  });
});

describe("mermaidRenderer cache + subscribe", () => {
  it("hasMermaidBundle returns false initially, true after first render", async () => {
    vi.resetModules();
    const { renderMermaidDiagram, hasMermaidBundle } = await import(
      "./mermaidRenderer.js"
    );
    expect(hasMermaidBundle()).toBe(false);
    await renderMermaidDiagram("flowchart LR\n A-->B", {
      bg: "#fff",
      fg: "#000",
      line: "#888",
      accent: "#f00",
      muted: "#ccc",
      surface: "#eee",
      border: "#333",
    });
    expect(hasMermaidBundle()).toBe(true);
  });

  it("subscribeMermaidReady fires when bundle becomes ready", async () => {
    vi.resetModules();
    const { subscribeMermaidReady, renderMermaidDiagram } = await import(
      "./mermaidRenderer.js"
    );
    let fired = false;
    subscribeMermaidReady(() => {
      fired = true;
    });
    await renderMermaidDiagram("flowchart LR\n A-->B", {
      bg: "#fff",
      fg: "#000",
      line: "#888",
      accent: "#f00",
      muted: "#ccc",
      surface: "#eee",
      border: "#333",
    });
    expect(fired).toBe(true);
  });
});
