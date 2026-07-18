# Tool Renderer Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor zai-web `ToolCallBlock` from inline if/else chains into a registry-based per-tool renderer abstraction covering Bash / Read / Edit / Write / Glob / Grep / Agent with a generic fallback, preserving existing behaviour and adding tool-specific previews / parameter layouts / output parsing.

**Architecture:** New `packages/zai/src/web/src/components/toolRenderers/` directory with one file per tool exporting a `ToolRenderer` (preview / displayName / renderInput / renderOutput hooks). A small registry maps tool name → renderer; unknown tools fall through to a `genericRenderer`. `ToolCallBlock` becomes a thin shell that dispatches to the renderer and only owns collapse / status / shell concerns. The Bash renderer uses a dedicated `parseBashOutput` utility to split `<stdout>/<stderr>` tags for separate rendering.

**Tech Stack:** TypeScript, React 18, Ant Design (`Collapse`/`Tag`/`Typography`/`Card`), vitest + happy-dom, pnpm monorepo (run from repo root: `pnpm --filter @zn-ai/zai test`, `pnpm --filter @zn-ai/zai typecheck`).

**Spec:** `docs/superpowers/specs/2026-07-18-zai-tool-renderer-refactor-design.md`

## Global Constraints

- Per `AGENTS.md` style: `const` over `let`, early return over `else`, no `as any` / `@ts-ignore` / empty catch / catch-all files
- Per `zai` package AGENTS.md (if any) follow package conventions; this dir has none newer than root
- Renderer files are sibling modules — they import `Pre` style shared tokens (`CODE_FONT_FAMILY`, colour fades) from a new shared `toolRenderers/styles.ts`
- Renderer functions are pure: `preview` returns a string; `renderInput` / `renderOutput` return `ReactNode`; no hooks, no context, no side effects
- All renderer tests live in `packages/zai/test/web/toolRenderers/`
- All commands assume CWD `/Users/ethan/code/opencc-web`
- Use `pnpm --filter @zn-ai/zai <cmd>` for package-scoped commands (the package name is `@zn-ai/zai` per `pnpm-workspace.yaml`)
- Every task ends with a commit; conventional commits (`feat:` / `refactor:` / `test:` / `docs:`)

---

## File Structure

**New files:**
- `packages/zai/src/web/src/components/toolRenderers/styles.ts` — shared style tokens (`successBg`, `errorBg`, `mutedBg`, `errorBorder`, `CODE_FONT_FAMILY`) lifted from `Agent.tsx`
- `packages/zai/src/web/src/components/toolRenderers/types.ts` — `ToolRenderer` interface
- `packages/zai/src/web/src/components/toolRenderers/registry.ts` — `getRenderer(name)` + map; the registry is built in this file by importing each renderer
- `packages/zai/src/web/src/components/toolRenderers/shared.tsx` — shared JSX helpers: `FieldLabel`, `PreBlock`, `DetailsSection`, `pick()`, `stringFromOutput()`, `truncate()`
- `packages/zai/src/web/src/components/toolRenderers/bashParser.ts` — pure function `parseBashOutput(s)`
- `packages/zai/src/web/src/components/toolRenderers/bash.tsx`
- `packages/zai/src/web/src/components/toolRenderers/read.tsx`
- `packages/zai/src/web/src/components/toolRenderers/edit.tsx`
- `packages/zai/src/web/src/components/toolRenderers/write.tsx`
- `packages/zai/src/web/src/components/toolRenderers/glob.tsx`
- `packages/zai/src/web/src/components/toolRenderers/grep.tsx`
- `packages/zai/src/web/src/components/toolRenderers/agent.tsx`
- `packages/zai/src/web/src/components/toolRenderers/generic.tsx`
- Tests in `packages/zai/test/web/toolRenderers/` mirroring each renderer + the parser

**Modified files:**
- `packages/zai/src/web/src/pages/Agent.tsx` — `ToolCallBlock` becomes a thin shell that calls `getRenderer(name)` and delegates rendering

---

## Task 1: Scaffolding — shared styles, types, helpers, generic

**Files:**
- Create: `packages/zai/src/web/src/components/toolRenderers/styles.ts`
- Create: `packages/zai/src/web/src/components/toolRenderers/types.ts`
- Create: `packages/zai/src/web/src/components/toolRenderers/shared.tsx`
- Create: `packages/zai/src/web/src/components/toolRenderers/generic.tsx`
- Create: `packages/zai/src/web/src/components/toolRenderers/registry.ts`
- Test: `packages/zai/test/web/toolRenderers/shared.test.ts`
- Test: `packages/zai/test/web/toolRenderers/generic.test.ts`

**Interfaces:**
- Produces: `ToolRenderer` type (consumed by every later task), `getRenderer(name)` (consumed by Task 11), `pick(input, keys)` / `stringFromOutput(out)` / `truncate(s, n)` (consumed by all renderer tasks)

- [ ] **Step 1: Write the failing test for shared helpers**

Create `packages/zai/test/web/toolRenderers/shared.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { pick, stringFromOutput, truncate } from '../../../src/web/src/components/toolRenderers/shared.js'

describe('pick', () => {
  it('keeps only listed keys, leaves input untouched', () => {
    const input = { a: 1, b: 2, c: 3 }
    const out = pick(input, ['a', 'c'])
    expect(out).toEqual({ a: 1, c: 3 })
    expect(input).toEqual({ a: 1, b: 2, c: 3 }) // not mutated
  })
  it('skips absent keys', () => {
    expect(pick({ a: 1 }, ['a', 'missing'])).toEqual({ a: 1 })
  })
})

describe('stringFromOutput', () => {
  it('stringifies string as-is', () => {
    expect(stringFromOutput('plain')).toBe('plain')
  })
  it('JSON-stringifies non-string', () => {
    expect(stringFromOutput({ ok: true })).toBe('{\n  "ok": true\n}')
  })
  it('handles null/undefined safely', () => {
    expect(stringFromOutput(null)).toBe('null')
    expect(stringFromOutput(undefined)).toBe('')
  })
})

describe('truncate', () => {
  it('passes through short strings', () => {
    expect(truncate('hi', 80)).toBe('hi')
  })
  it('truncates with ellipsis when over length', () => {
    expect(truncate('a'.repeat(120), 80)).toBe('a'.repeat(80) + '…')
  })
  it('respects exact-length boundary', () => {
    expect(truncate('a'.repeat(80), 80)).toBe('a'.repeat(80))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/test/web/toolRenderers/shared.test.ts`
Expected: FAIL — `Cannot find module '../../../src/web/src/components/toolRenderers/shared.js'`

