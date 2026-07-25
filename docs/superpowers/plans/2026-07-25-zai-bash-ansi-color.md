# Bash 输出 ANSI 颜色渲染 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse ANSI SGR escape codes in Bash tool output and render them as colored `<span>` elements in the Agent chat UI.

**Architecture:** New `ansi.tsx` module with `parseAnsi(text) → ReactNode[]` + `<AnsiText>` component. `PreBlock` in `shared.tsx` gains `ansi?: boolean` prop. `bash.tsx` `renderOutput` passes `ansi` and drops `linkifyText` on output side.

**Tech Stack:** React, TypeScript, vitest + happy-dom. Zero new dependencies — 16-color CSS palette hardcoded.

## Global Constraints

- No new npm dependencies
- 16-color palette only (no 256/RGB)
- Scope: Agent Bash cards only (not Bash REPL tab, not background tasks)
- No toggle button / no global setting
- `renderInput` still uses `linkifyText`; only `renderOutput` drops it
- `parseAnsi` never throws — malformed input degrades to plain text

---

### Task 1: ANSI SGR Parser + AnsiText Component (TDD)

**Files:**
- Create: `packages/zai/src/web/src/components/toolRenderers/ansi.tsx`
- Create: `packages/zai/test/web/toolRenderers/ansi.test.ts`

**Interfaces:**
- `parseAnsi(text: string): ReactNode[]` — returns array of strings and `<span>` elements
- `<AnsiText text={string} />` — React component wrapping `parseAnsi`
- Exports from `ansi.tsx`: `parseAnsi`, `AnsiText`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/zai/test/web/toolRenderers/ansi.test.ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import React from 'react'
import { parseAnsi, AnsiText } from '../../../src/web/src/components/toolRenderers/ansi.js'

function collectText(nodes: React.ReactNode[]): string {
  let out = ''
  for (const n of nodes) {
    if (typeof n === 'string') out += n
    else if (typeof n === 'number') out += String(n)
    else if (React.isValidElement(n)) {
      const children = (n.props as any).children
      if (typeof children === 'string') out += children
      else if (Array.isArray(children)) out += collectText(children)
    }
  }
  return out
}

function getSpans(nodes: React.ReactNode[]): Array<{ style: React.CSSProperties; text: string }> {
  const spans: Array<{ style: React.CSSProperties; text: string }> = []
  for (const n of nodes) {
    if (React.isValidElement(n) && (n as any).type === 'span') {
      const props = n.props as any
      spans.push({ style: props.style ?? {}, text: typeof props.children === 'string' ? props.children : '' })
    }
  }
  return spans
}

