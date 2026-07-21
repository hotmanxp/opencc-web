# zai Split-Pane Right Panel — Design

> Date: 2026-07-21
> Status: Approved (brainstorming → writing-plans pending)
> Owner: zai-web

## Summary

Add a right-side **split-pane** panel to the `Agent` page that is collapsed by
default and toggled by a single button. The panel hosts three AntD `Tabs`:

1. **Git** — left column lists git-changed files relative to working tree
   (status --porcelain, including untracked); right column shows
   `git diff` for the selected file.
2. **Files** — left column lists the cwd directory tree on demand (click a
   directory to fetch its children; no depth cap — any directory reachable
   under cwd can be drilled into). Filtering still ignores `node_modules`
   / `.git` / build artifacts; right column shows file contents.
3. **Placeholder** — third tab reserved for future use. Renders an AntD
   `Empty` "即将到来" / "Coming soon".

Only the Git and Files tabs are implemented in this iteration. The third tab
ships as a no-op placeholder so the tab bar shape is stable.

The panel is **page-scoped** (only visible on `Agent.tsx`) and **read-only**.
State (open/closed, active tab) is persisted to `localStorage`. CWD-driven
refresh piggybacks on the existing `useSessionCwd` SSE/cwd watcher.

## Goals

- Give the user a glanceable, always-on context of "what's changed in this
  repository right now" without leaving the chat surface.
- Reuse the look-and-feel of `TaskDrawer` (dark theme, AntD components).
- Stay strictly read-only — no `git add`, `git commit`, file writes, etc.
- Avoid new SSE channels — use existing `useSessionCwd` plus one-shot HTTP
  fetches on tab open / cwd change / manual refresh.

## Non-Goals

- Vim-style keyboard commander, Monaco editor, or split-within-split.
- Git write operations (`commit`, `push`, `stash`, `checkout`).
- Real-time file-change streaming via `fs.watch` / `chokidar` — the panel
  refreshes on cwd change, on tab activation, and on the manual refresh
  button. Five-second polling is the recommended cadence if user feedback
  demands it (deferred).
- Cross-page persistence (this panel only exists on `Agent`).
- Porting the `Directory.tsx` page contents into the panel — they remain
  separate; this feature is per-session cwd.

## Architecture

### Frontend additions

| Path | Purpose |
|------|---------|
| `packages/zai/src/web/src/components/splitPane/SplitPane.tsx` | The shell: three-column flex container that wraps Agent's existing main column. Hosts the toggle button + Tabs + selected child tab. Owns localStorage state. |
| `packages/zai/src/web/src/components/splitPane/GitTab.tsx` | Tab 1 — file list + diff viewer. |
| `packages/zai/src/web/src/components/splitPane/FsTab.tsx` | Tab 2 — directory tree + file preview. |
| `packages/zai/src/web/src/components/splitPane/PlaceholderTab.tsx` | Tab 3 — empty placeholder. |
| `packages/zai/src/web/src/components/splitPane/useGitStatus.ts` | `useGitStatus(cwd)` hook — fetches `/api/git/status` on cwd change. |
| `packages/zai/src/web/src/components/splitPane/useGitDiff.ts` | `useGitDiff(cwd, path, isUntracked)` hook. |
| `packages/zai/src/web/src/components/splitPane/useFsList.ts` | `useFsList(cwd, dir)` hook. |
| `packages/zai/src/web/src/components/splitPane/useFsFile.ts` | `useFsFile(cwd, path)` hook. |
| `packages/zai/src/web/src/components/splitPane/shared.ts` | Shared types & constants (width clamps, status colors, localStorage sync). Directory depth is unbounded — children are loaded lazily on expand. |
| `packages/zai/src/web/src/components/splitPane/SplitPane.test.tsx` | localStorage persistence + toggle behavior. |
| `packages/zai/src/web/src/components/splitPane/GitTab.test.tsx` | Renders list, triggers diff fetch on click. |
| `packages/zai/src/web/src/components/splitPane/FsTab.test.tsx` | Tree rendering + leaf click fetches preview. |
| `packages/zai/src/web/src/components/splitPane/*.css` | Local styles (dark theme, splitter handle). Optional — may live inline like other components. |

