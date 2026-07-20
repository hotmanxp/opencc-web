# zai Slash Command UI Display + ~/.claude/commands Fallback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make user-defined slash commands visible in the conversation transcript (show raw `/cmd args` plus server-rendered prompt as a muted second line in the same user bubble), and let `userLoader` fall back to `~/.claude/commands/` when `~/.zai/commands/` does not exist.

**Architecture:**
- Frontend-only push for the UI fix: `AgentInputBox.handleSend` slash branch (`case 'prompt'` / `case 'unknown'`) writes a `user.text` to the zustand store **before** calling `postPromptToLLM`. `MessageBubble` reads an optional `isRenderedPrompt?: boolean` flag on the message to render a muted follow-up line inside the same user card.
- `userLoader.ts:defaultCommandsDir` returns one directory under a strict single-source policy: `~/.zai/commands` if it exists, otherwise `~/.claude/commands`. Both never load together. Implementation accepts an injected `homeDir` to keep tests hermetic.
- No server-side behaviour change. No SSE / zod schema change. No new dependencies.

**Tech Stack:** TypeScript, vitest + happy-dom, zustand, Ant Design, Express, Bun. All already in tree.

---

## Global Constraints

- Test framework: **vitest**. `packages/zai/test/**` runs with `pnpm --filter @zn-ai/zai test` (or `bunx vitest run packages/zai/test/...`). Tests import `from 'vitest'`; do not use `bun:test`.
- Mock layer in frontend tests: `AgentInputBox.test.tsx` already mocks `../lib/api.js` and `../components/ConversationInfoButton.js` — extend that pattern rather than introducing a new mock approach.
- File paths are absolute or repo-relative; command directories resolve at runtime via `homedir()`. Tests inject a fake `homeDir` parameter; production code keeps the default.
- No package added, no server route touched, no zod schema in `packages/zai/src/shared/events.ts` touched.
- Command naming rule still applies: `^[a-z0-9][a-z0-9-_]*$` (`userLoader.ts:12`); YAGNI: do not relax it.
- Existing `userLoader` test `'returns [] when commands dir does not exist'` (lines 30-34) **must continue to pass unmodified**.
- Frontend store mutation always uses `useAgentStore.setState`; existing `sendSeq + 1` semantics preserved (each push bumps it once).
- The runtime type `AgentMessage = RuntimeEvent` (`useAgentStore.ts:102`) is indexable, so adding `isRenderedPrompt?: boolean` is type-safe without changing the runtime-event contract.

---

## Task 1: Widen `userLoader` loader function to support fallback directory

**Files:**
- Modify: `packages/zai/src/server/services/commands/userLoader.ts:14-17` (replace single dir with resolver) and `:83-121` (refactor scan into helper, call helper through a directory sequence)
- Test: `packages/zai/test/services/commands/userLoader.test.ts` (extend with 3 new cases)

**Interfaces:**
- Consumes: `CommandContext` (`@zn-ai/zai-agent-core`, has `cwd`, `dataDir`, optional `sessionId`, `model`)
- Produces:
  - `defaultCommandsDirs(opts: { dataDir?: string; homeDir?: string }): string[]` — returns `[zaiDir]` if zai exists, else `[claudeDir]`, else `[]`. Order is `[zaiDir, claudeDir]` and the **first existing directory wins**; the rest are dropped.
  - `loadUserCommands(context: CommandContext & { homeDir?: string }): Promise<PromptCommand[]>` — now accepts an optional `homeDir` field used only for fallback directory resolution.

- [ ] **Step 1: Write the failing tests**

Append to `packages/zai/test/services/commands/userLoader.test.ts`:

