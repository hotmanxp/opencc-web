// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MathBlock } from "./MathBlock.js";

// happy-dom 不跑 KaTeX 自身的渲染(MathBlock 不调 katex.renderToString,只接
// react-markdown 已经渲染好的 children),所以这里用预制的 KaTeX HTML 节点
// 作为 children 喂进去。
function fakeKatexDisplay(latex: string) {
  // 仿真实 KaTeX 产物:.katex-display > .katex > .katex-mathml > annotation
  // MathBlock 复制源码路径优先从 annotation[encoding=application/x-tex] 取
  return (
    <span className="katex-display">
      <span className="katex">
        <span className="katex-mathml">
          <annotation encoding="application/x-tex">{latex}</annotation>
        </span>
        <span className="katex-html">
          <span className="base">
            <span className="mord mathnormal">x</span>
          </span>
        </span>
      </span>
    </span>
  );
}

describe("MathBlock", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a card with header (label) and body containing the KaTeX children", () => {
    const { container } = render(<MathBlock>{fakeKatexDisplay("x^2")}</MathBlock>);
    expect(container.querySelector('[data-testid="math-block"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="math-block-header"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="math-block-body"]')).toBeTruthy();
    // KaTeX 节点应原样保留在 body 内
    expect(container.querySelector(".katex-display")).toBeTruthy();
    // 头部条展示 LaTeX 源码(短串直接展示)
    const header = container.querySelector('[data-testid="math-block-header"]');
    expect(header?.textContent).toContain("x^2");
  });

  it("truncates a long LaTeX source in the header label with an ellipsis", () => {
    const long = "a".repeat(80);
    const { container } = render(<MathBlock>{fakeKatexDisplay(long)}</MathBlock>);
    const header = container.querySelector('[data-testid="math-block-header"]');
    // 60 字符截断 + …
    expect(header?.textContent).toContain("…");
    expect(header?.textContent?.length).toBeLessThan(long.length + 10);
  });

  it("opens the menu, shows fullscreen + copy items, and closes on outside click", () => {
    const { container } = render(<MathBlock>{fakeKatexDisplay("x")}</MathBlock>);
    // 菜单默认关
    expect(container.querySelector('[data-testid="math-block-menu"]')).toBeNull();
    fireEvent.click(screen.getByTestId("math-block-menu-button"));
    expect(container.querySelector('[data-testid="math-block-menu"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="math-block-fullscreen-item"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="math-block-copy-item"]')).toBeTruthy();
    // 外部点击关闭
    fireEvent.mouseDown(document.body);
    expect(container.querySelector('[data-testid="math-block-menu"]')).toBeNull();
  });

  it("closes the menu on Escape", () => {
    render(<MathBlock>{fakeKatexDisplay("x")}</MathBlock>);
    fireEvent.click(screen.getByTestId("math-block-menu-button"));
    expect(screen.getByTestId("math-block-menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("math-block-menu")).toBeNull();
  });

  it("opens fullscreen portal via the menu item and closes on Escape", () => {
    const { container } = render(<MathBlock>{fakeKatexDisplay("x")}</MathBlock>);
    fireEvent.click(screen.getByTestId("math-block-menu-button"));
    fireEvent.click(screen.getByTestId("math-block-fullscreen-item"));
    // portal 渲染到 body
    const overlay = document.querySelector('[data-testid="math-fullscreen"]');
    expect(overlay).toBeTruthy();
    // 关闭按钮可点
    const closeBtn = document.querySelector(
      '[data-testid="math-fullscreen-close"]',
    ) as HTMLButtonElement;
    expect(closeBtn).toBeTruthy();
    // Esc 关闭
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.querySelector('[data-testid="math-fullscreen"]')).toBeNull();
    // 关闭后应恢复 body 滚动(可以重新被锁定再解锁)
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("copy menu item writes the LaTeX source to clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // happy-dom 把 navigator.clipboard 设为 getter-only;用 defineProperty 替换。
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    render(<MathBlock>{fakeKatexDisplay("a^2 + b^2 = c^2")}</MathBlock>);
    fireEvent.click(screen.getByTestId("math-block-menu-button"));
    fireEvent.click(screen.getByTestId("math-block-copy-item"));
    expect(writeText).toHaveBeenCalledWith("a^2 + b^2 = c^2");
    // 复制后菜单关闭(避免遮挡 KaTeX 主体)
    expect(screen.queryByTestId("math-block-menu")).toBeNull();
  });

  it("falls back to .katex text when no annotation[encoding=application/x-tex] is present", () => {
    // 没有 MathML 注释时,只能从可见文本里凑 —— 这条路径仅在 KaTeX 异常配置
    // 或上游升级时出现,作为兜底
    const { container } = render(
      <MathBlock>
        <span className="katex-display">
          <span className="katex">x+1</span>
        </span>
      </MathBlock>,
    );
    const header = container.querySelector('[data-testid="math-block-header"]');
    expect(header?.textContent).toContain("x+1");
  });
});