### Backend additions

| Path | Purpose |
|------|---------|
| `packages/zai/src/server/routes/git.ts` | `/git/status`, `/git/diff` (read-only, execFile). |
| `packages/zai/src/server/routes/fs.ts` | `/fs/list`, `/fs/file` (cwd-rooted whitelist). |
| `packages/zai/src/server/routes/git.test.ts` | Fixture-based: git init → write/edit → porcelain parse; untracked diff via `git diff --no-index`. |
| `packages/zai/src/server/routes/fs.test.ts` | Whitelist / extension / size-cap branches. |

### Modified paths

| Path | Change |
|------|--------|
| `packages/zai/src/server/index.ts` | Register `gitRouter` and `fsRouter` under `/api`. |
| `packages/zai/src/web/src/pages/Agent.tsx` | Wrap the existing two-column layout with `<SplitPane>`. Insert toggle button next to the existing `+ N fold` cluster in the left sidebar. |

## Data Flow

### Tab 1 — Git

```
GitTab mounts
   │  useEffect [cwd] → GET /api/git/status
   │                       → { ok, branch, files: [{ path, status, staged }, ...] }
   ▼
   rendered file list (left)
   │
   │  user clicks file P
   ▼
   useGitDiff(cwd, P)
   │  GET /api/git/diff?path=P
   │      → if status === '??': server runs `git diff --no-color --no-index /dev/null <abs>`
   │        else: server runs `git diff --no-color HEAD -- <abs>`
   │      → { ok, diff, isUntracked }
   ▼
   renders DiffBlock-style line-by-line (right) — reuse `computeLineDiff` only
   for the third pre-existing DiffBlock UI; here we render raw diff text with
   line-prefix coloring (see Rendering note below).
```

### Tab 2 — Files

```
FsTab mounts
   │  useEffect [cwd] → GET /api/fs/list?dir=
   │                       → { ok, entries: [{ name, path, type, size }] }
   ▼
   rendered AntD Tree (left), default-expand-all-1-level
   │
   │  user clicks leaf file F
   ▼
   useFsFile(cwd, F)
   │  GET /api/fs/file?path=F
   │      → { ok, content, name, size, mtime }
   ▼
   renders <pre> + line numbers (right)
```

### CWD-driven refresh

Both tabs subscribe to `useSessionCwd(sessionId)`. When `cwd` changes:

1. Reset internal selection (`selectedPath = null`).
2. Re-fetch top-level data (`status` / `fs/list` for `dir=""`).
3. Right column shows an `Empty` "选择左侧项目查看" until the user clicks.

This avoids stale results when the user `cd`s mid-session and reuses the
existing SSE-fed hook — no new watcher code is introduced.

### State persistence

| Key | Type | Default | Behavior |
|-----|------|---------|----------|
| `zai.splitPane.open` | `'1'` / `'0'` | `'0'` | `useState` initialized from localStorage on mount, written on toggle. |
| `zai.splitPane.tab` | `'git' \| 'fs' \| 'tbd'` | `'git'` | Same. Written on tab change. |
| `zai.splitPane.width` | numeric px (320-720) | `480` | Set by splitter drag handle. Restored on next open. |

A `useEffect` adds the storage keys on first mount if missing (write
defaults on first open). No SSR — values read with `useState(() => read())`
in a `useEffect`-guarded initializer to avoid hydration mismatch (not
applicable here, but we still guard for future SSR).

## UI Behavior

### Toggle button

- **Location**: top of the existing left sidebar in `Agent.tsx`, immediately
  below the `+ N fold` cluster. Mirrors the visual style of the existing
  icon buttons (`MenuFoldOutlined` / `MenuUnfoldOutlined` equivalents).
