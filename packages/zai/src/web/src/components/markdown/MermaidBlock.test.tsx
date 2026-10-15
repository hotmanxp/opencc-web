// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/react";
import { act } from "react";
import { MermaidBlock } from "./MermaidBlock.js";

// **为什么 mock 掉 mermaid**:官方 mermaid.js 靠 getBBox() / getComputedTextLength()
// 做文本度量,dagre 消费这些 box;happy-dom 里它们全是返回 0 的桩,于是 mermaid
// 静默产出空 SVG(实测 len=0,不抛错)。所以这里 mock 库、只断言**我们组件层**
// 的行为(状态机 / 容器 / 菜单 / 全屏 / 复制 / 半截代码);真库的渲染质量由
// ego-browser 在真浏览器里验。
const renderMock = vi.fn();
const initializeMock = vi.fn();

vi.mock("mermaid", () => ({
  default: {
    initialize: (...args: unknown[]) => initializeMock(...args),
    render: (...args: unknown[]) => renderMock(...args),
  },
}));

function fakeSvg(width = 1370, height = 628): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}"><g class="node"><text>Node</text></g></svg>`
  );
}

beforeEach(() => {
  renderMock.mockReset();
  initializeMock.mockReset();
  renderMock.mockResolvedValue({ svg: fakeSvg() });
});