describe('parseAnsi', () => {
  it('returns plain text as single string node when no escapes', () => {
    const nodes = parseAnsi('hello world')
    expect(nodes).toEqual(['hello world'])
  })

  it('returns empty array for empty string', () => {
    expect(parseAnsi('')).toEqual([])
  })

  it('renders red text with correct color', () => {
    const nodes = parseAnsi('\x1b[31mhello\x1b[0m')
    const spans = getSpans(nodes)
    expect(spans).toHaveLength(1)
    expect(spans[0].text).toBe('hello')
    expect(spans[0].style.color).toBe('#cd3131')
  })

  it('renders bold+red composite', () => {
    const nodes = parseAnsi('\x1b[1;31mbold red\x1b[0m')
    const spans = getSpans(nodes)
    expect(spans).toHaveLength(1)
    expect(spans[0].style.fontWeight).toBe(700)
    expect(spans[0].style.color).toBe('#cd3131')
  })

  it('resets style after ESC[0m', () => {
    const nodes = parseAnsi('\x1b[31mred\x1b[0m plain')
    const spans = getSpans(nodes)
    expect(spans).toHaveLength(1)
    expect(spans[0].text).toBe('red')
    expect(spans[0].style.color).toBe('#cd3131')
    // "plain" should be a bare string node, not a span
    const plainNodes = nodes.filter(n => typeof n === 'string')
    expect(plainNodes).toContain(' plain')
  })

  it('strips non-SGR CSI sequences', () => {
    const nodes = parseAnsi('\x1b[2Jhello\x1b[A')
    expect(collectText(nodes)).toBe('hello')
    expect(getSpans(nodes)).toHaveLength(0)
  })

  it('strips OSC sequences', () => {
    const nodes = parseAnsi('\x1b]0;title\x07hello')
    expect(collectText(nodes)).toBe('hello')
  })

  it('handles truncated escape gracefully', () => {
    // \x1b[31 without closing m — regex won't match, so it stays as text
    const nodes = parseAnsi('\x1b[31hello')
    const text = collectText(nodes)
    expect(text).toBe('\x1b[31hello')
  })

  it('renders all 8 basic foreground colors', () => {
    const expected: Record<number, string> = {
      30: '#000000', 31: '#cd3131', 32: '#0dbc79', 33: '#e5e510',
      34: '#2472c8', 35: '#bc3fbc', 36: '#11a8cd', 37: '#e5e5e5',
    }
    for (const [code, hex] of Object.entries(expected)) {
      const nodes = parseAnsi(`\x1b[${code}mx\x1b[0m`)
      const spans = getSpans(nodes)
      expect(spans[0].style.color).toBe(hex)
    }
  })

  it('renders bright foreground colors', () => {
    const nodes = parseAnsi('\x1b[91mbright red\x1b[0m')
    const spans = getSpans(nodes)
    expect(spans[0].style.color).toBe('#f14c4c')
  })
})