- [ ] **Step 3: Implement shared.tsx + styles.ts**

Create `packages/zai/src/web/src/components/toolRenderers/styles.ts`:

```ts
export const CODE_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"

export const STYLE = {
  preBase: {
    fontSize: 12,
    margin: "4px 0 0 0",
    padding: "8px 10px",
    borderRadius: 4,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
    fontFamily: CODE_FONT_FAMILY,
  },
  preMuted: { background: "rgba(0,0,0,0.03)" },
  preSuccess: {
    background: "rgba(82,196,26,0.06)",
    borderLeft: "2px solid #52c41a",
    maxHeight: 360,
    overflow: "auto" as const,
  },
  preError: {
    background: "rgba(255,77,79,0.06)",
    borderLeft: "2px solid #ff4d4f",
    color: "#cf1322",
    maxHeight: 360,
    overflow: "auto" as const,
  },
  preWarn: {
    background: "rgba(250,173,20,0.06)",
    borderLeft: "2px solid #faad14",
    maxHeight: 360,
    overflow: "auto" as const,
  },
  label: {
    fontSize: 11,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    marginTop: 8,
    display: "block" as const,
  },
} as const
```

Create `packages/zai/src/web/src/components/toolRenderers/shared.tsx`:

```tsx
import React from "react"
import { Typography } from "antd"
import { STYLE } from "./styles.js"

const { Text } = Typography

export function pick(
  input: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    if (input[k] !== undefined) out[k] = input[k]
  }
  return out
}

export function stringFromOutput(out: unknown): string {
  if (out === undefined) return ""
  if (out === null) return "null"
  if (typeof out === "string") return out
  return JSON.stringify(out, null, 2)
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text type="secondary" style={STYLE.label}>
      {children}
    </Text>
  )
}

export function PreBlock({
  children,
  variant = "muted",
}: {
  children: React.ReactNode
  variant?: "muted" | "success" | "error" | "warn"
}) {
  const variantStyle =
    variant === "success"
      ? STYLE.preSuccess
      : variant === "error"
        ? STYLE.preError
        : variant === "warn"
          ? STYLE.preWarn
          : STYLE.preMuted
  return <pre style={{ ...STYLE.preBase, ...variantStyle }}>{children}</pre>
}

export function DetailsSection({
  summary,
  children,
}: {
  summary: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <details style={{ marginTop: 6 }}>
      <summary
        style={{
          fontSize: 11,
          color: "rgba(0,0,0,0.55)",
          cursor: "pointer",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {summary}
      </summary>
      <PreBlock>{children}</PreBlock>
    </details>
  )
}
```

Note `linkifyText` integration stays in the renderer; it is imported from `../../lib/linkify.js`. Import statement added in each renderer task.

- [ ] **Step 4: Run test to verify shared helpers pass**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/test/web/toolRenderers/shared.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing test for generic renderer**

Create `packages/zai/test/web/toolRenderers/generic.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { genericRenderer } from '../../../src/web/src/components/toolRenderers/generic.js'
import React from 'react'

describe('genericRenderer', () => {
  it('preview returns first field value as string', () => {
    expect(genericRenderer.preview({ command: 'ls' })).toBe('ls')
  })
  it('preview stringifies non-string first value', () => {
    expect(genericRenderer.preview({ a: { b: 1 } })).toBe('{"b":1}')
  })
  it('preview is empty when no input keys', () => {
    expect(genericRenderer.preview({})).toBe('')
  })
  it('preview returns first key even when value is null', () => {
    expect(genericRenderer.preview({ a: null })).toBe('')
  })
  it('preview truncates long values at 80', () => {
    expect(genericRenderer.preview({ a: 'x'.repeat(120) })).toBe('x'.repeat(80) + '…')
  })
  it('displayName / renderInput / renderOutput are undefined (caller falls back)', () => {
    expect(genericRenderer.displayName).toBeUndefined()
    expect(genericRenderer.renderInput).toBeUndefined()
    expect(genericRenderer.renderOutput).toBeUndefined()
  })
  // quick smoke that there is a React Node shape if we ever hook one up
  it('returns an object, not a primitive', () => {
    expect(typeof genericRenderer).toBe('object')
    expect(React).toBeDefined()
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/test/web/toolRenderers/generic.test.ts`
Expected: FAIL — `Cannot find module '../../../src/web/src/components/toolRenderers/generic.js'`

- [ ] **Step 7: Implement types.ts + generic.tsx + registry.ts**

Create `packages/zai/src/web/src/components/toolRenderers/types.ts`:

```ts
import type { ReactNode } from "react"

export type ToolRenderer = {
  preview(input: Record<string, unknown>): string
  displayName?(input: Record<string, unknown>): string
  renderInput?(input: Record<string, unknown>): ReactNode
  renderOutput?(output: unknown, isError: boolean): ReactNode
}
```

Create `packages/zai/src/web/src/components/toolRenderers/generic.tsx`:

```ts
import type { ToolRenderer } from "./types.js"
import { truncate } from "./shared.js"

export const genericRenderer: ToolRenderer = {
  preview(input) {
    const firstKey = Object.keys(input)[0]
    if (!firstKey) return ""
    const v = input[firstKey]
    if (v == null) return ""
    const text = typeof v === "string" ? v : JSON.stringify(v)
    return truncate(text, 80)
  },
}
```

Create `packages/zai/src/web/src/components/toolRenderers/registry.ts`:

```ts
import type { ToolRenderer } from "./types.js"
import { genericRenderer } from "./generic.js"

const registry: Record<string, ToolRenderer> = {
  // Per-tool renderers are registered in their own tasks (Tasks 4–10).
  // This stub intentionally contains only the fallback so the wiring works
  // end-to-end from Task 1; later tasks call setRenderer() to plug in.
}

export function setRenderer(name: string, renderer: ToolRenderer): void {
  registry[name] = renderer
}

export function getRenderer(name: string): ToolRenderer {
  return registry[name] ?? genericRenderer
}

export function _renderersForTest(): Readonly<Record<string, ToolRenderer>> {
  return registry
}
```

- [ ] **Step 8: Run test to verify generic passes**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/test/web/toolRenderers/generic.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add packages/zai/src/web/src/components/toolRenderers/ \
        packages/zai/test/web/toolRenderers/
git commit -m "feat(zai-web): tool renderer scaffolding (types/registry/shared/generic)"
```

---

## Task 2: Bash output parser

**Files:**
- Create: `packages/zai/src/web/src/components/toolRenderers/bashParser.ts`
- Test: `packages/zai/test/web/toolRenderers/bashParser.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `parseBashOutput(s)` used by Task 3 Bash renderer's `renderOutput`