```ts
import { homedir } from 'node:os'

describe('loadUserCommands — fallback to ~/.claude/commands', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'zai-cmd-fallback-'))
    mkdirSync(join(homeDir, '.zai'), { recursive: true })
    mkdirSync(join(homeDir, '.claude'), { recursive: true })
    setCommandRegistry(null)
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
  })

  const writeCommandAt = (dir: string, name: string, body: string, extra: Record<string, unknown> = {}) => {
    const yaml = Object.entries({ description: name, ...extra })
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')
    writeFileSync(join(dir, `${name}.md`), `---\n${yaml}\n---\n${body}`, 'utf-8')
  }

  it('loads from ~/.claude/commands when ~/.zai/commands is absent', async () => {
    const claudeDir = join(homeDir, '.claude', 'commands')
    writeCommandAt(claudeDir, 'greet', 'Hello $ARGUMENTS')
    const cmds = await loadUserCommands({ cwd: '/x', dataDir: tmpHome, homeDir })
    expect(cmds.map((c) => c.name)).toEqual(['greet'])
  })

  it('prefers ~/.zai/commands over ~/.claude/commands when both exist', async () => {
    const zaiDir = join(tmpHome, '.zai', 'commands')
    const claudeDir = join(homeDir, '.claude', 'commands')
    writeCommandAt(zaiDir, 'greet', 'Hello $ARGUMENTS')
    writeCommandAt(claudeDir, 'greet', 'Bye $ARGUMENTS')
    const [cmd] = await loadUserCommands({ cwd: '/x', dataDir: tmpHome, homeDir })
    const rendered = await cmd!.getPromptForCommand('alice', { cwd: '/x', dataDir: tmpHome })
    expect((rendered[0] as { type: string; text: string }).text).toBe('Hello alice')
  })

  it('returns [] when neither directory exists', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'zai-cmd-empty-'))
    const cmds = await loadUserCommands({ cwd: '/x', dataDir: empty, homeDir: empty })
    expect(cmds).toEqual([])
    rmSync(empty, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/test/services/commands/userLoader.test.ts -t "fallback"`
Expected: 3 failures. The first with `Cannot find` or `homeDir is not a function parameter`; the others with directory resolution errors.

- [ ] **Step 3: Refactor `userLoader.ts` to support fallback**

Replace `userLoader.ts` lines `1-17` and the directory-resolution body of `loadUserCommands` (lines `83-121`) with:

```ts
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { PromptCommand, CommandContext, CommandSource } from '@zn-ai/zai-agent-core'

const requireFromAgentCore = createRequire(
  new URL('../../../../../zai-agent-core/', import.meta.url).pathname + 'package.json',
)
const yaml = requireFromAgentCore('js-yaml') as { load(s: string): unknown }

const NAME_RE = /^[a-z0-9][a-z0-9-_]*$$

interface CommandsDirsOpts {
  dataDir?: string
  homeDir?: string
}

/**
 * Resolve which command directory should be loaded. Policy:
 * 1. `~/.zai/commands` always wins if it exists (single-source for zai users).
 * 2. Otherwise fall back to `~/.claude/commands` for OpenCC workflows.
 * 3. Never merge — only one directory is scanned per server boot.
 */
export function defaultCommandsDirs(opts: CommandsDirsOpts = {}): string[] {
  const home = opts.homeDir ?? homedir()
  const zaiDir = opts.dataDir
    ? join(opts.dataDir, '.zai', 'commands')
    : join(home, '.zai', 'commands')
  const claudeDir = join(home, '.claude', 'commands')
  return existsSync(zaiDir) ? [zaiDir] : [claudeDir].filter((d) => existsSync(d))
}

interface CommandFrontmatter {
  description?: string
  argumentHint?: string
  argNames?: string[]
  allowedTools?: string[]
  model?: string
  effort?: PromptCommand['effort']
  disableModelInvocation?: boolean
  whenToUse?: string
  version?: string
}

function parseFrontmatter(raw: string): CommandFrontmatter | null {
  if (!raw.startsWith('---')) return null
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return null
  const yamlBlock = raw.slice(3, end).trim()
  try {
    return yaml.load(yamlBlock) as CommandFrontmatter
  } catch {
    return null
  }
}

function bodyOf(raw: string): string {
  if (!raw.startsWith('---')) return raw
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return raw
  const after = raw.slice(end + 4)
  return after.replace(/^\n+/, '')
}

function buildPromptCommand(
  fileName: string,
  fm: CommandFrontmatter | null,
  body: string,
): PromptCommand {
  const description = fm?.description ?? `User command ${fileName}`
  return {
    type: 'prompt',
    name: fileName,
    description,
    source: 'user' satisfies CommandSource,
    progressMessage: `Running /${fileName}`,
    contentLength: body.length,
    ...(fm?.argumentHint !== undefined ? { argumentHint: fm.argumentHint } : {}),
    ...(fm?.argNames !== undefined ? { argNames: fm.argNames } : {}),
    ...(fm?.allowedTools !== undefined ? { allowedTools: fm.allowedTools } : {}),
    ...(fm?.model !== undefined ? { model: fm.model } : {}),
    ...(fm?.effort !== undefined ? { effort: fm.effort } : {}),
    ...(fm?.disableModelInvocation !== undefined ? { disableModelInvocation: fm.disableModelInvocation } : {}),
    ...(fm?.whenToUse !== undefined ? { whenToUse: fm.whenToUse } : {}),
    ...(fm?.version !== undefined ? { version: fm.version } : {}),
    async getPromptForCommand(args: string, _context: CommandContext) {
      const { renderPrompt } = await import('@zn-ai/zai-agent-core')
      const text = renderPrompt({ body, args, argNames: fm?.argNames })
      return [{ type: 'text', text }]
    },
  }
}

/** Scan one directory for `*.md` files; first dir with content wins. */
async function scanDir(dir: string): Promise<PromptCommand[]> {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out: PromptCommand[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const name = entry.slice(0, -3)
    if (!NAME_RE.test(name)) {
      console.warn(`[userLoader] skipping invalid name: ${entry}`)
      continue
    }
    let raw: string
    try {
      raw = readFileSync(join(dir, entry), 'utf-8')
    } catch {
      continue
    }
    let fm: CommandFrontmatter | null
    try {
      fm = parseFrontmatter(raw)
    } catch {
      console.warn(`[userLoader] parseFrontmatter failed: ${entry}`)
      continue
    }
    if (fm === null) {
      console.warn(`[userLoader] no frontmatter: ${entry}`)
      continue
    }
    const body = bodyOf(raw)
    out.push(buildPromptCommand(name, fm, body))
  }
  return out
}

export async function loadUserCommands(
  context: CommandContext & { homeDir?: string },
): Promise<PromptCommand[]> {
  for (const dir of defaultCommandsDirs({ dataDir: context.dataDir, homeDir: context.homeDir })) {
    const cmds = await scanDir(dir)
    if (cmds.length > 0 || existsSync(dir)) {
      return cmds
    }
  }
  return []
}
```