describe('AnsiText', () => {
  it('is a valid React element', () => {
    const el = React.createElement(AnsiText, { text: 'hello' })
    expect(React.isValidElement(el)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/liangxuechao572/code/opencc-web/packages/zai && npx vitest run test/web/toolRenderers/ansi.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ansi.tsx**

```tsx
// packages/zai/src/web/src/components/toolRenderers/ansi.tsx
import React, { type ReactNode, type CSSProperties } from 'react'

/* ── 16-color palette (VS Code dark theme) ─────────────── */

const FG_16: string[] = [
  '#000000', // 30 black
  '#cd3131', // 31 red
  '#0dbc79', // 32 green
  '#e5e510', // 33 yellow
  '#2472c8', // 34 blue
  '#bc3fbc', // 35 magenta
  '#11a8cd', // 36 cyan
  '#e5e5e5', // 37 white
  '#666666', // 90 bright black
  '#f14c4c', // 91 bright red
  '#23d18b', // 92 bright green
  '#f5f543', // 93 bright yellow
  '#3b8eea', // 94 bright blue
  '#d670d6', // 95 bright magenta
  '#29b8db', // 96 bright cyan
  '#e5e5e5', // 97 bright white
]

const BG_16: string[] = [
  '#000000', '#7f0000', '#093b00', '#715c00',
  '#00188a', '#68217a', '#004552', '#a5a5a5',
  '#3d3d3d', '#cd3131', '#0dbc79', '#e5e510',
  '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
]

function fgColor(code: number): string | undefined {
  if (code >= 30 && code <= 37) return FG_16[code - 30]
  if (code >= 90 && code <= 97) return FG_16[code - 90 + 8]
  return undefined
}

function bgColor(code: number): string | undefined {
  if (code >= 40 && code <= 47) return BG_16[code - 40]
  if (code >= 100 && code <= 107) return BG_16[code - 100 + 8]
  return undefined
}

/* ── Style state ────────────────────────────────────────── */

interface SgrState {
  color?: string
  backgroundColor?: string
  fontWeight?: number
  opacity?: number
  fontStyle?: string
  textDecoration?: string
}

function isStateEmpty(s: SgrState): boolean {
  return (
    s.color === undefined &&
    s.backgroundColor === undefined &&
    s.fontWeight === undefined &&
    s.opacity === undefined &&
    s.fontStyle === undefined &&
    s.textDecoration === undefined
  )
}

function applySgr(params: number[], state: SgrState): SgrState {
  if (params.length === 0) return {}
  const next = { ...state }
  for (const p of params) {
    switch (p) {
      case 0: return {}
      case 1: next.fontWeight = 700; break
      case 2: next.opacity = 0.6; break
      case 3: next.fontStyle = 'italic'; break
      case 4: next.textDecoration = 'underline'; break
      case 22: delete next.fontWeight; delete next.opacity; break
      case 23: delete next.fontStyle; break
      case 24: delete next.textDecoration; break
      case 39: delete next.color; break
      case 49: delete next.backgroundColor; break
      default: {
        const fg = fgColor(p)
        if (fg !== undefined) { next.color = fg; break }
        const bg = bgColor(p)
        if (bg !== undefined) { next.backgroundColor = bg; break }
        break
      }
    }
  }
  return next
}

/* ── Regex: match CSI and OSC sequences ─────────────────── */

const ANSI_RE = /\x1b(?:\[[0-9;?]*[A-Za-z~]|\][^\x07]*(?:\x07|\x1b\\))/g

/* ── Public API ─────────────────────────────────────────── */

export function parseAnsi(text: string): ReactNode[] {
  if (!text) return []

  const result: ReactNode[] = []
  let state: SgrState = {}
  let lastIdx = 0
  let key = 0

  for (const match of text.matchAll(ANSI_RE)) {
    const idx = match.index!
    const seq = match[0]

    // Flush plain text before this escape
    if (idx > lastIdx) {
      const chunk = text.slice(lastIdx, idx)
      if (isStateEmpty(state)) {
        result.push(chunk)
      } else {
        result.push(<span key={key++} style={state}>{chunk}</span>)
      }
    }

    // Process the escape sequence
    if (seq[1] === '[' && seq.endsWith('m')) {
      const paramStr = seq.slice(2, -1)
      const params = paramStr === '' ? [0] : paramStr.split(';').map(Number)
      state = applySgr(params, state)
    }
    // Non-SGR CSI or OSC → stripped (no state change)

    lastIdx = idx + seq.length
  }

  // Flush remaining text
  if (lastIdx < text.length) {
    const tail = text.slice(lastIdx)
    if (isStateEmpty(state)) {
      result.push(tail)
    } else {
      result.push(<span key={key++} style={state}>{tail}</span>)
    }
  }

  return result
}

export function AnsiText({ text }: { text: string }): JSX.Element {
  return <>{parseAnsi(text)}</>
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/liangxuechao572/code/opencc-web/packages/zai && npx vitest run test/web/toolRenderers/ansi.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/liangxuechao572/code/opencc-web
git add packages/zai/src/web/src/components/toolRenderers/ansi.tsx \
        packages/zai/test/web/toolRenderers/ansi.test.ts
git commit -m "feat(web): add ANSI SGR parser with 16-color palette"
```

---

### Task 2: PreBlock ansi Prop + bash.tsx Integration

**Files:**
- Modify: `packages/zai/src/web/src/components/toolRenderers/shared.tsx`
- Modify: `packages/zai/src/web/src/components/toolRenderers/bash.tsx`
- Modify: `packages/zai/test/web/toolRenderers/bash.test.ts`

**Interfaces:**
- `PreBlock` new prop: `ansi?: boolean` (default `false`)
- When `ansi && typeof children === 'string'` → render `<AnsiText text={children} />`
- `bashRenderer.renderOutput`: pass `ansi` to all three `<PreBlock>`, remove `linkifyText` from output

- [ ] **Step 1: Add regression test to bash.test.ts**

Append to the existing `describe('bashRenderer', ...)` block in `packages/zai/test/web/toolRenderers/bash.test.ts`:

```typescript
  it('renderOutput strips ANSI escapes from text content', () => {
    const node = bashRenderer.renderOutput?.(
      '<stdout>\x1b[31mred\x1b[0m text</stdout>',
      false,
    )
    function collectText(n: any): string {
      if (n == null || typeof n === 'boolean') return ''
      if (typeof n === 'string' || typeof n === 'number') return String(n)
      if (Array.isArray(n)) return n.map(collectText).join('')
      if (n?.props?.children !== undefined) return collectText(n.props.children)
      return ''
    }
    const text = collectText(node)
    expect(text).not.toContain('\x1b')
    expect(text).toContain('red')
    expect(text).toContain(' text')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/liangxuechao572/code/opencc-web/packages/zai && npx vitest run test/web/toolRenderers/bash.test.ts`
Expected: The new test FAILS — current code passes raw text (with `\x1b`) through `linkifyText`

- [ ] **Step 3: Modify shared.tsx**

In `packages/zai/src/web/src/components/toolRenderers/shared.tsx`:

1. Add import at top:
```typescript
import { AnsiText } from "./ansi.js"
```

2. Replace the `PreBlock` function with:
```tsx
export function PreBlock({
  children,
  variant = "muted",
  ansi = false,
}: {
  children: React.ReactNode
  variant?: "muted" | "success" | "error" | "warn"
  ansi?: boolean
}) {
  const variantStyle =
    variant === "success"
      ? STYLE.preSuccess
      : variant === "error"
        ? STYLE.preError
        : variant === "warn"
          ? STYLE.preWarn
          : STYLE.preMuted
  const content =
    ansi && typeof children === "string" ? (
      <AnsiText text={children} />
    ) : (
      children
    )
  return <pre style={{ ...STYLE.preBase, ...variantStyle }}>{content}</pre>
}
```

- [ ] **Step 4: Modify bash.tsx renderOutput**

In `packages/zai/src/web/src/components/toolRenderers/bash.tsx`, replace the `renderOutput` method:

```tsx
  renderOutput(output) {
    if (output === undefined || output === null) return null
    const { stdout, stderr, plain } = parseBashOutput(stringFromOutput(output))
    return (
      <>
        {stdout && (
          <PreBlock variant="success" ansi>{stdout}</PreBlock>
        )}
        {stderr && <PreBlock variant="warn" ansi>{stderr}</PreBlock>}
        {plain && <PreBlock ansi>{plain}</PreBlock>}
      </>
    )
  },
```

Note: `linkifyText` import stays because `renderInput` still uses it.

- [ ] **Step 5: Run all toolRenderers tests**

Run: `cd /Users/liangxuechao572/code/opencc-web/packages/zai && npx vitest run test/web/toolRenderers/`
Expected: All tests PASS (existing + new)

- [ ] **Step 6: Typecheck**

Run: `cd /Users/liangxuechao572/code/opencc-web/packages/zai && npx tsc -b --noEmit`
Expected: No new errors

- [ ] **Step 7: Commit**

```bash
cd /Users/liangxuechao572/code/opencc-web
git add packages/zai/src/web/src/components/toolRenderers/shared.tsx \
        packages/zai/src/web/src/components/toolRenderers/bash.tsx \
        packages/zai/test/web/toolRenderers/bash.test.ts
git commit -m "feat(web): render Bash output with ANSI colors via PreBlock ansi prop"
```

---

### Task 3: Build Verification + Spec Commit

**Files:**
- Commit: `docs/superpowers/specs/2026-07-25-zai-bash-ansi-color-design.md` (spec corrections)

- [ ] **Step 1: Commit spec corrections**

```bash
cd /Users/liangxuechao572/code/opencc-web
git add docs/superpowers/specs/2026-07-25-zai-bash-ansi-color-design.md
git commit -m "docs(spec): correct ansi-styles dependency → hardcoded palette"
```

- [ ] **Step 2: Run full build**

Run: `cd /Users/liangxuechao572/code/opencc-web/packages/zai && npm run build`
Expected: Build succeeds (tsc + vite)

- [ ] **Step 3: Run full zai test suite**

Run: `cd /Users/liangxuechao572/code/opencc-web/packages/zai && npx vitest run`
Expected: No new failures (pre-existing failures are acceptable)

- [ ] **Step 4: Commit plan file**

```bash
cd /Users/liangxuechao572/code/opencc-web
git add docs/superpowers/plans/2026-07-25-zai-bash-ansi-color.md
git commit -m "docs(plan): Bash ANSI color rendering implementation plan"
```