describe("MermaidBlock", () => {
  it("renders a flowchart LR block as sanitized SVG", async () => {
    const { container } = render(<MermaidBlock code={"flowchart LR\n  A[Start] --> B[End]"} />);
    await waitFor(
      () => {
        expect(container.querySelector("svg")).toBeTruthy();
      },
      { timeout: 5000 },
    );
    expect(container.querySelector('[data-testid="mermaid-block"]')).toBeTruthy();
  });

  it("falls back to <pre> source for half-completed code (heuristic rejection)", async () => {
    const code = "flowchart LR\n  A[方框"; // A[ 永远不闭合
    const { container } = render(<MermaidBlock code={code} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toContain("A[方框");
    // 半截代码不该白触发一次渲染
    expect(renderMock).not.toHaveBeenCalled();
  });

  it("renders diagram types that the old 6-type gate rejected", async () => {
    // 换库的核心收益:gantt 以前走 <details> 降级,现在正常出图
    for (const code of [
      "gantt\n  title A\n  dateFormat YYYY-MM-DD\n  section S\n  Task :a1, 2026-01-01, 1d",
      "pie\n  title A\n  \"x\" : 10\n  \"y\" : 20",
      "mindmap\n  root",
    ]) {
      const { container, unmount } = render(<MermaidBlock code={code} />);
      await waitFor(
        () => {
          expect(container.querySelector("svg"), code.slice(0, 20)).toBeTruthy();
        },
        { timeout: 5000 },
      );
      expect(container.querySelector("details")).toBeNull();
      unmount();
    }
  });

  it("renders a syntax-error diagram into the <details> fallback", async () => {
    renderMock.mockRejectedValue(new Error("Parse error on line 2"));
    // `XX` 不是合法 direction:括号平衡、末行无悬挂括号 → 能过 looksComplete,
    // 真正死在 mermaid 的 parser 上(不能拿"半截代码"当语法错用例,那会被
    // looksComplete 提前拦掉,停在 loading <pre> 而不是 <details>)
    const { container } = render(<MermaidBlock code={"flowchart XX\n  A --> B"} />);
    await waitFor(
      () => {
        expect(container.querySelector("details")).not.toBeNull();
      },
      { timeout: 5000 },
    );
    // 降级时把源码 + 错误原因都给用户,而不是空壳
    expect(container.textContent).toContain("flowchart XX");
    expect(container.textContent).toContain("Parse error");
    // 停在 loading 说明状态机没走完
    expect(
      container.querySelector('[data-testid="mermaid-block-loading"]'),
    ).toBeNull();
  });

  it("blocks <script> tags injected via the rendered SVG", async () => {
    renderMock.mockResolvedValue({
      svg: fakeSvg().replace("<g class=", '<g onclick="evil()" class='),
    });
    const { container } = render(<MermaidBlock code={"flowchart LR\n  A --> B"} />);
    await waitFor(() => {
      expect(container.querySelector("svg")).toBeTruthy();
    });
    expect(container.querySelectorAll("script").length).toBe(0);
    expect(container.querySelectorAll("[onerror]").length).toBe(0);
    expect(container.querySelectorAll("[onclick]").length).toBe(0);
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

// ---- 外层容器:缩到全部可见 + 菜单(全屏预览 / 复制源码)------------------

const WIDE_SEQ = [
  "sequenceDiagram",
  "  participant Client as Client (AgentInputBox)",
  "  participant Store as Store (Zustand)",
  "  participant Route as Route (POST /api/agent/prompt)",
  "  participant Loop as Loop (runQueryLoop)",
  "  Client->>Store: dispatch(sendPrompt)",
  "  Store->>Route: POST prompt",
  "  Route->>Loop: runQueryLoop",
].join("\n");

async function renderRendered(code: string) {
  const utils = render(<MermaidBlock code={code} />);
  await waitFor(
    () => {
      expect(utils.container.querySelector("svg")).toBeTruthy();
    },
    { timeout: 5000 },
  );
  return utils;
}

describe("MermaidBlock container menu + fullscreen preview", () => {
  afterEach(() => {
    // portal 挂在 document.body 上,unmount 之外的残留手动清掉
    document
      .querySelectorAll('[data-testid="mermaid-fullscreen"]')
      .forEach((n) => n.remove());
    document.body.style.overflow = "";
  });

  it("wraps the svg in a container with a header bar (title) and a closed menu by default", async () => {
    const { container } = await renderRendered(WIDE_SEQ);
    const block = container.querySelector('[data-testid="mermaid-block"]');
    expect(block).toBeTruthy();
    expect(block?.querySelector("svg")).toBeTruthy();

    const header = container.querySelector('[data-testid="mermaid-block-header"]');
    expect(header).toBeTruthy();
    expect(header?.textContent).toContain("Mermaid");
    expect(header?.textContent).toContain("时序图");
    const button = header?.querySelector('[data-testid="mermaid-block-menu-button"]');
    expect(button).toBeTruthy();

    expect(container.querySelector('[data-testid="mermaid-block-menu"]')).toBeNull();
    expect(button?.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows the diagram-type label for newly-supported types", async () => {
    const { container } = await renderRendered("gantt\n  title A\n  dateFormat YYYY-MM-DD");
    const header = container.querySelector('[data-testid="mermaid-block-header"]');
    expect(header?.textContent).toContain("甘特图");
  });

  it("opens the menu with 全屏预览 / 复制源码 items", async () => {
    const { container } = await renderRendered(WIDE_SEQ);
    const button = container.querySelector(
      '[data-testid="mermaid-block-menu-button"]',
    ) as HTMLElement;
    fireEvent.click(button);
    const menu = container.querySelector('[data-testid="mermaid-block-menu"]');
    expect(menu).toBeTruthy();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(menu?.textContent).toContain("全屏预览");
    expect(menu?.textContent).toContain("复制源码");
  });

  it("closes the menu when clicking outside", async () => {
    const { container } = await renderRendered(WIDE_SEQ);
    fireEvent.click(
      container.querySelector(
        '[data-testid="mermaid-block-menu-button"]',
      ) as HTMLElement,
    );
    expect(container.querySelector('[data-testid="mermaid-block-menu"]')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(container.querySelector('[data-testid="mermaid-block-menu"]')).toBeNull();
  });

  it("全屏预览 portals an overlay holding the same svg, and closes on demand", async () => {
    const { container } = await renderRendered(WIDE_SEQ);
    fireEvent.click(
      container.querySelector(
        '[data-testid="mermaid-block-menu-button"]',
      ) as HTMLElement,
    );
    fireEvent.click(
      container.querySelector(
        '[data-testid="mermaid-block-fullscreen-item"]',
      ) as HTMLElement,
    );

    const overlay = document.querySelector(
      '[data-testid="mermaid-fullscreen"]',
    ) as HTMLElement;
    expect(overlay).toBeTruthy();
    // portal 到 body:不在组件子树里
    expect(container.contains(overlay)).toBe(false);
    expect(overlay.querySelector("svg")).toBeTruthy();
    expect(container.querySelector('[data-testid="mermaid-block-menu"]')).toBeNull();
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(
      document.querySelector(
        '[data-testid="mermaid-fullscreen-close"]',
      ) as HTMLElement,
    );
    expect(document.querySelector('[data-testid="mermaid-fullscreen"]')).toBeNull();
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(container.querySelector('[data-testid="mermaid-block"] svg')).toBeTruthy();
  });

  it("closes the overlay with Esc", async () => {
    const { container } = await renderRendered(WIDE_SEQ);
    fireEvent.click(
      container.querySelector(
        '[data-testid="mermaid-block-menu-button"]',
      ) as HTMLElement,
    );
    fireEvent.click(
      container.querySelector(
        '[data-testid="mermaid-block-fullscreen-item"]',
      ) as HTMLElement,
    );
    expect(document.querySelector('[data-testid="mermaid-fullscreen"]')).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(document.querySelector('[data-testid="mermaid-fullscreen"]')).toBeNull();
  });

  it("复制源码 writes the raw mermaid code to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const { container } = await renderRendered(WIDE_SEQ);
    fireEvent.click(
      container.querySelector(
        '[data-testid="mermaid-block-menu-button"]',
      ) as HTMLElement,
    );
    const copyItem = [...container.querySelectorAll('[role="menuitem"]')].find(
      (el) => el.textContent?.includes("复制源码"),
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(copyItem);
    });
    expect(writeText).toHaveBeenCalledWith(WIDE_SEQ);
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
