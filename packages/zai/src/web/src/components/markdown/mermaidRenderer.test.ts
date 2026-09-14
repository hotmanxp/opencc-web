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