- [ ] **Step 1: Write failing test**

Create `packages/zai/test/web/toolRenderers/bashParser.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseBashOutput } from '../../../src/web/src/components/toolRenderers/bashParser.js'

describe('parseBashOutput', () => {
  it('empty input yields empty segments', () => {
    expect(parseBashOutput('')).toEqual({ stdout: '', stderr: '', plain: '' })
  })
  it('extracts single stdout block', () => {
    expect(parseBashOutput('<stdout>hello</stdout>')).toEqual({
      stdout: 'hello',
      stderr: '',
      plain: '',
    })
  })
  it('extracts stdout and stderr together', () => {
    const out = parseBashOutput('<stdout>out</stdout><stderr>err</stderr>')
    expect(out.stdout).toBe('out')
    expect(out.stderr).toBe('err')
    expect(out.plain).toBe('')
  })
  it('preserves order: stdout first, then stderr', () => {
    const out = parseBashOutput('<stderr>err</stderr><stdout>out</stdout>')
    expect(out.stdout).toBe('out')
    expect(out.stderr).toBe('err')
  })
  it('puts unknown tags into plain', () => {
    const out = parseBashOutput(
      '<task_id>123</task_id>\n<status>running</status>',
    )
    expect(out.stdout).toBe('')
    expect(out.stderr).toBe('')
    expect(out.plain).toBe('<task_id>123</task_id>\n<status>running</status>')
  })
  it('keeps raw text without any tags', () => {
    const out = parseBashOutput('just text\nmore')
    expect(out.plain).toBe('just text\nmore')
  })
  it('trims whitespace around stdout/stderr bodies', () => {
    expect(parseBashOutput('<stdout>\n  hi  \n</stdout>')).toEqual({
      stdout: 'hi',
      stderr: '',
      plain: '',
    })
  })
  it('handles multiline stdout ([\s\S] non-greedy across newlines)', () => {
    expect(
      parseBashOutput('<stdout>line1\nline2</stdout>'),
    ).toEqual({ stdout: 'line1\nline2', stderr: '', plain: '' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/test/web/toolRenderers/bashParser.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement parser**

Create `packages/zai/src/web/src/components/toolRenderers/bashParser.ts`:

```ts
export type BashOutputParts = {
  stdout: string
  stderr: string
  plain: string
}

const STDOUT_RE = /<stdout>([\s\S]*?)<\/stdout>/g
const STDERR_RE = /<stderr>([\s\S]*?)<\/stderr>/g