The pre-existing `loadUserCommands(context)` callers (`registry.ts:27` `reloadUserCommands(context)`) keep working because `homeDir` is optional.

- [ ] **Step 4: Run the new tests to confirm they pass**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/test/services/commands/userLoader.test.ts`
Expected: all 7 tests pass (the 4 existing ones plus 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/server/services/commands/userLoader.ts packages/zai/test/services/commands/userLoader.test.ts
git commit -m "feat(userLoader): fall back to ~/.claude/commands when ~/.zai/commands is missing"
```

---

## Task 2: Push user messages to the store when slash commands fire

**Files:**
- Modify: `packages/zai/src/web/src/components/AgentInputBox.tsx:488-499` (replace inline `await postPromptToLLM(...)` in `case 'prompt'` and `case 'unknown'` with calls to a new `pushUserMsg` helper that writes `user.text` to the store; in the `prompt` branch write two messages, with the second tagged `isRenderedPrompt:true`)

**Interfaces:**
- Consumes: existing `useAgentStore.setState`, `readyAttachments`, `attachments` cleanup logic
- Produces: a `pushUserMsg(text: string, isRenderedPrompt?: boolean)` helper scoped inside `AgentInputBox` (closes over current input state and `useAgentStore.getState`)

- [ ] **Step 1: Write the failing tests**

Append to `packages/zai/src/web/src/components/AgentInputBox.test.tsx`:

```ts
import AgentInputBox from "./AgentInputBox.js";

vi.mock("../lib/api.js", () => ({
  api: { post: vi.fn() },
}))

import { api } from "../lib/api.js";
const mockedApiPost = vi.mocked(api.post)

async function typeAndSubmit(text: string) {
  render(<AgentInputBox />)
  const ta = (await screen.findByPlaceholderText(/输入消息/)) as HTMLTextAreaElement
  fireEvent.change(ta, { target: { value: text } })
  fireEvent.keyDown(ta, { key: "Enter", code: "Enter", shiftKey: false })
  await waitFor(() => expect(mockedApiPost).toHaveBeenCalled())
}

describe("AgentInputBox — slash command UI visibility", () => {
  beforeEach(() => {
    mockedApiPost.mockReset()
    useAgentStore.setState({
      sessionId: "sess-1",
      messages: [],
      status: "idle",
      sendSeq: 0,
    })
  })

  test("'prompt' branch pushes the raw /cmd args and a rendered user.text", async () => {
    mockedApiPost.mockResolvedValueOnce({
      type: "prompt",
      payload: { rendered: "Hello alice" },
    })
    await typeAndSubmit("/greet alice")
    await waitFor(() => {
      const msgs = useAgentStore.getState().messages
      expect(msgs.length).toBeGreaterThanOrEqual(2)
      const tail = msgs.slice(-2)
      expect(tail[0]).toMatchObject({ type: "user.text", text: "/greet alice" })
      expect(tail[1]).toMatchObject({
        type: "user.text",
        text: "Hello alice",
        isRenderedPrompt: true,
      })
    })
  })

  test("'unknown' branch pushes exactly one user.text without isRenderedPrompt", async () => {
    mockedApiPost.mockResolvedValueOnce({
      type: "unknown",
      payload: { input: "/greet" },
    })
    await typeAndSubmit("/greet alice")
    await waitFor(() => {
      const msgs = useAgentStore.getState().messages
      const tail = msgs[msgs.length - 1]
      expect(tail).toMatchObject({ type: "user.text", text: "/greet alice" })
      expect((tail as { isRenderedPrompt?: boolean }).isRenderedPrompt).toBeUndefined()
    })
  })
})
```