- **Icon**: use AntD `SidebarRightOutlined` (closed → `BorderOutlined` or
  `PicCenterOutlined` open visual) — the existing `MenuFold/Unfold` style
  is reserved for the session sidebar.
- **Title**: "切换右侧分屏" / "Toggle split-pane".

### When closed

- No width is consumed. The flex layout `messages` column gets `flex: 1`
  and the panel column has `width: 0` (or is `display: none` for cleaner
  paint). Padding transitions smoothly with `transition: width 0.2s`.

### When open

- Width follows `zai.splitPane.width` (default 480px, range 320–720).
- Column split inside the panel: 40% list / 60% detail (`flex: 0.4` /
  `flex: 0.6`).
- Splitter handle: 6px wide, draggable, hover-highlights; doubles as a
  hit target so users on touchpads can resize.
- Tabs are AntD `Tabs` with `tabBarGutter: 8`, sticky inside the panel
  header, dark-tab style consistent with `TaskDrawer`.

### Responsive collapse

- Window width `< 1024px` → panel auto-closes (no manual override). When
  the user expands past 1024px it stays closed unless previously opened —
  we do not auto-reopen. Toggle button still works; the button itself is
  not hidden on small screens because `messages` flex handles overflow
  gracefully.

### Rendering notes

- **Git diff render** — the existing `DiffBlock.tsx` (line-by-line colored
  rows produced by `computeLineDiff`) is built for synthetic Edit/Write
  inputs. For real `git diff` output we render a new component:
  - Parse unified diff line by line (`+++`, `---`, `@@`, `+`, `-`, ` `
    prefixes) — reuse colors from `DiffBlock.tsx` (`ADD_BG`, `DEL_BG`,
    `ADD_FG`, `DEL_FG`).
  - Display in the same `<pre>` + gutter style so the visual language is
    consistent.
  - File headers (`diff --git a/... b/...`) are folded into a smaller
    label above each hunk.
- **File preview render** — `<pre>` with monospace font (same
  `CODE_FONT_FAMILY` as TaskDrawer), `<SyntaxHighlighter>` from
  `react-syntax-highlighter` reused if extension is in the supported set.
  Otherwise plain `<pre>`.

## API Specification

### `GET /api/git/status`

- **Response 200**

  ```jsonc
  {
    "ok": true,
    "branch": "feat/split-pane",
    "files": [
      { "path": "packages/zai/src/web/src/pages/Agent.tsx", "status": "M", "staged": false },
      { "path": "docs/notes.md",                            "status": "??", "staged": false }
    ]
  }
  ```

- **Response (not a git repo)** — 200 with `ok: false`:

  ```json
  { "ok": false, "error": "not a git repository" }
  ```

- **Implementation**:

  ```ts
  execFile('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ctx.cwd, timeout: 3000 })
    → if throws, return { ok: false, error: 'not a git repository' }
  execFile('git', ['status', '--porcelain=v1', '-u', 'normal'], { cwd: ctx.cwd, timeout: 5000 })
    → parse lines, two-char prefix maps to { M, A, D, ??, MM, AM, ... }
  execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 3000 }) → branch
  ```

- **`status` mapping** (first char = staged, second = unstaged; we report
  the unstaged char unless both are absent, in which case the staged char):

  | porcelain | reported status |
  |-----------|-----------------|
  | `??` | `??` (untracked) |
  | ` M` / ` M` | `M` |
  | `M ` / `MM` / `AM` | `M` (staged) |
  | `A ` / `AM` | `A` |
  | `D ` / `DM` | `D` |

### `GET /api/git/diff?path=<rel>`

- **Query**: `path` is a path **relative to cwd**, mandatory.
- **Validation**: `path` resolved via `path.resolve(cwd, path)`. Result must
  `startsWith(cwd)`. If not, 400.
- **Logic**:
  1. `git diff --no-color HEAD -- <rel>` for tracked files.
  2. For untracked (`status == '??'`): `git diff --no-color --no-index /dev/null <abs>` and trim the
     first two header lines (`diff --git` + `new file mode`) so the
     unified header matches.