export function parseBashOutput(s: string): BashOutputParts {
  const stdoutMatches: string[] = []
  const stderrMatches: string[] = []
  for (const m of s.matchAll(STDOUT_RE)) stdoutMatches.push((m[1] ?? '').trim())
  for (const m of s.matchAll(STDERR_RE)) stderrMatches.push((m[1] ?? '').trim())

  const stripped = s
    .replace(STDOUT_RE, '')
    .replace(STDERR_RE, '')
    .trim()

  return {
    stdout: stdoutMatches.join('\n'),
    stderr: stderrMatches.join('\n'),
    plain: stripped,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/test/web/toolRenderers/bashParser.test.ts`
Expected: 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/components/toolRenderers/bashParser.ts \
        packages/zai/test/web/toolRenderers/bashParser.test.ts
git commit -m "feat(zai-web): Bash output parser (stdout/stderr/plain)"
```

---

## Task 3: Bash renderer

**Files:**
- Create: `packages/zai/src/web/src/components/toolRenderers/bash.tsx`
- Test: `packages/zai/test/web/toolRenderers/bash.test.ts`
- Modify: `packages/zai/src/web/src/components/toolRenderers/registry.ts` (register Bash)

**Interfaces:**
- Consumes: `parseBashOutput` (Task 2), shared helpers (Task 1)
- Produces: `bashRenderer: ToolRenderer` registered as `Bash`

- [ ] **Step 1: Write failing test**

Create `packages/zai/test/web/toolRenderers/bash.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { bashRenderer } from '../../../src/web/src/components/toolRenderers/bash.js'
import React from 'react'

describe('bashRenderer', () => {
  it('preview prefers description over command', () => {
    expect(
      bashRenderer.preview({
        command: 'git status',
        description: '检查当前 git 状态',
      }),
    ).toBe('检查当前 git 状态')
  })
  it('preview falls back to command when no description', () => {
    expect(bashRenderer.preview({ command: 'pwd' })).toBe('pwd')
  })
  it('preview is empty when neither field is a non-empty string', () => {
    expect(bashRenderer.preview({ command: '', description: '' })).toBe('')
    expect(bashRenderer.preview({})).toBe('')
  })
  it('preview truncates long values at 80', () => {
    const long = 'a'.repeat(120)
    expect(
      bashRenderer.preview({ command: long }),
    ).toBe('a'.repeat(80) + '…')
  })
  it('renderInput is a ReactNode element (non-null)', () => {
    const node = bashRenderer.renderInput?.({
      command: 'ls',
      description: 'list',
      timeout: 30000,
    })
    expect(React.isValidElement(node)).toBe(true)
  })
  it('renderOutput returns null/undefined when output is undefined', () => {
    // Returning null is allowed; caller treats null as "nothing"
    const node = bashRenderer.renderOutput?.(undefined, false)
    expect(node == null || React.isValidElement(node)).toBe(true)
  })
  it('renderOutput returns a ReactNode for parsed output', () => {
    const node = bashRenderer.renderOutput?.(
      '<stdout>hello</stdout><stderr>oops</stderr>',
      false,
    )
    expect(React.isValidElement(node)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/test/web/toolRenderers/bash.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement bash.tsx**

Create `packages/zai/src/web/src/components/toolRenderers/bash.tsx`:

```tsx
import React from "react"
import type { ToolRenderer } from "./types.js"
import { FieldLabel, PreBlock, DetailsSection, pick, stringFromOutput, truncate } from "./shared.js"
import { linkifyText } from "../../lib/linkify.js"
import { parseBashOutput } from "./bashParser.js"

export const bashRenderer: ToolRenderer = {
  preview(input) {
    const desc = input.description
    if (typeof desc === "string" && desc.trim()) return truncate(desc.trim(), 80)
    const cmd = input.command
    if (typeof cmd === "string" && cmd.trim()) return truncate(cmd.trim(), 80)
    return ""
  },

  renderInput(input) {
    const command = typeof input.command === "string" ? input.command : ""
    const secondary = pick(input, ["description", "timeout", "run_in_background"])
    return (
      <div>
        <FieldLabel>命令</FieldLabel>
        <PreBlock>{linkifyText(command)}</PreBlock>
        {Object.keys(secondary).length > 0 && (
          <DetailsSection summary="更多参数">
            {linkifyText(JSON.stringify(secondary, null, 2))}
          </DetailsSection>
        )}
      </div>
    )
  },

  renderOutput(output) {
    if (output === undefined || output === null) return null
    const { stdout, stderr, plain } = parseBashOutput(stringFromOutput(output))
    return (
      <>
        {stdout && (
          <PreBlock variant="success">{linkifyText(stdout)}</PreBlock>
        )}
        {stderr && <PreBlock variant="warn">{linkifyText(stderr)}</PreBlock>}
        {plain && <PreBlock>{linkifyText(plain)}</PreBlock>}
      </>
    )
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/test/web/toolRenderers/bash.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Register Bash in registry**

In `packages/zai/src/web/src/components/toolRenderers/registry.ts`, replace the empty `registry` declaration with:

```ts
import type { ToolRenderer } from "./types.js"
import { bashRenderer } from "./bash.js"
import { genericRenderer } from "./generic.js"

const registry: Record<string, ToolRenderer> = {
  Bash: bashRenderer,
}

export function setRenderer(name: string, renderer: ToolRenderer): void {
  registry[name] = renderer
}

export function getRenderer(name: string): ToolRenderer {
  return registry[name] ?? genericRenderer
}

export function _renderersForTest(): Readonly<Record<string, ToolRenderer>> {
  return registry
}
```

- [ ] **Step 6: Run all renderer tests to confirm wiring**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/test/web/toolRenderers/`
Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add packages/zai/src/web/src/components/toolRenderers/bash.tsx \
        packages/zai/src/web/src/components/toolRenderers/registry.ts \
        packages/zai/test/web/toolRenderers/bash.test.ts
git commit -m "feat(zai-web): Bash tool renderer (preview + colour-split output)"
```

---

## Task 4: Read renderer

**Files:**
- Create: `packages/zai/src/web/src/components/toolRenderers/read.tsx`
- Test: `packages/zai/test/web/toolRenderers/read.test.ts`
- Modify: `packages/zai/src/web/src/components/toolRenderers/registry.ts` (register Read)

**Interfaces:**
- Consumes: shared helpers (Task 1)
- Produces: `readRenderer: ToolRenderer` registered as `Read`

- [ ] **Step 1: Write failing test**

Create `packages/zai/test/web/toolRenderers/read.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { readRenderer } from '../../../src/web/src/components/toolRenderers/read.js'
import React from 'react'

describe('readRenderer', () => {
  it('preview shows the file path', () => {
    expect(readRenderer.preview({ file_path: '/tmp/x.ts' })).toBe('/tmp/x.ts')
  })
  it('preview appends L{start}-{end} when offset and limit are numeric', () => {
    expect(
      readRenderer.preview({ file_path: '/a.ts', offset: 10, limit: 20 }),
    ).toBe('/a.ts L10-29')
  })
  it('preview treats offset=0 as present (not "no offset")', () => {
    expect(
      readRenderer.preview({ file_path: '/a.ts', offset: 0, limit: 50 }),
    ).toBe('/a.ts L0-49')
  })
  it('preview omits line range when only one of offset/limit given', () => {
    expect(readRenderer.preview({ file_path: '/a.ts', offset: 5 })).toBe('/a.ts')
    expect(readRenderer.preview({ file_path: '/a.ts', limit: 30 })).toBe('/a.ts')
  })
  it('preview coerces string-numeric offset/limit', () => {
    expect(
      readRenderer.preview({
        file_path: '/a',
        offset: '10',
        limit: '5',
      }),
    ).toBe('/a L10-14')
  })
  it('preview is empty when no file_path', () => {
    expect(readRenderer.preview({})).toBe('')
  })
  it('renderInput / renderOutput return React elements', () => {
    expect(React.isValidElement(readRenderer.renderInput?.({ file_path: '/x' })!)).toBe(true)
    expect(React.isValidElement(readRenderer.renderOutput?.('Read N lines', false)!)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/test/web/toolRenderers/read.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement read.tsx**

Create `packages/zai/src/web/src/components/toolRenderers/read.tsx`:

```tsx
import React from "react"
import type { ToolRenderer } from "./types.js"
import { FieldLabel, PreBlock, stringFromOutput, truncate } from "./shared.js"
import { linkifyText } from "../../lib/linkify.js"

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export const readRenderer: ToolRenderer = {
  preview(input) {
    const p = input.file_path
    if (typeof p !== "string") return ""
    const offset = toNum(input.offset)
    const limit = toNum(input.limit)
    const range = offset != null && limit != null ? ` L${offset}-${offset + limit - 1}` : ""
    return truncate(`${p}${range}`, 80)
  },

  renderInput(input) {
    const offset = toNum(input.offset)
    const limit = toNum(input.limit)
    return (
      <div>
        <FieldLabel>文件</FieldLabel>
        <PreBlock>{linkifyText(typeof input.file_path === "string" ? input.file_path : "")}</PreBlock>
        {(offset != null || limit != null) && (
          <PreBlock>
            {`offset=${offset ?? 0}${limit != null ? `, limit=${limit}` : ""}`}
          </PreBlock>
        )}
      </div>
    )
  },

  renderOutput(output) {
    const text = stringFromOutput(output)
    if (!text) return null
    return <PreBlock variant="success">{linkifyText(text)}</PreBlock>
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/test/web/toolRenderers/read.test.ts`
Expected: PASS

- [ ] **Step 5: Register Read**

In `registry.ts` add `Read: readRenderer` to the registry object and add the import:

```ts
import { readRenderer } from "./read.js"
```

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/web/src/components/toolRenderers/read.tsx \
        packages/zai/src/web/src/components/toolRenderers/registry.ts \
        packages/zai/test/web/toolRenderers/read.test.ts
git commit -m "feat(zai-web): Read tool renderer"
```

---

## Task 5: Edit renderer

**Files:**
- Create: `packages/zai/src/web/src/components/toolRenderers/edit.tsx`
- Test: `packages/zai/test/web/toolRenderers/edit.test.ts`
- Modify: `packages/zai/src/web/src/components/toolRenderers/registry.ts`

**Interfaces:**
- Produces: `editRenderer: ToolRenderer` registered as `Edit`

- [ ] **Step 1: Write failing test**

Create `packages/zai/test/web/toolRenderers/edit.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { editRenderer } from '../../../src/web/src/components/toolRenderers/edit.js'
import React from 'react'

describe('editRenderer', () => {
  it('preview shows file path', () => {
    expect(editRenderer.preview({ file_path: '/a.ts' })).toBe('/a.ts')
  })
  it('preview appends (all) when replace_all=true', () => {
    expect(
      editRenderer.preview({ file_path: '/a.ts', replace_all: true }),
    ).toBe('/a.ts (all)')
  })
  it('preview does NOT append (all) when replace_all=false / absent', () => {
    expect(
      editRenderer.preview({ file_path: '/a.ts', replace_all: false }),
    ).toBe('/a.ts')
    expect(editRenderer.preview({ file_path: '/a.ts' })).toBe('/a.ts')
  })
  it('preview is empty when no file_path', () => {
    expect(editRenderer.preview({ old_string: 'x', new_string: 'y' })).toBe('')
  })
  it('renderInput returns a React element showing old/new strings', () => {
    const node = editRenderer.renderInput?.({
      file_path: '/a.ts',
      old_string: 'before',
      new_string: 'after',
    })!
    expect(React.isValidElement(node)).toBe(true)
  })
  it('renderOutput is defined and returns node for plain output', () => {
    const node = editRenderer.renderOutput?.('Replaced 1 occurrence(s) in /a.ts', false)!
    expect(React.isValidElement(node)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/test/web/toolRenderers/edit.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement edit.tsx**

Create `packages/zai/src/web/src/components/toolRenderers/edit.tsx`:

```tsx
import React from "react"
import type { ToolRenderer } from "./types.js"
import { FieldLabel, PreBlock, truncate, stringFromOutput } from "./shared.js"
import { linkifyText } from "../../lib/linkify.js"

export const editRenderer: ToolRenderer = {
  preview(input) {
    const p = input.file_path
    if (typeof p !== "string") return ""
    const all = input.replace_all === true ? " (all)" : ""
    return truncate(`${p}${all}`, 80)
  },

  renderInput(input) {
    const oldStr = typeof input.old_string === "string" ? input.old_string : ""
    const newStr = typeof input.new_string === "string" ? input.new_string : ""
    return (
      <div>
        <FieldLabel>文件</FieldLabel>
        <PreBlock>
          {linkifyText(typeof input.file_path === "string" ? input.file_path : "")}
        </PreBlock>
        <FieldLabel>old_string</FieldLabel>
        <PreBlock>{linkifyText(oldStr)}</PreBlock>
        <FieldLabel>new_string</FieldLabel>
        <PreBlock>{linkifyText(newStr)}</PreBlock>
      </div>
    )
  },

  renderOutput(output) {
    const text = stringFromOutput(output)
    if (!text) return null
    return <PreBlock variant="success">{linkifyText(text)}</PreBlock>
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/test/web/toolRenderers/edit.test.ts`
Expected: PASS

- [ ] **Step 5: Register Edit**

In `registry.ts`:
- Import: `import { editRenderer } from "./edit.js"`
- Add to registry: `Edit: editRenderer,`

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/web/src/components/toolRenderers/edit.tsx \
        packages/zai/src/web/src/components/toolRenderers/registry.ts \
        packages/zai/test/web/toolRenderers/edit.test.ts
git commit -m "feat(zai-web): Edit tool renderer (no diff lines yet, structured old/new)"
```

---

## Task 6: Write renderer

**Files:**
- Create: `packages/zai/src/web/src/components/toolRenderers/write.tsx`
- Test: `packages/zai/test/web/toolRenderers/write.test.ts`
- Modify: `packages/zai/src/web/src/components/toolRenderers/registry.ts`

- [ ] **Step 1: Write failing test**

Create `packages/zai/test/web/toolRenderers/write.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { writeRenderer } from '../../../src/web/src/components/toolRenderers/write.js'
import React from 'react'

describe('writeRenderer', () => {
  it('preview shows file path', () => {
    expect(writeRenderer.preview({ file_path: '/a.ts' })).toBe('/a.ts')
  })
  it('preview appends (N lines) when content present', () => {
    expect(
      writeRenderer.preview({ file_path: '/a.ts', content: 'a\nb\nc' }),
    ).toBe('/a.ts (3 lines)')
  })
  it('preview appends (0 lines) for empty content', () => {
    expect(
      writeRenderer.preview({ file_path: '/a.ts', content: '' }),
    ).toBe('/a.ts (0 lines)')
  })
  it('preview is empty when no file_path', () => {
    expect(writeRenderer.preview({ content: 'x' })).toBe('')
  })
  it('renderInput returns React element with content pre', () => {
    const node = writeRenderer.renderInput?.({ file_path: '/a', content: 'hi' })!
    expect(React.isValidElement(node)).toBe(true)
  })
  it('renderOutput is defined', () => {
    const node = writeRenderer.renderOutput?.('Wrote 5 bytes to /a', false)!
    expect(React.isValidElement(node)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/test/web/toolRenderers/write.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement write.tsx**

Create `packages/zai/src/web/src/components/toolRenderers/write.tsx`:

```tsx
import React from "react"
import type { ToolRenderer } from "./types.js"
import { FieldLabel, PreBlock, truncate, stringFromOutput } from "./shared.js"
import { linkifyText } from "../../lib/linkify.js"

export const writeRenderer: ToolRenderer = {
  preview(input) {
    const p = input.file_path
    if (typeof p !== "string") return ""
    const c = input.content
    const lines = typeof c === "string" ? c.split("\n").length : 0
    return truncate(`${p} (${lines} lines)`, 80)
  },

  renderInput(input) {
    const filePath = typeof input.file_path === "string" ? input.file_path : ""
    const content = typeof input.content === "string" ? input.content : ""
    return (
      <div>
        <FieldLabel>文件</FieldLabel>
        <PreBlock>{linkifyText(filePath)}</PreBlock>
        <FieldLabel>完整内容</FieldLabel>
        <PreBlock>{linkifyText(content)}</PreBlock>
      </div>
    )
  },

  renderOutput(output) {
    const text = stringFromOutput(output)
    if (!text) return null
    return <PreBlock variant="success">{linkifyText(text)}</PreBlock>
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/test/web/toolRenderers/write.test.ts`
Expected: PASS

- [ ] **Step 5: Register Write**

In `registry.ts`:
- Import: `import { writeRenderer } from "./write.js"`
- Add to registry: `Write: writeRenderer,`

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/web/src/components/toolRenderers/write.tsx \
        packages/zai/src/web/src/components/toolRenderers/registry.ts \
        packages/zai/test/web/toolRenderers/write.test.ts
git commit -m "feat(zai-web): Write tool renderer"
```

---

## Task 7: Glob renderer

**Files:**
- Create: `packages/zai/src/web/src/components/toolRenderers/glob.tsx`
- Test: `packages/zai/test/web/toolRenderers/glob.test.ts`
- Modify: `packages/zai/src/web/src/components/toolRenderers/registry.ts`

- [ ] **Step 1: Write failing test**

Create `packages/zai/test/web/toolRenderers/glob.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { globRenderer } from '../../../src/web/src/components/toolRenderers/glob.js'
import React from 'react'

describe('globRenderer', () => {
  it('preview shows pattern only', () => {
    expect(globRenderer.preview({ pattern: 'src/**/*.ts' })).toBe('src/**/*.ts')
  })
  it('preview appends in <path> when path present', () => {
    expect(
      globRenderer.preview({ pattern: '**/*.json', path: '/tmp' }),
    ).toBe('**/*.json in /tmp')
  })
  it('preview is empty when no pattern', () => {
    expect(globRenderer.preview({ path: '/tmp' })).toBe('')
  })
  it('renderInput returns React element', () => {
    expect(
      React.isValidElement(globRenderer.renderInput?.({ pattern: '*.ts' })!),
    ).toBe(true)
  })
  it('renderOutput defined', () => {
    expect(
      React.isValidElement(
        globRenderer.renderOutput?.('Found 2 matches:\nfile.ts\nfile2.ts', false)!,
      ),
    ).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/test/web/toolRenderers/glob.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement glob.tsx**

Create `packages/zai/src/web/src/components/toolRenderers/glob.tsx`:

```tsx
import React from "react"
import type { ToolRenderer } from "./types.js"
import { FieldLabel, PreBlock, truncate, stringFromOutput } from "./shared.js"
import { linkifyText } from "../../lib/linkify.js"

export const globRenderer: ToolRenderer = {
  preview(input) {
    if (typeof input.pattern !== "string") return ""
    const path = typeof input.path === "string" ? ` in ${input.path}` : ""
    return truncate(`${input.pattern}${path}`, 80)
  },

  renderInput(input) {
    return (
      <div>
        <FieldLabel>pattern</FieldLabel>
        <PreBlock>{linkifyText(typeof input.pattern === "string" ? input.pattern : "")}</PreBlock>
        {typeof input.path === "string" && (
          <>
            <FieldLabel>path</FieldLabel>
            <PreBlock>{linkifyText(input.path)}</PreBlock>
          </>
        )}
      </div>
    )
  },

  renderOutput(output) {
    const text = stringFromOutput(output)
    if (!text) return null
    return <PreBlock variant="success">{linkifyText(text)}</PreBlock>
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/test/web/toolRenderers/glob.test.ts`
Expected: PASS

- [ ] **Step 5: Register Glob**

In `registry.ts`:
- Import: `import { globRenderer } from "./glob.js"`
- Add to registry: `Glob: globRenderer,`

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/web/src/components/toolRenderers/glob.tsx \
        packages/zai/src/web/src/components/toolRenderers/registry.ts \
        packages/zai/test/web/toolRenderers/glob.test.ts
git commit -m "feat(zai-web): Glob tool renderer"
```

---

## Task 8: Grep renderer

**Files:**
- Create: `packages/zai/src/web/src/components/toolRenderers/grep.tsx`
- Test: `packages/zai/test/web/toolRenderers/grep.test.ts`
- Modify: `packages/zai/src/web/src/components/toolRenderers/registry.ts`

- [ ] **Step 1: Write failing test**

Create `packages/zai/test/web/toolRenderers/grep.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { grepRenderer } from '../../../src/web/src/components/toolRenderers/grep.js'
import React from 'react'

describe('grepRenderer', () => {
  it('preview shows pattern', () => {
    expect(grepRenderer.preview({ pattern: 'TODO' })).toBe('TODO')
  })
  it('preview appends in <path> when path given', () => {
    expect(
      grepRenderer.preview({ pattern: 'TODO', path: '/src' }),
    ).toBe('TODO in /src')
  })
  it('preview is empty when no pattern', () => {
    expect(grepRenderer.preview({ path: '/src' })).toBe('')
  })
  it('renderInput returns React element with secondary params in details', () => {
    const node = grepRenderer.renderInput?.({
      pattern: 'TODO',
      path: '/src',
      output_mode: 'content',
      ignore_case: true,
    })!
    expect(React.isValidElement(node)).toBe(true)
  })
  it('renderOutput defined', () => {
    expect(
      React.isValidElement(
        grepRenderer.renderOutput?.('src/a.ts:5:hit', false)!,
      ),
    ).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/test/web/toolRenderers/grep.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement grep.tsx**

Create `packages/zai/src/web/src/components/toolRenderers/grep.tsx`:

```tsx
import React from "react"
import type { ToolRenderer } from "./types.js"
import { FieldLabel, PreBlock, DetailsSection, pick, truncate, stringFromOutput } from "./shared.js"
import { linkifyText } from "../../lib/linkify.js"

export const grepRenderer: ToolRenderer = {
  preview(input) {
    if (typeof input.pattern !== "string") return ""
    const path = typeof input.path === "string" ? ` in ${input.path}` : ""
    return truncate(`${input.pattern}${path}`, 80)
  },

  renderInput(input) {
    const secondary = pick(input, ["path", "glob", "output_mode", "context", "ignore_case"])
    return (
      <div>
        <FieldLabel>pattern</FieldLabel>
        <PreBlock>{linkifyText(typeof input.pattern === "string" ? input.pattern : "")}</PreBlock>
        {Object.keys(secondary).length > 0 && (
          <DetailsSection summary="更多参数">
            {linkifyText(JSON.stringify(secondary, null, 2))}
          </DetailsSection>
        )}
      </div>
    )
  },

  renderOutput(output) {
    const text = stringFromOutput(output)
    if (!text) return null
    return <PreBlock variant="success">{linkifyText(text)}</PreBlock>
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/test/web/toolRenderers/grep.test.ts`
Expected: PASS

- [ ] **Step 5: Register Grep**

In `registry.ts`:
- Import: `import { grepRenderer } from "./grep.js"`
- Add to registry: `Grep: grepRenderer,`

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/web/src/components/toolRenderers/grep.tsx \
        packages/zai/src/web/src/components/toolRenderers/registry.ts \
        packages/zai/test/web/toolRenderers/grep.test.ts
git commit -m "feat(zai-web): Grep tool renderer"
```

---

## Task 9: Agent renderer

**Files:**
- Create: `packages/zai/src/web/src/components/toolRenderers/agent.tsx`
- Test: `packages/zai/test/web/toolRenderers/agent.test.ts`
- Modify: `packages/zai/src/web/src/components/toolRenderers/registry.ts`

- [ ] **Step 1: Write failing test**

Create `packages/zai/test/web/toolRenderers/agent.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { agentRenderer } from '../../../src/web/src/components/toolRenderers/agent.js'
import React from 'react'

describe('agentRenderer', () => {
  it('preview prefers description over prompt', () => {
    expect(
      agentRenderer.preview({
        description: '查找所有 Bash 工具调用',
        prompt: 'find all Bash usages',
      }),
    ).toBe('查找所有 Bash 工具调用')
  })
  it('preview falls back to first line of prompt when no description', () => {
    expect(
      agentRenderer.preview({
        prompt: 'first line of task\nrest of prompt ignored',
      }),
    ).toBe('first line of task')
  })
  it('preview is empty when both empty', () => {
    expect(agentRenderer.preview({ description: '', prompt: '' })).toBe('')
  })

  it('displayName appends (agent) to subagent_type', () => {
    expect(agentRenderer.displayName?.({ subagent_type: 'Explore' })).toBe(
      'Explore (agent)',
    )
  })
  it('displayName defaults to "general-purpose (agent)" when missing', () => {
    expect(agentRenderer.displayName?.({})).toBe('general-purpose (agent)')
  })
  it('displayName handles whitespace-only as missing', () => {
    expect(agentRenderer.displayName?.({ subagent_type: '   ' })).toBe(
      'general-purpose (agent)',
    )
  })

  it('renderInput returns React element with prompt', () => {
    const node = agentRenderer.renderInput?.({
      subagent_type: 'Plan',
      prompt: 'plan the refactor',
    })!
    expect(React.isValidElement(node)).toBe(true)
  })
  it('renderOutput defined', () => {
    const node = agentRenderer.renderOutput?.(
      '<task_id>x</task_id>\n<status>running</status>',
      false,
    )!
    expect(React.isValidElement(node)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/test/web/toolRenderers/agent.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement agent.tsx**

Create `packages/zai/src/web/src/components/toolRenderers/agent.tsx`:

```tsx
import React from "react"
import type { ToolRenderer } from "./types.js"
import { FieldLabel, PreBlock, stringFromOutput, truncate } from "./shared.js"
import { linkifyText } from "../../lib/linkify.js"

function firstLine(s: string): string {
  return s.split(/\r?\n/, 1)[0]?.trim() ?? ""
}

export const agentRenderer: ToolRenderer = {
  preview(input) {
    const desc = input.description
    if (typeof desc === "string" && desc.trim()) return truncate(desc.trim(), 80)
    const p = input.prompt
    if (typeof p === "string" && p.trim()) return truncate(firstLine(p), 80)
    return ""
  },

  displayName(input) {
    const t = input.subagent_type
    return `${typeof t === "string" && t.trim() ? t.trim() : "general-purpose"} (agent)`
  },

  renderInput(input) {
    const subType = typeof input.subagent_type === "string" && input.subagent_type.trim()
      ? input.subagent_type.trim()
      : "general-purpose"
    const prompt = typeof input.prompt === "string" ? input.prompt : ""
    return (
      <div>
        <FieldLabel>subagent_type</FieldLabel>
        <PreBlock>{linkifyText(subType)}</PreBlock>
        <FieldLabel>prompt</FieldLabel>
        <PreBlock>{linkifyText(prompt)}</PreBlock>
      </div>
    )
  },

  renderOutput(output) {
    const text = stringFromOutput(output)
    if (!text) return null
    return <PreBlock variant="success">{linkifyText(text)}</PreBlock>
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/test/web/toolRenderers/agent.test.ts`
Expected: PASS

- [ ] **Step 5: Register Agent**

In `registry.ts`:
- Import: `import { agentRenderer } from "./agent.js"`
- Add to registry: `Agent: agentRenderer,`

Final `registry.ts` should have:

```ts
import type { ToolRenderer } from "./types.js"
import { bashRenderer } from "./bash.js"
import { readRenderer } from "./read.js"
import { editRenderer } from "./edit.js"
import { writeRenderer } from "./write.js"
import { globRenderer } from "./glob.js"
import { grepRenderer } from "./grep.js"
import { agentRenderer } from "./agent.js"
import { genericRenderer } from "./generic.js"

const registry: Record<string, ToolRenderer> = {
  Bash: bashRenderer,
  Read: readRenderer,
  Edit: editRenderer,
  Write: writeRenderer,
  Glob: globRenderer,
  Grep: grepRenderer,
  Agent: agentRenderer,
}

export function setRenderer(name: string, renderer: ToolRenderer): void {
  registry[name] = renderer
}

export function getRenderer(name: string): ToolRenderer {
  return registry[name] ?? genericRenderer
}

export function _renderersForTest(): Readonly<Record<string, ToolRenderer>> {
  return registry
}
```

- [ ] **Step 6: Run all renderer tests in one pass**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/test/web/toolRenderers/`
Expected: all PASS (parser + 7 renderer tests + shared/generic + bash)

- [ ] **Step 7: Commit**

```bash
git add packages/zai/src/web/src/components/toolRenderers/agent.tsx \
        packages/zai/src/web/src/components/toolRenderers/registry.ts \
        packages/zai/test/web/toolRenderers/agent.test.ts
git commit -m "feat(zai-web): Agent tool renderer (preserve existing displayName/preview)"
```

---

## Task 10: Wire ToolCallBlock to the registry

**Files:**
- Modify: `packages/zai/src/web/src/pages/Agent.tsx` (`ToolCallBlock` only; preserve all unrelated functions like `ToolUsePill`, `ThinkingBlock`, `MessageBubble`, etc.)

**Interfaces:**
- Consumes: `getRenderer(name)` from Task 9

- [ ] **Step 1: Capture existing behaviour baseline**

Run the full test suite first to confirm the baseline is green:

Run: `pnpm --filter @zn-ai/zai test 2>&1 | tail -30`
Expected: all tests pass before the refactor

- [ ] **Step 2: Refactor ToolCallBlock**

In `packages/zai/src/web/src/pages/Agent.tsx`:

2a. Add imports at the top of the file (next to the existing `DiffBlock` / `linkifyText` import block):

```ts
import { getRenderer } from "../components/toolRenderers/registry.js"
import { linkifyText as _linkifyText } from "../lib/linkify.js" // keep existing alias
```

(`_linkifyText` if there is already an import — alias to avoid duplicates.)

2b. Replace the inline preview/displayName block (current `let preview = "" if (name === "Bash") ... else if (name === "Agent") ... else ...` at the ToolCallBlock body, currently around lines 545–582) with:

```tsx
const renderer = getRenderer(rawName)
const preview = renderer.preview(input)
const displayName = renderer.displayName?.(input) ?? rawName
```

2c. Replace the input JSON pre block (currently `<pre>{linkifyText(JSON.stringify(input, null, 2))}</pre>` inside the children render). Wrap it in a local helper inline:

```tsx
const renderGenericInput = () => (
  <pre
    style={{
      fontSize: 12, margin: "4px 0 0 0", padding: "8px 10px",
      background: "rgba(0,0,0,0.03)", borderRadius: 4,
      whiteSpace: "pre-wrap" as const, wordBreak: "break-word" as const,
      fontFamily: CODE_FONT_FAMILY,
    }}
  >
    {linkifyText(JSON.stringify(input, null, 2))}
  </pre>
)

const renderGenericOutput = () =>
  output === undefined || output === null ? null : (
    <pre
      style={{
        fontSize: 12, margin: "4px 0 0 0", padding: "8px 10px",
        background: "rgba(82,196,26,0.06)", borderLeft: "2px solid #52c41a",
        borderRadius: 4, whiteSpace: "pre-wrap" as const, wordBreak: "break-word" as const,
        fontFamily: CODE_FONT_FAMILY, maxHeight: 360, overflow: "auto" as const,
      }}
    >
      {typeof output === "string"
        ? linkifyText(output)
        : linkifyText(JSON.stringify(output, null, 2))}
    </pre>
  )
```

Where `output`/`errorText` are still the existing locals in scope.

2d. Replace the input/output tree inside `children:` with:

```tsx
{inputKeys.length > 0 && (
  <div style={{ marginBottom: 8 }}>
    <Text type="secondary" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>
      参数
    </Text>
    {renderer.renderInput ? renderer.renderInput(input) : renderGenericInput()}
  </div>
)}
{output !== undefined && output !== null && (
  <div style={{ marginBottom: 8 }}>
    <Text type="secondary" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>
      结果
    </Text>
    {renderer.renderOutput
      ? renderer.renderOutput(output, errorField != null)
      : renderGenericOutput()}
  </div>
)}
```

`output` and `errorField` are the existing locals. Do not delete them.

- [ ] **Step 3: Run typecheck**

Run: `pnpm --filter @zn-ai/zai typecheck 2>&1 | tail -30`
Expected: PASS (no `Cannot find name 'getRenderer'` or `TS2322` errors)

- [ ] **Step 4: Run full zai test suite**

Run: `pnpm --filter @zn-ai/zai test 2>&1 | tail -40`
Expected: all previously-passing tests still pass (318+ tests, no regression); all 7 new renderer test files pass

- [ ] **Step 5: Hand-fix any snapshot failures**

If `Agent.test.tsx` snapshots fail:
- Open each failing snapshot, regenerate via `pnpm --filter @zn-ai/zai exec vitest run packages/zai/test/web/Agent.test.tsx -u`
- Inspect the snapshot diff manually to confirm only render-quality changes (e.g. new pre blocks for Bash stdout/stderr), NOT structure-level divergence
- Commit the snapshot update separately if that is the only change

- [ ] **Step 6: Build to confirm production bundle**

Run: `pnpm --filter @zn-ai/zai build 2>&1 | tail -20`
Expected: success, no module resolution errors

- [ ] **Step 7: Browser smoke (manual via subagent)**

Use the `web-func-verifier` agent to:
1. Load the dev server `/agent` page (`pnpm --filter @zn-ai/zai dev` first if not running)
2. Send a prompt that triggers Bash + Read + Edit + Write + Glob + Grep + Agent tools (e.g. "检查 src/lib 下的 *.ts 文件，统计每个文件行数；然后给 src/lib/x.ts 写入一行注释；最后用 Grep 找 TODOs 并用 Glob 列 src/components 下所有 tsx 文件")
3. Verify visually:
   - Bash folded preview shows description; expanded shows stdout (green), stderr (yellow), plain (muted)
   - Read folded shows file path; expanded shows file path pre + offset/limit info
   - Write folded shows path with line count; expanded shows full content
   - Glob folded shows pattern; expanded shows pattern + optional path
   - Grep folded shows pattern; expanded shows pattern + collapsible secondary params
   - Edit folded shows path (with `(all)` if applicable); expanded shows old_string + new_string
   - Agent pill shows `<subagent_type> (agent)`; folded shows description or first line of prompt
4. Report pass / fail with screenshots if any mismatch

Run: `Agent tool with subagent_type=web-func-verifier` — pass the dev URL + manual test prompt above.

- [ ] **Step 8: Commit**

```bash
git add packages/zai/src/web/src/pages/Agent.tsx \
        packages/zai/test/web/Agent.test.tsx        # if snapshot updated
git commit -m "refactor(zai-web): ToolCallBlock dispatches to per-tool renderer registry"
```

---

## Self-Review (run after writing the plan, before execution)

1. **Spec coverage:** Sections 1 (architecture), 2.1–2.8 (8 renderers + parser), 3 (ToolCallBlock wiring), 4 (tests), 6 (non-goals) — Tasks 1, 2, 3, 4, 5, 6, 7, 8, 9 each cover one renderer; Task 1 covers generic + scaffolding; Task 10 covers wiring. Section 4 (parseBashOutput) is in Task 2 (parser) + Task 3 (renderer). Section 6 (non-goals) tracked by NEVER setting `setRenderer('AskUserQuestion', …)` or `setRenderer('TodoWrite', …)`. ✅
2. **Placeholder scan:** All step code blocks contain complete implementations; no "TBD" / "Similar to Task N" / "TODO" placeholders. (Two intentional `TODO` mentions in the spec about Edit diff lines — those are tracked in the design doc, not this plan.) ✅
3. **Type consistency:**
   - `ToolRenderer.preview(input)` returns `string` everywhere (Tasks 1, 3–9)
   - `renderInput(input)` returns `ReactNode` everywhere
   - `renderOutput(output, isError)` second arg is `boolean` everywhere
   - `pick(input, keys)` `keys` is `readonly string[]` — callers pass readonly literal arrays ✅
   - `stringFromOutput(out: unknown)` and `truncate(s: string, n: number)` match across Tasks 1, 3–9 ✅
4. **Order:** Task 2 (parser) is consumed by Task 3 (Bash renderer) — Bash depends on parser ✅
5. **Test count:** Task 1 (4 + 6 = 10 assertions across shared/generic), Task 2 (8 assertions), Task 3 (7), Task 4 (7), Task 5 (6), Task 6 (6), Task 7 (5), Task 8 (5), Task 9 (8). Total ~62 new assertions. Existing 318+ stay green. ✅
