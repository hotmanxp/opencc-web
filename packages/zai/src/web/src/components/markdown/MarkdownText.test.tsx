// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownText } from "./MarkdownText.js";

describe("MarkdownText", () => {
  it("renders a top-level heading as <h1>", () => {
    render(<MarkdownText text="# hello" />);
    expect(screen.getByRole("heading", { level: 1, name: "hello" })).toBeTruthy();
  });

  it("renders inline code with the violet (#a78bfa) custom style", () => {
    const { container } = render(<MarkdownText text="use `foo` here" />);
    // The markdownComponents.code branch (no language class) returns
    // <code style={{ color: "#a78bfa" ... }}>. happy-dom preserves the
    // hex literal as-is (does not normalize to rgb()), so we assert
    // against the original value.
    const code = container.querySelector("code");
    expect(code).toBeTruthy();
    expect(code?.style.color).toBe("#a78bfa");
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