> Note: existing top-level mocks and `beforeEach` already exist in this file — keep them; only append the new `describe`. The existing tests do not touch `handleSend`, so adding a new `describe` is safe. If `screen.findByPlaceholderText` collides with another element, narrow with `screen.getAllByPlaceholderText(...)[0]`.

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/src/web/src/components/AgentInputBox.test.tsx -t "slash command UI"`
Expected: 2 failures. `messages` array stays empty (or only contains the LLM-side message) because `handleSend` does not yet call `setState({ messages: ... })` in these branches.

- [ ] **Step 3: Add the `pushUserMsg` helper and wire it into `case 'prompt'` / `case 'unknown'`**

In `packages/zai/src/web/src/components/AgentInputBox.tsx`, immediately above `handleSend` (around line 449), add:

```ts
const pushUserMsg = useCallback(
  (text: string, isRenderedPrompt = false) => {
    const ready = attachments.filter((a) => a.status === "ready")
    useAgentStore.setState((s) => ({
      status: "streaming",
      messages: [
        ...s.messages,
        {
          eventId: `user-${Date.now()}-${isRenderedPrompt ? "r" : "o"}`,
          sessionId: "",
          ts: Date.now(),
          turnIndex: 0,
          type: "user.text",
          text,
          isRenderedPrompt,
          attachments: ready.map((a) => ({
            localId: a.localId,
            mime: a.mime,
            filename: a.filename,
            thumbnailUrl: a.base64DataUrl,
            status: a.status,
          })),
        },
      ],
      sendSeq: s.sendSeq + 1,
    }))
    ready.forEach((a) => URL.revokeObjectURL(a.thumbnailUrl))
    setAttachments((prev) => prev.filter((a) => a.status !== "ready"))
  },
  [attachments],
)
```

Then update the two branches inside `handleSend` (currently lines 488-499):

```ts
case "prompt":
  pushUserMsg(text, false)
  if (result.payload?.rendered) {
    pushUserMsg(result.payload.rendered, true)
  }
  await postPromptToLLM(result.payload?.rendered ?? "", blocks)
  return

case "unknown":
  pushUserMsg(text, false)
  await postPromptToLLM(text, blocks)
  return
```

Keep all the other branches (`cleared`, `compacted`, `status`, `message`, `error`) unchanged.

- [ ] **Step 4: Run the new tests to confirm they pass**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/src/web/src/components/AgentInputBox.test.tsx`
Expected: all tests (existing + 2 new) pass.

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/components/AgentInputBox.tsx packages/zai/src/web/src/components/AgentInputBox.test.tsx
git commit -m "feat(AgentInputBox): show slash command raw input + rendered prompt in transcript"
```

---

## Task 3: Render the `isRenderedPrompt` line inside the user bubble

**Files:**
- Modify: `packages/zai/src/web/src/components/transcript/MessageBubble.tsx:750-831` (the `user.text` / `user.message` branch — extend the existing `<Space>` to allow a second row when `isRenderedPrompt` is set)

- [ ] **Step 1: Write the failing rendering test**

Create `packages/zai/src/web/src/components/transcript/MessageBubble.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, expect, test } from "vitest"
import "@testing-library/jest-dom"
import { render, screen } from "@testing-library/react"
import { MessageBubble } from "./MessageBubble.js"