- **Response 200**

  ```json
  { "ok": true, "diff": "diff --git a/foo.ts b/foo.ts\n...", "isUntracked": false }
  ```

- **Size cap**: `diff.length` > 2 MB → 200 with `{ ok: false, error: "diff too large (X MB)" }`.
- **Timeout**: 5s on each git invocation. On timeout, 200 with `{ ok: false, error: "git command timeout" }`.

### `GET /api/fs/list?dir=<rel>`

- **Query**: `dir` is a path relative to cwd, default `''` (cwd root).
- **Validation**: `path.resolve(cwd, dir)` must `startsWith(cwd)` and the
  resulting directory must exist. **No depth cap** — any directory
  reachable under cwd can be listed. Children are fetched lazily by the
  client on expand, so the server does not need to limit recursion.
- **Filter**: skip `node_modules`, `.git`, `.next`, `dist`, `build`,
  `.cache`, `.DS_Store`, plus any directory starting with `.` beyond depth 1
  (so `.claude`, `.config` are still visible).
- **Sorting**: directories first, then files; alphabetical within each.
- **Response 200**

  ```json
  {
    "ok": true,
    "entries": [
      { "name": "packages",   "path": "packages",          "type": "dir",  "size": null },
      { "name": "README.md",  "path": "README.md",         "type": "file", "size": 4321 }
    ]
  }
  ```

- **Errors**: 400 on bad path / 404 on missing dir / 403 on escape.

### `GET /api/fs/file?path=<rel>`

- **Query**: `path` is a path relative to cwd.
- **Validation**:
  1. `path.resolve(cwd, path)` must `startsWith(cwd)`.
  2. Extension must be in `TEXT_EXTS` (reuse the constant from `dirs.ts` —
    extract to `shared/fsGuards.ts` or copy with a comment that
    `dirs.ts` is the source of truth for now).
  3. `stat.size <= MAX_FILE_BYTES (2 MB)`.
- **Response 200**

  ```json
  { "ok": true, "path": "...", "name": "...", "size": 4321, "mtime": "ISO", "content": "..." }
  ```

- **Errors**: 400 / 403 / 404 / 413 / 415 with human messages mirroring
  `dirs.ts`.

### Shared safety helper

Extract a small util in `packages/zai/src/server/utils/safePath.ts`:

```ts
// Resolve `rel` under `root` and ensure the result stays inside root.
// Used by both git.ts and fs.ts — they're both read-only filesystem
// surfaces and share the same threat model.
export function resolveSafePath(root: string, rel: string): { ok: true; abs: string } | { ok: false; error: string }
```

`git.ts` uses it for both `path` query parameters; `fs.ts` uses it for
`dir` and `path`. Both reject symlinks that resolve outside root.

## Security

- **Command injection**: git invocations use `execFile` with argument
  arrays — no shell, no string interpolation. Already the pattern in
  `system.ts`.
- **Path traversal**: `resolveSafePath` is the single entry point; both
  endpoints refuse any path that escapes cwd.
- **Resource exhaustion**: 2 MB cap on diff / file reads; directory
  listing has no depth cap because the client fetches one level per
  expand (bounded by user clicks, not by traversal).
- **Process isolation**: read-only endpoints — they cannot modify git
  state (`diff`, `status`, `rev-parse`, `ls-files` only) or filesystem
  state (`readdir`, `stat`, `readFile` only).
- **No new auth**: matches existing `createApp` policy (local tool,
  no token).
- **No new SSE channel**: data is fetched on demand, so we don't widen
  the SSE event surface.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| cwd is not a git repo | `/git/status` returns `{ok:false, error:'not a git repository'}`. Tab shows `Empty description={error}`. Tab 2 still works because it doesn't depend on git. |
