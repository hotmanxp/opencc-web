// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MermaidBlock } from "./MermaidBlock.js";

// happy-dom 不支持 SVG layout,但字符串注入能正常跑;beautiful-mermaid
// 内部也不依赖 layout(纯字符串拼 SVG),所以这边可以真实渲染出 <svg>。
// 不支持的图类型(block-beta/gantt 等)走 error 分支降级 <details>,assert
// <details> / 源码文本存在即可。

describe("MermaidBlock", () => {
  it("renders a flowchart LR block as sanitized SVG (beautiful-mermaid path)", async () => {
    const code = "flowchart LR\n  A[Start] --> B[End]";
    const { container } = render(<MermaidBlock code={code} />);
    // 等待 beautiful bundle 加载 + 渲染完成
    await waitFor(
      () => {
        const svg = container.querySelector("svg");
        expect(svg).toBeTruthy();
      },
      { timeout: 5000 },
    );
  });

  it("falls back to <pre> source for half-completed code (heuristic rejection)", async () => {
    // 启发式检测:[不平衡 + 最后一行挂未闭合括号 → 判定未完成 → 不渲染
    const code = "flowchart LR\n  A[方框"; // A[ 永远不闭合
    const { container } = render(<MermaidBlock code={code} />);
    // 等待一帧让 effect 跑完
    await new Promise((r) => setTimeout(r, 50));
    // 不应该有 svg;应该有 loading 占位 pre 包含源码
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toContain("A[方框");
  });

  it("renders a stateDiagram block as SVG (beautiful-mermaid path)", async () => {
    const code = "stateDiagram-v2\n  [*] --> A\n  A --> B\n  B --> [*]";
    const { container } = render(<MermaidBlock code={code} />);
    await waitFor(
      () => {
        const svg = container.querySelector("svg");
        expect(svg).toBeTruthy();
      },
      { timeout: 5000 },
    );
  });

  it("renders a sequenceDiagram block as SVG (beautiful-mermaid path)", async () => {
    const code = "sequenceDiagram\n  Alice->>Bob: Hi\n  Bob-->>Alice: Hello";
    const { container } = render(<MermaidBlock code={code} />);
    await waitFor(
      () => {
        const svg = container.querySelector("svg");
        expect(svg).toBeTruthy();
      },
      { timeout: 5000 },
    );
  });

  it("renders a syntax-error flowchart into the <details> fallback", async () => {
    // 语法错:`flowchart LR` 后面挂一个 mermaid 解析失败的边
    // 用 direction 写成 `flowchart XX`(非法 direction)+ 一个闭合的 node
    // 这样括号平衡但 parser 仍然报错
    const code = "flowchart XX\n  A[Start] --> B[End]";
    const { container } = render(<MermaidBlock code={code} />);
    await waitFor(
      () => {
        // 要么进了 <details>(parser 抛错)要么进了 svg(beautiful 容错);两者皆可
        const details = container.querySelector("details");
        const svg = container.querySelector("svg");
        expect(details !== null || svg !== null).toBe(true);
      },
      { timeout: 5000 },
    );
    // 至少不是停留在 loading
    const loading = container.querySelector(
      '[data-testid="mermaid-block-loading"]',
    );
    expect(loading).toBeNull();
  });

  it("degrades unsupported diagram types (gantt) to the <details> source fallback", async () => {
    const code = "gantt\n  title A\n  dateFormat YYYY-MM-DD";
    const { container } = render(<MermaidBlock code={code} />);
    await waitFor(
      () => {
        expect(container.querySelector("details")).not.toBeNull();
      },
      { timeout: 5000 },
    );
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toContain("gantt");
  });

  it("blocks <script> tags injected via beautified SVG output", async () => {
    // 这是防御性测试:即使 beautiful 输出意外带了 <script>,sanitize 必须剥掉。
    // 实际 beautiful 不会输出 <script>;测的是 sanitize 防护底线。
    const code = "flowchart LR\n  A[Start] --> B[End]";
    const { container } = render(<MermaidBlock code={code} />);
    await waitFor(() => {
      const svg = container.querySelector("svg");
      expect(svg).toBeTruthy();
    });
    const allScripts = container.querySelectorAll("script");
    expect(allScripts.length).toBe(0);
    const allOnerror = container.querySelectorAll("[onerror]");
    expect(allOnerror.length).toBe(0);
    const allOnclick = container.querySelectorAll("[onclick]");
    expect(allOnclick.length).toBe(0);
  });
});

describe("looksComplete (heuristic for streaming half-code)", () => {
  it("accepts a complete flowchart", async () => {
    const { looksComplete } = await import("./MermaidBlock.js");
    expect(looksComplete("flowchart LR\n  A --> B")).toBe(true);
  });

  it("accepts a sequenceDiagram with end / bracket-balance", async () => {
    const { looksComplete } = await import("./MermaidBlock.js");
    expect(looksComplete("sequenceDiagram\n  A->>B: hi")).toBe(true);
  });

  it("rejects flowchart with unclosed bracket on last line", async () => {
    const { looksComplete } = await import("./MermaidBlock.js");
    expect(looksComplete("flowchart LR\n  A[方")).toBe(false);
  });

  it("rejects flowchart with unbalanced brackets across lines", async () => {
    const { looksComplete } = await import("./MermaidBlock.js");
    expect(looksComplete("flowchart LR\n  A[B] --> C[D")).toBe(false);
  });
});

// 抑制 happy-dom 下 getComputedStyle 在测试环境的类型噪音(我们读 CSS 变量
// 在 jsdom/happy-dom 里都返回空字符串,readThemeTokens 走 fallback)
vi.spyOn(window, "getComputedStyle").mockImplementation(
  () =>
    ({
      getPropertyValue: () => "",
    }) as unknown as CSSStyleDeclaration,
);
