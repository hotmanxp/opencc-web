# zai Files 大文件预览虚拟化 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 zai Files 视图预览 2 MB 上限内的大文件(2 万 ~ 5 万行)首屏 < 100ms、滚动 60fps,渲染 DOM 节点数从 O(N) 降到 O(viewport)。

**Architecture:** 在 `FsTab` 内部按行数分支:< 2000 行走现路径(memo-wrapped `FilePreview`,即阶段 0);≥ 2000 行走新增的 `VirtualizedTextView`(纯文本)/ `VirtualizedCodeView`(代码,用 `@lezer/highlight` 复用 `TextEditor` 现有语言包)。两个虚拟视图都基于 `react-window` `FixedSizeList` + 行高 18px,只渲染可视窗口 + 上下 overscan 5 行,保留原生滚动条 + `pendingLine` scrollIntoView。

**Tech Stack:** `react-window@^1.8.10` · `@lezer/highlight@^1.2.0` · 已装的 `@codemirror/lang-*` · React 18 + antd · happy-dom vitest · React Testing Library。

---

## Global Constraints

> 所有任务必须遵守。Quoted values copied verbatim from spec / 已确认的 design 决策。

- **工作目录**:`packages/zai/`(所有 `pnpm` 命令在 zai workspace 内运行)
- **Node 引擎**:`>=20`(`packages/zai/package.json` `engines.node`)
- **服务端不变**: `MAX_FILE_BYTES = 2 * 1024 * 1024`(`packages/zai/src/server/utils/fsWrite.ts:2`)保留;不新增 endpoint,不修改 `fs.ts`。
- **行数门概(branch threshold)**: `lines.length >= LARGE_FILE_LINE_THRESHOLD` 才虚拟化。常量 verbatim: `LARGE_FILE_LINE_THRESHOLD = 2000`。
- **行高(verbatim)**: `LINE_HEIGHT = 18`(px,固定行高,匹配 `fontSize:12 × lineHeight:1.55 ≈ 18.6`)→ 向下取 18,虚拟化引擎用整数。
- **行号 gutter 宽度(verbatim)**: `GUTTER_WIDTH = 44`(px,沿用 `FsTab.tsx:403` padding-left 44px 的视觉契约)
- **overscan(verbatim)**: `<FixedSizeList overscanCount={5} />`,给上下各 5 行缓冲,避免快速滚动露白。
- **依赖新增**:只允许 `react-window` + `@lezer/highlight`,**不**新增语言包 — 复用 `packages/zai/package.json` 已装的 `@codemirror/lang-javascript` / `-json` / `-python` / `-rust` / `-go` / `-sql`。
- **commit 粒度**:每 task 一个 commit,message 用 `feat:` / `test:` / `chore:` 前缀。
- **测试基线**: 阶段 0 已为 `FsTab` 加 memo。各 task 自带单元测试 + `FsTab.test.tsx` 集成断言。`@vitest-environment happy-dom` 沿用。`vi.mock('../markdown/syntaxHighlighter.js', …)` 沿用 FsTab.test.tsx 现有 stub。
- **不重构**: `FsTab.tsx` 中除"渲染点切换" 以外的逻辑不动;`useFsFile` / `useFsList` / `useFsSearch` / `useFsContentSearch` 不动;`MarkdownText` 不动(大 MD 暂时保留原路径,已知限制写到 task 6 注释里);`HtmlPreview` 不动。
- **回滚点**: `LARGE_FILE_LINE_THRESHOLD` 调到 `Infinity` 即恢复原路径,无需改 `FilePreview` 本身。
- **DOM 已知限制**: `react-window` 在 happy-dom 里不真实计算滚动高度 — 测试断言以"渲染行数 ≤ 视口 + overscan"为准,不依赖 `scrollHeight` 数值。

---