| Single file diff > 2 MB | Backend returns `{ok:false, error}`. Detail panel shows `Empty description={error}`. |
| File > 2 MB on preview | Backend 413. UI: `Empty description="文件过大 (X MB)，暂不支持预览"`. |
| Binary file | Backend 415. UI: `Empty description="二进制文件不支持预览"`. Tree still shows the entry; user can see name + size but no preview. |
| File deleted between list and read | Backend 404. UI: `Empty description="文件不存在"`. Tab allows retry via refresh button. |
| Permission denied | Backend 403 with message. UI shows message in `Empty`. |
| Manual refresh button | Each tab has a "刷新" button in its top-right corner calling `refetch()`. Disabled while a fetch is in flight. |

## Testing Strategy

### Backend

- **`routes/git.test.ts`** — set up fixtures in a tmpdir per-test:
  - `plain.txt`, `tracked-but-modified.ts`, `untracked.md`, `staged.ts`,
    `deleted.ts`, `dir/file.ts`.
  - Run `git init`, `git add .`, `git commit -m init`.
  - Modify / add / delete fixtures.
  - Hit `/api/git/status` → assert exact list with statuses.
  - Hit `/api/git/diff?path=untracked.md` → assert `isUntracked: true`
    and that the diff has a `+` for every line.
  - Hit `/api/git/diff?path=../outside` → 400 or `{ok:false}`.
- **`routes/fs.test.ts`** — fixtures nested ≥ 4 deep, files of supported
  and unsupported extensions, binary, oversized. Assert:
  - `/fs/list?dir=` returns top-level + ignores `node_modules`.
  - `/fs/list?dir=a/b/c/d` returns the children at depth 4 (no depth cap
    — lazy loading is the client's responsibility, server returns the
    requested level).
  - `/fs/file?path=a/b.ts` returns content.
  - `/fs/file?path=../../../etc/passwd` returns 403.
  - Oversized file returns 413.

### Frontend (vitest + happy-dom)

- **`SplitPane.test.tsx`**: stub `localStorage`, render, assert default
  closed; click toggle → opens; closed → writes `'0'`; writes tab key
  on tab change.
- **`GitTab.test.tsx`**: stub `api.get` for status & diff. Click first
  row → asserts `api.get('/api/git/diff?path=...')` called.
- **`FsTab.test.tsx`**: stub list & file. Render tree → click leaf →
  asserts preview content displayed.

### Manual verification checklist

Listed in the implementation plan; covers (a) non-git cwd, (b) git diff
huge file, (c) untracked binary, (d) very deep directory, (e) window
resize under 1024px.

## Open Issues (resolved during brainstorming)

1. ~~Which git baseline?~~ → Resolved: status --porcelain, include
   untracked; diff uses `git diff --no-index` for untracked.
2. ~~Where does Files TAB browse?~~ → Resolved: cwd-rooted tree.
3. ~~Drawer vs. true split-pane?~~ → Resolved: true split-pane; localStorage.
4. ~~Third TAB purpose?~~ → Resolved: placeholder.
5. ~~Reuse Bash tool vs. new backend routes?~~ → Resolved: new routes.

## Risks

- **Polling risk** — git status on huge repos (~100k files) can be slow.
  Mitigation: 5s timeout on `git status`; UI shows `Spin` while loading.
- **Large diff risk** — even if `git diff` exits within the timeout,
  the response body can be 1.5 MB → buffer exhaustion. Mitigation: size
  cap returns 200 with `{ok:false}` instead of streaming.
- **Path-encoding risk** — Windows paths with backslashes aren't allowed
  by the resolveSafePath helper (cwd is always POSIX-style on darwin/linux;
  Windows hosts can be revisited if needed — currently out of scope).
- **CWD race** — if the user `cd`s while a fetch is in flight, results
  may be stale. Mitigation: `useEffect [cwd]` cancels the prior request
  via an AbortController (mirror `useSessionCwd`).
- **SESSION scope** — this panel is per-tab session, not shared across
  tabs of the same session. Spec'd behavior; revisit if users complain.

## Phasing (informational)

This feature is delivered in a single iteration. No multi-stage plan
needed. The "third tab" placeholder reserves a slot but ships no
behavior.
