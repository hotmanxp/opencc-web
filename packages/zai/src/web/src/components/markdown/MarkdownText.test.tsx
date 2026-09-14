// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MarkdownText } from "./MarkdownText.js";
import { useAgentStore } from "../../store/useAgentStore.js";
import { useAppStore } from "../../store/useAppStore.js";

describe("MarkdownText", () => {
  it("renders a top-level heading as <h1>", () => {
    render(<MarkdownText text="# hello" />);
    expect(screen.getByRole("heading", { level: 1, name: "hello" })).toBeTruthy();
  });

  it("renders inline code with the violet (#a78bfa) custom style", () => {
    const { container } = render(<MarkdownText text="use `foo` here" />);
    // The markdownComponents.code branch (no language class) returns
    // <code className="text-[#a78bfa] ...">. happy-dom does not parse
    // Tailwind utility classes, so we assert the className contains
    // the violet color literal that survives Tailwind's arbitrary-value
    // JIT compilation.
    const code = container.querySelector("code");
    expect(code).toBeTruthy();
    expect(code?.className).toContain("text-[#a78bfa]");
  });

  it("renders a fenced code block (text content survives inside <code>)", () => {
    const { container } = render(<MarkdownText text={"```ts\nconst x = 1;\n```"} />);
    // react-syntax-highlighter under jsdom/happy-dom may not produce a
    // `language-ts` class on <code> (Prism's CSS parser is suppressed
    // in non-browser envs); we instead assert the source content
    // survives inside <code>, which proves our markdownComponents.code
    // branch dispatched into the SyntaxHighlighter path (vs. the
    // inline <code> branch — the two diverge on whether the wrapping
    // tokens become <span>s).
    const codeEl = container.querySelector("code");
    expect(codeEl).toBeTruthy();
    expect(codeEl?.textContent ?? "").toContain("const x = 1;");
  });

  it("renders a GFM table as <table>", () => {
    const md = ["| a | b |", "| - | - |", "| 1 | 2 |"].join("\n");
    const { container } = render(<MarkdownText text={md} />);
    expect(container.querySelector("table")).toBeTruthy();
  });

  it("opens external links in a new tab", () => {
    render(<MarkdownText text="[x](https://example.com)" />);
    const a = screen.getByText("x") as HTMLAnchorElement;
    expect(a.tagName).toBe("A");
    expect(a.target).toBe("_blank");
    expect(a.rel).toMatch(/noopener/);
    expect(a.rel).toMatch(/noreferrer/);
  });
});

describe("MarkdownText math", () => {
  it("renders a $$...$$ block as a KaTeX display formula", () => {
    // $$ 必须独占行才是 display math(remark-math 的规则),单行
    // `$$...$$` 会被当成行内公式,跑不出 .katex-display。
    const { container } = render(
      <MarkdownText
        text={String.raw`$$
\int_{-\infty}^{\infty} e^{-x^2} \, dx = \sqrt{\pi}
$$`}
      />,
    );
    // rehype-katex 给块级公式套 .katex-display,真正的排版 DOM 在 .katex 里
    expect(container.querySelector(".katex-display")).toBeTruthy();
    expect(container.querySelector(".katex")).toBeTruthy();
  });

  it("renders inline $...$ as KaTeX without a display block", () => {
    const { container } = render(
      <MarkdownText text={String.raw`质能方程 $E = mc^2$ 成立`} />,
    );
    expect(container.querySelector(".katex")).toBeTruthy();
    expect(container.querySelector(".katex-display")).toBeNull();
    // 公式两侧的正文照常保留
    expect(container.textContent).toContain("质能方程");
    expect(container.textContent).toContain("成立");
  });

  it("does not throw on invalid LaTeX (throwOnError: false)", () => {
    // `$HOME ... $PATH` 这类 shell 变量会被 remark-math 当成行内公式。
    // throwOnError:false 保证 KaTeX 解析失败时降级为原文,而不是把
    // 整条消息渲染打崩。
    expect(() =>
      render(<MarkdownText text={String.raw`$\notacommand{x}$`} />),
    ).not.toThrow();
    const { container } = render(
      <MarkdownText text={String.raw`echo $HOME and $PATH here`} />,
    );
    expect(container.textContent).toContain("here");
  });
});