describe("MessageBubble — isRenderedPrompt rendering", () => {
  test("renders muted follow-up line when isRenderedPrompt is true", () => {
    render(
      <MessageBubble
        msg={{
          eventId: "user-1-r",
          sessionId: "sess-1",
          ts: 1,
          turnIndex: 0,
          type: "user.text",
          text: "Hello alice",
          isRenderedPrompt: true,
        }}
      />,
    )
    expect(screen.getByText(/^渲染后$/)).toBeInTheDocument()
    expect(screen.getByText("Hello alice")).toBeInTheDocument()
  })

  test("does not render muted line for ordinary user.text", () => {
    render(
      <MessageBubble
        msg={{
          eventId: "user-2",
          sessionId: "sess-1",
          ts: 1,
          turnIndex: 0,
          type: "user.text",
          text: "Hello",
        }}
      />,
    )
    expect(screen.queryByText(/^渲染后$/)).toBeNull()
    expect(screen.getByText("Hello")).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the new test to confirm it fails**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/src/web/src/components/transcript/MessageBubble.test.tsx`
Expected: 1 failure (`getByText(/^渲染后$/)` not found).

- [ ] **Step 3: Update `MessageBubble` to render the muted follow-up line**

In `packages/zai/src/web/src/components/transcript/MessageBubble.tsx`, replace the `user.text` / `user.message` branch (lines 750-831) with:

```tsx
if (msg.type === "user.text" || msg.type === "user.message") {
  const msgAttachments =
    (msg.attachments as PendingAttachment[] | undefined) ?? []
  const isRendered = Boolean((msg as { isRenderedPrompt?: unknown }).isRenderedPrompt)
  const visibleText = ((msg.text as string) || (msg.prompt as string) || "")
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "flex-end",
        marginBottom: 16,
      }}
    >
      <Card
        size="small"
        style={{
          maxWidth: "70%",
          background: "#e6f4ff",
          borderRadius: 12,
        }}
      >
        {msgAttachments.length > 0 && (
          <AttachmentStrip
            attachments={msgAttachments}
            previewHeight={80}
            onPreview={(a) =>
              setPreviewingAttachment({
                url: a.thumbnailUrl,
                filename: a.filename,
              })
            }
          />
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <Space>
            <UserOutlined />
            <Text>{linkifyText(visibleText)}</Text>
          </Space>
          {isRendered && (
            <Text
              data-testid="user-text-rendered-prompt"
              style={{
                fontSize: 12,
                fontStyle: "italic",
                color: "rgba(0,0,0,0.55)",
                borderLeft: "2px solid rgba(0,0,0,0.18)",
                paddingLeft: 8,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              <span style={{ color: "rgba(0,0,0,0.45)", marginRight: 4 }}>⤷</span>
              <span style={{ fontWeight: 500 }}>渲染后</span>
              <span style={{ margin: "0 6px", color: "rgba(0,0,0,0.35)" }}>·</span>
              {linkifyText(visibleText)}
            </Text>
          )}
        </div>
      </Card>
      <Modal
        open={previewingAttachment !== null}
        onCancel={() => setPreviewingAttachment(null)}
        footer={null}
        width="auto"
        centered
        destroyOnClose
        title={previewingAttachment?.filename}
        styles={{ body: { padding: 0, background: "transparent" } }}
      >
        {previewingAttachment && (
          <img
            src={previewingAttachment.url}
            alt={previewingAttachment.filename}
            style={{
              display: "block",
              maxWidth: "90vw",
              maxHeight: "85vh",
              width: "auto",
              height: "auto",
              cursor: "zoom-out",
              borderRadius: 4,
            }}
            onClick={() => setPreviewingAttachment(null)}
          />
        )}
      </Modal>
    </div>
  )
}
```

The `MessageBubble` is `React.memo`-wrapped; it re-renders when `msg` reference changes, so each `pushUserMsg` (which spreads into a new message object) triggers an update. The `data-testid` is only present for the rendered-prompt case so the new test can locate it precisely.

- [ ] **Step 4: Run the new tests to confirm they pass**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/src/web/src/components/transcript/MessageBubble.test.tsx`
Expected: 2 / 2 pass.

- [ ] **Step 5: Run the full frontend test file to confirm no regressions**

Run: `pnpm --filter @zn-ai/zai exec vitest run packages/zai/src/web`
Expected: every suite green.

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/web/src/components/transcript/MessageBubble.tsx packages/zai/src/web/src/components/transcript/MessageBubble.test.tsx
git commit -m "feat(MessageBubble): render rendered-prompt line inside user bubble"
```

---

## Task 4: Update the legacy commands spec to reflect the new fallback policy

**Files:**
- Modify: `docs/superpowers/specs/2026-07-15-zai-builtin-commands-design.md` §1.1 "沿用的核心约束" item 2

- [ ] **Step 1: Apply the in-place annotation**

Edit the file so the second item in §1.1 reads:

```diff
-- 不读 OpenCC 默认命令路径(`~/.claude/commands`),zai 用 `~/.zai/commands/`(单一来源,显式配置)
++ 命令加载: 优先读取 `~/.zai/commands/`;该目录不存在时,回退读取 `~/.claude/commands/`(单向 fallback,
++ 详见 `2026-07-20-zai-slash-command-ui-display-design.md`)
```

Add a one-line note above the modified item: `> 历史:本 spec 原 §1.1 第 2 项于 2026-07-20 被 `2026-07-20-zai-slash-command-ui-display-design.md` 修订;保留旧文本以做溯源。` Keep all other content identical.

- [ ] **Step 2: Verify the diff is the only change**

Run: `git diff docs/superpowers/specs/2026-07-15-zai-builtin-commands-design.md`
Expected: only the diff shown above plus the new header note line. No other content moved.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-15-zai-builtin-commands-design.md
git commit -m "docs(spec): annotate commands loader fallback to ~/.claude/commands"
```

---

## Task 5: End-to-end smoke (manual) verification

**Files:** none. This task is a checklist the implementing engineer runs in a browser before declaring the plan complete.

- [ ] **Step 1: Start zai against a temp data dir**

Run: `ZAI_DATA_DIR=/tmp/zai-fallback-smoke pnpm --filter @zn-ai/zai dev` (or the project's existing dev command; check `package.json` "scripts" if unsure). Confirm the server prints listening on `http://localhost:<port>`.

- [ ] **Step 2: Create a command in `~/.claude/commands/`**

Run: `mkdir -p ~/.claude/commands && cat > ~/.claude/commands/greet.md <<'EOF'
---
description: Greet someone
argumentHint: '[name]'
---
Greet $ARGUMENTS warmly.
EOF`

Do **not** create `~/.zai/commands`.

- [ ] **Step 3: In the Agent UI, type `/greet alice`, confirm**

- The autocomplete dropdown shows `/greet`.
- After Enter, two lines appear in the right-aligned user bubble: `/greet alice` on top, `⤷ 渲染后 · Greet alice warmly.` muted below.
- The LLM stream reply appears afterwards as usual.

- [ ] **Step 4: Repeat with `~/.zai/commands/` present, confirm `~/.claude/commands/` is ignored**

Run: `mkdir -p ~/.zai/commands && cat > ~/.zai/commands/greet.md <<'EOF'
---
description: Zai-side greet
---
Override $ARGUMENTS.
EOF`

Reload the zai server (or wait for `reloadUserCommands` if you have a watcher — there is no watcher in MVP, restart is required). Confirm `/greet alice` renders `Override alice warmly.` (zai file wins; claude file is ignored).

- [ ] **Step 5: Type an unknown slash command**

In Agent UI: `/foo bar` (with `/foo` not registered anywhere).
Confirm the user bubble shows `/foo bar` (no muted line) and the LLM response comes normally.

- [ ] **Step 6: Document the smoke result**

Write a short note in your PR description (or in `docs/superpowers/plans/2026-07-20-zai-slash-command-ui-display.md` "Smoke verification" subsection if you maintain one). Include the dev command, command paths exercised, observed DOM output, and any caveats (e.g., "zai had to restart to pick up new command files — this is consistent with MVP, no watcher").

---

## Self-Review

1. **Spec coverage:** §3.1 (AgentMessage extension) covered by Task 2 (`isRenderedPrompt` written) + Task 3 (rendered). §3.2 (MessageBubble) covered by Task 3. §3.3 (handleSend push) covered by Task 2. §3.4 (userLoader fallback) covered by Task 1. §3.5 (legacy spec update) covered by Task 4. §4 tests covered as a sub-step of each implementation task; the smoke check in Task 5 covers §5 risk assessment intuitively. The "compatibility" check in §6 is satisfied because every existing test continues to run unmodified in each task's final step.
2. **Placeholder scan:** no `TBD` / `TODO` / "implement later" patterns remain. Each task step contains the actual code or command.
3. **Type consistency:** `defaultCommandsDirs`, `loadUserCommands`, `pushUserMsg`, `isRenderedPrompt` are named identically across tasks. `PushUserMsg` (Task 2) → `MessageBubble` consumer (Task 3) reference the same field. `data-testid` strings in tests match the DOM attributes added in implementation.
