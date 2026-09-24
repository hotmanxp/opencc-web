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

describe("MarkdownText fenced blocks keep whitespace", () => {
  // 回归(2026-09-24):无语言标注的围栏块 ``` 必须走块级 <pre>。此前
  // CodeBlock 靠 `language-` class 判分支,无标注块落进行内 code 分支,
  // 行内 <code> 折叠空白 —— README 里那段靠多空格 + 盒线字符对齐的
  // ASCII 数据流图(zai 预览 = MarkdownText)被压成一行紫色文字。
  // 行内 code 与无 lang 围栏 code 的 props 完全相同,只有 InFencedCode
  // context 能区分。
  const DIAGRAM = [
    "输入框 ──POST /agent/prompt──▶ Express 路由",
    "                                │",
    "                                ▼  (async)",
    "                  DefaultAgentRuntime.run({ ... })",
    "                  ┌──────────────────────────┐",
    "                  │ modelStream              │",
    "                  └──────────────────────────┘",
  ].join("\n");

  it("无语言标注的围栏块用 <pre> 原样保留每一行", () => {
    const { container } = render(<MarkdownText text={"```\n" + DIAGRAM + "\n```"} />);
    const pre = container.querySelector("pre");
    expect(pre).toBeTruthy();
    expect(pre?.textContent).toBe(DIAGRAM);
    // 不能落进行内 code 分支 —— 那个分支渲染的 <code> 带紫色 inline 样式
    // 且处于 <p> 内,空白折叠的根源
    expect(container.querySelector("p code")).toBeNull();
    expect(container.querySelector("code")?.className).not.toContain("#a78bfa");
  });

  it("有语言标注的围栏块也走块级 <pre>,不落进 <p>", () => {
    const { container } = render(<MarkdownText text={"```ts\nconst a = 1\n```"} />);
    expect(container.querySelector("pre")).toBeTruthy();
    expect(container.querySelector("p")).toBeNull();
  });

  it("行内 code 仍走行内分支(不套 <pre>)", () => {
    const { container } = render(<MarkdownText text="见 `const a = 1` 这行" />);
    expect(container.querySelector("pre")).toBeNull();
    const code = container.querySelector("p code");
    expect(code).toBeTruthy();
    expect(code?.textContent).toBe("const a = 1");
  });
});

describe("MarkdownText 代码块复制", () => {
  // happy-dom 把 navigator.clipboard 设为 getter-only,用 defineProperty 替换
  function stubClipboard(writeText: ReturnType<typeof vi.fn>) {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("围栏块右上角常驻复制按钮,点击写入原始源码", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const { container } = render(<MarkdownText text={"```\nconst x = 1;\n```"} />);

    const btn = container.querySelector(
      '[data-testid="code-block-copy"]',
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.getAttribute("aria-label")).toBe("复制代码");

    fireEvent.click(btn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("const x = 1;"));
  });

  it("复制成功 → 绿勾 + 「已复制」胶囊,1.5s 后收回", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const { container } = render(<MarkdownText text={"```\nfoo()\n```"} />);
    expect(container.querySelector('[data-testid="code-block-copied"]')).toBeNull();

    fireEvent.click(container.querySelector('[data-testid="code-block-copy"]')!);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="code-block-copied"]')).toBeTruthy(),
    );
    // 按钮同时切绿勾(aria-label 跟着变)
    expect(
      container.querySelector('[data-testid="code-block-copy"]')?.getAttribute("aria-label"),
    ).toBe("已复制");

    // 提示 1.5s 后自动收回。这里不掺假定时器 —— 定时器是在 setCopied(true)
    // 那一帧用真实 timer 排的,再切 useFakeTimers 也管不到它。
    await waitFor(
      () => expect(container.querySelector('[data-testid="code-block-copied"]')).toBeNull(),
      { timeout: 2500 },
    );
  });

  it("复制失败 → message.warning,不显示「已复制」", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    stubClipboard(writeText);
    // 剪贴板 API 被拒后 copyToClipboard 会退到 execCommand 兜底,这里显式
    // 让它也失败,确保走的是失败分支(不依赖 happy-dom 有没有实现它)
    const doc = document as unknown as { execCommand?: unknown };
    const original = doc.execCommand;
    Object.defineProperty(document, "execCommand", {
      value: () => false,
      configurable: true,
      writable: true,
    });
    try {
      const { container } = render(<MarkdownText text={"```\nfoo()\n```"} />);
      fireEvent.click(container.querySelector('[data-testid="code-block-copy"]')!);
      await waitFor(() =>
        expect(document.querySelector(".ant-message-warning")).toBeTruthy(),
      );
      expect(container.querySelector('[data-testid="code-block-copied"]')).toBeNull();
    } finally {
      Object.defineProperty(document, "execCommand", {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });

  it("有语言标注的高亮块同样带复制按钮", async () => {
    const { container } = render(<MarkdownText text={"```ts\nconst a = 1\n```"} />);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="code-block-copy"]')).toBeTruthy(),
    );
    expect(container.querySelector('[data-testid="code-block"]')).toBeTruthy();
  });

  it("行内 code 不出现复制按钮", () => {
    const { container } = render(<MarkdownText text="用 `useMemo` 包一下" />);
    expect(container.querySelector('[data-testid="code-block-copy"]')).toBeNull();
  });

  it("mermaid 块走自己的工具栏,不叠加代码块复制按钮", () => {
    const { container } = render(<MarkdownText text={"```mermaid\nflowchart TD\nA-->B\n```"} />);
    // mermaid 有独立的「⋯ → 复制源码」菜单,这里不该再出现代码块复制按钮
    expect(container.querySelector('[data-testid="code-block-copy"]')).toBeNull();
    expect(container.querySelector('[data-testid="code-block"]')).toBeNull();
    // 确认确实路由进了 MermaidBlock(loading 占位或渲染完成的卡片)
    expect(container.querySelector('[data-testid^="mermaid-block"]')).toBeTruthy();
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

  it("wraps a block $$...$$ formula in the MathBlock container with header + body", () => {
    // 块级公式应被 rehypeKatexContainer 包成 <math-block> → MathBlock,
    // 渲染出 data-testid="math-block" 的卡片与头部条。
    // 注意:`$$` 必须独占行 remark-math 才认作 block math —— 这里用多行
    // 模板保留真换行,不是 String.raw 的字面 \n。
    const { container } = render(
      <MarkdownText
        text={`$$
x = 1
$$`}
      />,
    );
    expect(container.querySelector('[data-testid="math-block"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="math-block-header"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="math-block-body"]')).toBeTruthy();
    // KaTeX 节点应在 body 内
    expect(
      container.querySelector('[data-testid="math-block-body"] .katex'),
    ).toBeTruthy();
  });

  it("does NOT wrap an inline $...$ formula in the MathBlock container", () => {
    // 行内公式嵌在正文流,不应该出现 math-block 容器
    const { container } = render(
      <MarkdownText text={String.raw`质能方程 $E = mc^2$ 成立`} />,
    );
    expect(container.querySelector('[data-testid="math-block"]')).toBeNull();
    expect(container.querySelector(".katex")).toBeTruthy();
    expect(container.querySelector(".katex-display")).toBeNull();
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