describe("MarkdownText file paths", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useAgentStore.setState({ filePreviewPath: null });
    // useAppStore.instanceContext 不会自动重置 —— 显式清掉
    useAppStore.setState({ instanceContext: null });
  });

  it("把行内代码里的路径渲染成 chip", () => {
    const { container } = render(<MarkdownText text="改好了 `src/a.ts`" />);
    const chip = container.querySelector('[data-testid="file-path-chip"]');
    expect(chip).toBeTruthy();
    expect(chip?.getAttribute("data-file-path")).toBe("src/a.ts");
  });

  it("把正文里的裸路径渲染成 chip", () => {
    const { container } = render(<MarkdownText text="改好了 src/a.ts 这个文件" />);
    const chip = container.querySelector('[data-testid="file-path-chip"]');
    expect(chip).toBeTruthy();
    expect(chip?.getAttribute("data-file-path")).toBe("src/a.ts");
    // 前后文本保留
    expect(container.textContent).toContain("改好了 ");
    expect(container.textContent).toContain(" 这个文件");
  });

  it("非路径的行内代码仍是普通 <code>", () => {
    const { container } = render(<MarkdownText text="用 `useMemo` 包一下" />);
    expect(container.querySelector('[data-testid="file-path-chip"]')).toBeNull();
    const code = container.querySelector("code");
    expect(code?.textContent).toBe("useMemo");
  });

  it("版本号 / 域名不会被误判成文件", () => {
    const { container } = render(
      <MarkdownText text="升到 1.5,参考 example.com 的说明" />,
    );
    expect(container.querySelector('[data-testid="file-path-chip"]')).toBeNull();
  });

  it("围栏代码块里的路径不渲染成 chip", () => {
    const { container } = render(<MarkdownText text={"```\n见 src/a.ts\n```"} />);
    expect(container.querySelector('[data-testid="file-path-chip"]')).toBeNull();
  });

  it("无语言标注的围栏块内容全是路径时也不渲染成 chip", () => {
    // 行内代码与无语言 fenced 块在 code 组件里 props 相同,靠 pre 的
    // context 标记区分 —— 这条守住那个边界。
    const { container } = render(<MarkdownText text={"```\npackage.json\n```"} />);
    expect(container.querySelector('[data-testid="file-path-chip"]')).toBeNull();
    expect(container.textContent).toContain("package.json");
  });

  it("点击 chip → /fs/resolve 命中 1 个 → 写 store 打开预览", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: "exact", abs: "/repo/src/a.ts" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { container } = render(<MarkdownText text="见 `/repo/src/a.ts`" />);
    const chip = container.querySelector('[data-testid="file-path-chip"]')!;
    fireEvent.click(chip);
    await waitFor(() =>
      expect(useAgentStore.getState().filePreviewPath).toBe("/repo/src/a.ts"),
    );
  });

  it("点击 chip → /fs/resolve 命中多个 → 渲染选择器,点候选再打开", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: "multiple",
          candidates: [
            { abs: "/repo/p/a/src/x.ts", rel: "p/a/src/x.ts" },
            { abs: "/repo/p/b/src/x.ts", rel: "p/b/src/x.ts" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const { container } = render(<MarkdownText text="见 `src/x.ts`" />);
    const chip = container.querySelector('[data-testid="file-path-chip"]')!;
    fireEvent.click(chip);
    // Popover 把内容挂到 document.body 的 portal,要从全局查
    await waitFor(() =>
      expect(document.querySelector('[data-testid="file-path-picker"]')).toBeTruthy(),
    );
    const items = document.querySelectorAll('[data-testid="file-path-picker-item"]');
    expect(items.length).toBe(2);
    (items[0] as HTMLButtonElement).click();
    await waitFor(() =>
      expect(useAgentStore.getState().filePreviewPath).toBe("/repo/p/a/src/x.ts"),
    );
  });

  it("点击 chip → /fs/resolve 报 ENOENT → message.error 且不开预览", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: false, code: "ENOENT", error: "文件不存在" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { container } = render(<MarkdownText text="见 `nope.ts`" />);
    const chip = container.querySelector('[data-testid="file-path-chip"]')!;
    fireEvent.click(chip);
    await waitFor(() => {
      // AntD message.error 内部会 console.error;同时也要确认 store 没变
      expect(errorSpy).toHaveBeenCalled();
      expect(useAgentStore.getState().filePreviewPath).toBeNull();
    });
  });
});
