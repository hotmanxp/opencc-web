# zai Files 视图内容搜索(content search, ripgrep 后端) — 设计文档

> **状态**: Draft(待 review)
> **作者**: brainstorming session (2026-07-27)
> **目标分支**: `feat/fs-content-search`(基于 `main`)
> **前置 spec**: `docs/superpowers/specs/2026-07-25-zai-files-search-design.md`(文件名 fuzzy 搜索)

## 1. 背景与目标

zai 的 Files 视图(`packages/zai/src/web/src/components/splitPane/FsTab.tsx`)当前已在头部提供"文件名 fuzzy 搜索"(`useFsSearch` + `FsSearchList`,2026-07-25 spec)。该搜索仅匹配**文件名 / 路径**,不查文件**内容**。

项目已有 ripgrep vendor 路径(`packages/zai-agent-core/vendor/ripgrep/`)+ 完整 `GrepTool` 封装(`packages/zai-agent-core/src/tools/GrepTool/GrepTool.ts`)。但当前 ripgrep 只服务 Agent 工具调用,前端 UI 层没有"独立 grep"能力 — 用户不能像在 IDE 里那样按关键字搜代码内容并跳到行。

**目标**: 在 FsTab 头部搜索 `<Input>` 旁加一个 antd `<Switch>`,切换"文件名" / "内容"两种搜索模式;切到"内容"模式时复用 vendor ripgrep 做全文搜索,结果列表 + 点击跳到右侧预览并高亮命中行。

## 2. 范围

### 范围内
- 复用 vendor ripgrep(`GrepTool.ts:304-348` 的路径解析 + spawn)抽成 server service。
- 新增 `GET /api/fs/content-search?q=&path=&headLimit=` 端点。
- 新增 `useFsContentSearch` hook + `FsContentSearchList` 组件。
- FsTab 头部 `<Input>` 旁新增 antd `<Switch>`,切换 `mode: 'name' | 'content'`。
- 行点击跳到右侧 `FilePreview`,定位行 + 临时高亮 2s。
- 子串 + case-insensitive(ripgrep `-i` 默认)。
- 后端过滤:VCS 目录、二进制 glob、2MB 单文件上限。
- 截断 / abort / timeout 三道防线。
- 全套测试:后端 route、ripgrep service、前端 hook、列表组件、FsTab 集成。

### 不做(YAGNI)
- ❌ Regex / case-sensitive toggle / glob / context lines / `-A`/`-B` — 留给后续
- ❌ SSE 流式输出(ripgrep 一次性返回)
- ❌ in-file highlight(CodeMirror / preview 高亮已能复用,本次只跳首个匹配)
- ❌ 跨 session 持久化、history、recent searches
- ❌ Linux x64 等无 vendor 的平台上的纯 JS fallback — 直接返回 "ripgrep 不可用"
- ❌ ⌘P / ⌘F 快捷键
- ❌ 在内容搜索结果上继续点击同文件不同命中行(本次:每文件一行入口,跳到首个匹配)

## 3. 架构

### 3.1 文件清单

| 路径 | 类型 | 作用 |
|------|------|------|
| `packages/zai/src/server/services/ripgrep.ts` | 新增 | 抽 `resolveRgPath()` + `runRipgrep(args, opts)` 纯函数 |
| `packages/zai/src/server/services/ripgrep.test.ts` | 新增 | service 单测(fake rg stub) |
| `packages/zai/src/server/routes/fs.ts` | 修改 | 新增 `GET /fs/content-search` handler |
| `packages/zai/src/server/routes/fs.content-search.test.ts` | 新增 | vitest route 单测 |
| `packages/zai/src/shared/fs.ts` | 修改 | 新增 `FsContentSearchEntry` / `FsContentSearchResult` 类型 |
| `packages/zai/src/web/src/components/splitPane/useFsContentSearch.ts` | 新增 | hook(debounce + seqRef + AbortController + `enabled`) |
| `packages/zai/src/web/src/components/splitPane/useFsContentSearch.test.tsx` | 新增 | hook 单测 |
| `packages/zai/src/web/src/components/splitPane/FsContentSearchList.tsx` | 新增 | 结果列表(行 = `path:line preview`) |
| `packages/zai/src/web/src/components/splitPane/FsContentSearchList.test.tsx` | 新增 | 列表组件单测 |
| `packages/zai/src/web/src/components/splitPane/FsTab.tsx` | 修改 | header 加 `<Switch>` + mode state + 行点击透传 line + FilePreview 加 highlight |
| `packages/zai/src/web/src/components/splitPane/FsTab.test.tsx` | 修改 | 新增 Switch 切换 / 行点击跳 preview / highlight 集成测试 |
| `test/fixtures/rg-stub.js` | 新增 | 测试用 fake ripgrep(模拟 `--json` 输出 + 延迟 + abort) |

**未改动**:`GrepTool.ts`(本次只抽 service,不改 Agent 工具调用层)、`useFsSearch.ts`(保持原样)、`FsSearchList.tsx`(保持原样)。

### 3.2 数据流

```
用户切 Switch 到"内容"模式 + 输入 "TODO"
  │ (200ms debounce + enabled gate)
  ▼
useFsContentSearch({ cwd, query, enabled: mode === 'content' })
  │ GET /api/fs/content-search?q=TODO[&path=<cwd>][&headLimit=200]
  │ AbortController + seqRef 守护
  ▼
fsRouter GET /fs/content-search
  ├─ resolveSafePath(cwd, '')              ← 强制 start=cwd,不允许越界
  ├─ 参数校验:q 非空、≤ MAX_QUERY_LEN=64
  ├─ services/ripgrep.runRipgrep([
  │     '--json', '-n', '-i',
  │     '--max-filesize', '2M',
  │     '--glob', '!*.{png,jpg,...}',      ← 二进制 glob
  │     '--glob', '!.git', '--glob', '!node_modules', ...
  │     '-e', q,
  │     searchRoot                          ← cwd 的绝对路径
  │   ], { cwd, signal, timeoutMs: 10000 })
  ├─ 逐行解析 --json: type='match' 取
  │     { path: data.path.text,
  │       line: data.line_number,
  │       text: data.lines.text.trimEnd(),
  │       submatch: { text: data.submatches[0].match.text,
  │                   start: data.submatches[0].start,
  │                   end:   data.submatches[0].end } }
  ├─ path.relative(searchRoot, abs) → POSIX 化
  ├─ 按 path 聚合 matches: Map<path, FsContentSearchEntry>
  ├─ 排序:命中行数 desc, path asc
  ├─ 截断:headLimit=200 → truncated:true
  └─ Race:timeout / AbortController / rg code=2(errno 11 重试单线程)后兜底返回 partial
  ▼
FsContentSearchList.render(entries)
  ├─ 行:path:line  preview    (submatch 黄色高亮)
  └─ onSelect(path, line)
       ├─ setSelected(path)             ← 已有的 state setter
       └─ setPendingLine(line)          ← 新增,FsTab 局部 state
  ▼
FilePreview(pendingLine)
  └─ useEffect([pendingLine, file.data?.content])
       ├─ 等 file.data.kind === 'text' && content 就绪
       ├─ 找 <span data-line={pendingLine}> (FilePreview 渲染时每行包一层)
       ├─ el.scrollIntoView({ block: 'center', behavior: 'smooth' })
       ├─ 加 class 'fs-line-highlight'  ← 黄色背景
       └─ 2000ms 后移除 class(cleanup 内 setTimeout)
```

### 3.3 复用点

- **ripgrep 路径解析**:`GrepTool.ts:304-348` 的 `resolveRgPathVendor / resolveRgPathSystem / resolveAllRgPaths`,直接搬运到 `services/ripgrep.ts`。
- **spawn**:`GrepTool.ts:223-302` 的 `spawnOnce` 抽成 `runRipgrep` 纯函数,移除 ToolContext 依赖。
- **Schema 风格**:与 `FsSearchResult` / `FsSearchEntry`(`shared/fs.ts:49-68`)对齐,新类型放同一文件,导出给 server + web 共享。
- **Hook 模板**:`useFsSearch.ts`(debounce 200ms + seqRef + AbortController)整体复用,只加 `enabled` 参数。
- **文件预览**:不动 `useFsFile`,只给 `FilePreview` 加可选 `pendingLine` prop(默认 null 保持向后兼容)。
- **安全**:`resolveSafePath`(`packages/zai/src/server/utils/safePath.ts`)复用,不允许 path 参数越界。
- **CSS**:复用 `MONO` + `rgba(255,255,255,*)` 现有色阶,新加 `.fs-line-highlight` 用 `rgba(255,200,0,0.3)` 黄色背景 + `transition: background 0.3s`。

### 3.4 关键设计取舍

| 抉择 | 选择 | 理由 |
|---|---|---|
| ripgrep 输出格式 | `--json` | 每命中一行 JSON object,前端无需解析 ripgrep 自定义格式,字段自描述 |
| Switch vs Segmented | Switch | 用户明确选择 antd Switch + 二态语义;`checkedChildren/unCheckedChildren` 显示"内容/文件名"足够清楚 |
| ripgrep 不存在时降级 | 不做 fallback,返回 ok:false | 避免重复实现,YAGNI;Linux x64 等小众场景 UI 明确提示不可用 |
| 行点击跳多少行 | 每文件首个匹配 | 单 path 单行入口最简洁;同文件多命中行高亮由 preview 已有 keyword highlight 处理 |
| 是否走 store | 不走,组件局部 state | `mode` / `pendingLine` 与 `query` / `selected` 同样生命周期,无跨组件共享需求 |
| hook `enabled` 参数 | 必须 | 切到 name 模式立即 abort inflight fetch,避免双 hook 互相串扰 |

## 4. 关键设计细节

### 4.1 ripgrep 命令参数

```ts
const args = [
  '--json',                    // 输出 JSON 流
  '-n',                        // 行号
  '-i',                        // case-insensitive(默认)
  '--max-filesize', '2M',      // 单文件上限, 对齐 MAX_FILE_BYTES
  // 二进制 glob(与 fs.ts TEXT_EXTS 反集对齐):
  '--glob', '!*.{png,jpg,jpeg,gif,webp,ico,pdf,zip,tar,gz,wasm,mp3,mp4,avi,mov,ogg,flac,ttf,otf,eot,bin,exe,so,dll,class,o,obj}',
  // VCS / 依赖:
  '--glob', '!{.git,.svn,.hg,.bzr,.jj,.sl}',
  '--glob', '!{node_modules,dist,build,coverage,.next,.turbo,.cache}',
  // VCS 来自 GrepTool.VCS_DIRECTORIES_TO_EXCLUDE
  // 其它来自 fs.ts IGNORED
  '-e', q,
  searchRoot,
];
```

### 4.2 `services/ripgrep.ts` API

```ts
export type RunRipgrepOptions = {
  cwd: string;          // ripgrep 进程的 cwd(影响 VCS 跳过)
  signal?: AbortSignal;
  timeoutMs?: number;   // 默认 10000
};

export type SpawnResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: NodeJS.ErrnoException;
};

export class RipgrepUnavailableError extends Error {}

export function resolveRgPath(): { rgPath: string; mode: 'vendor' | 'system' } | null;

export async function runRipgrep(
  args: string[],
  opts: RunRipgrepOptions,
): Promise<SpawnResult>;
```

- `resolveRgPath()`:先 vendor,再 system,合并为列表;调用方循环尝试(与 `GrepTool.runRipgrepWithFallback` 同语义,本次不抽出循环,留给调用方)。
- `runRipgrep()`:`spawn(rg, args, { cwd, signal, timeout, killSignal:'SIGKILL' })`,监听 stdout/stderr,超发 SIGTERM → 5s 后 SIGKILL;settled guard 防重复 resolve。
- **errno 11 重试语义**:`/fs/content-search` handler 内做,**最多一次**单线程重试(`-j 1`);两次都失败才返回 ok:false。`runRipgrep` 本身不重试,只暴露 `result.code` + `result.stderr` 给调用方判断。

### 4.3 route handler 错误矩阵

| 场景 | 状态 | body |
|---|---|---|
| 缺 `q` 或 `q=''` | 400 | `{ ok:false, error:'缺少 q 参数' }` |
| `q.length > 64` | 400 | `{ ok:false, error:'q 太长 (>64)' }` |
| `path` 越界 | 403 | `{ ok:false, error: <resolveSafePath 错误> }` |
| `resolveRgPath()` 全 null | 200 | `{ ok:false, error:'ripgrep 未安装,内容搜索不可用' }` |
| ripgrep code=2 + non-abort | 200 | `{ ok:false, error:'search 失败: <stderr>' }` |
| ripgrep code=1(no match) | 200 | `{ ok:true, entries:[] }` |
| abort / timeout | 200 | `{ ok:true, entries:[...partial], truncated:true }` |
| 异常 | 500 | `{ ok:false, error:'search 失败: <msg>' }` |

**约定**:沿用 `/fs/search` 的 "200 + ok:false" 语义 — 调用方只需看 `ok` 字段,无需分别处理 status code。

### 4.4 schema

```ts
// packages/zai/src/shared/fs.ts (追加)

export interface FsContentSearchSubmatch {
  /** 命中的子串原文(大小写与原文一致)。 */
  text: string;
  /** 0-based column offset (UTF-8 字节,与 ripgrep JSON 一致)。 */
  start: number;
  /** 排除性 end column。 */
  end: number;
}

export interface FsContentSearchMatch {
  /** 1-based line number。 */
  line: number;
  /** 完整行文本(去尾换行,前导空白保留)。 */
  text: string;
  /** 第一个 submatch(当前 ripgrep 调用固定返回单 submatch)。 */
  submatch: FsContentSearchSubmatch;
}

export interface FsContentSearchEntry {
  /** 相对 cwd 的 POSIX 路径。 */
  path: string;
  /** basename。 */
  name: string;
  /** 该文件的所有命中行(默认只展示首个,排序由 server 完成)。 */
  matches: FsContentSearchMatch[];
}

export interface FsContentSearchResult {
  ok: boolean;
  error?: string;
  entries?: FsContentSearchEntry[];
  /** 命中数超过 headLimit 或超时截断。 */
  truncated?: boolean;
  /** server 端耗时 ms。 */
  durationMs?: number;
}
```

### 4.5 useFsContentSearch

```ts
// packages/zai/src/web/src/components/splitPane/useFsContentSearch.ts

export interface UseFsContentSearchOptions {
  /** false 时不发送请求并 abort inflight。 */
  enabled?: boolean;
  /** 覆盖默认 headLimit(默认 200)。 */
  headLimit?: number;
}

export interface UseFsContentSearchResult {
  data: FsContentSearchResult | null;
  loading: boolean;
  error: string | null;
  durationMs: number | null;
}

export function useFsContentSearch(
  cwd: string | null,
  query: string,
  options: UseFsContentSearchOptions = {},
): UseFsContentSearchResult;
```

行为:
- `enabled=false` 或 `cwd=null` 或 `query.trim()=''` → 立即返回 `{ data:null, loading:false, error:null, durationMs:null }`,**不发请求且 abort 任何 inflight**(与 `useFsSearch` 模板的关键差异:`useFsSearch` 没有 enabled gate,`useFsContentSearch` 必须 abort inflight)。
- 200ms debounce + seqRef + AbortController(模板与 `useFsSearch.ts` 一致)。
- `headLimit` 通过 query string `&headLimit=<n>` 透传给 server。
- 卸载 / cwd 变 / query 变 / enabled 变 → cleanup 中 `clearTimeout` + `ac.abort()`,避免 inflight 串到下一个 query。

### 4.6 FsContentSearchList

Props:
```ts
export interface FsContentSearchListProps {
  entries: FsContentSearchEntry[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
  query: string;
  onSelect: (path: string, line: number) => void;
}
```

渲染:
- 空 query → `<div data-testid="fs-content-empty-query" />`(占位,正常 FsTab 不会进入此分支)。
- loading + entries=[] → `<Spin />`(`data-testid="fs-content-loading"`)。
- error → `<Empty description={error} />`(`data-testid="fs-content-error"`)。
- entries=[] → `<Empty description={`无内容匹配: "${query.trim()}"`} />`(`data-testid="fs-content-empty"`)。
- entries → 列表:
  ```
  ┌─────────────────────────────────────────────────────┐
  │ src/server/foo.ts:42    // TODO: refactor this      │ ← onSelect(path, 42)
  │ src/server/bar.ts:17    const TODO_LIST = []        │
  │ src/web/components/X.tsx:103   // see TODO above    │
  │ ...                                                  │
  │ (结果已截断,继续输入以收窄范围)                       │
  └─────────────────────────────────────────────────────┘
  ```
- 每行:`path:line` 用 mono 小字 11px + 灰,`text` 用 mono 12px + 高亮 submatch(黄色背景 `rgba(255,200,0,0.4)`)。
- 复用 `findMatchIndices`(`FsSearchList.tsx:20-33`)思路,但改为 byte offset → 列渲染(用 `<span>` 分段,不依赖 DOM text node;offset 由 server 提供)。

### 4.7 FsTab 修改

```tsx
// FsTab.tsx (新增 state + 修改 render)

const [mode, setMode] = useState<'name' | 'content'>('name');
const contentSearch = useFsContentSearch(
  cwd,
  query,
  { enabled: mode === 'content' },
);
const [pendingLine, setPendingLine] = useState<number | null>(null);

// cwd reset 时:
useEffect(() => {
  setSelected(null);
  setExpandedKeys([]);
  setLoaded({});
  setContextMenu(null);
  setQuery('');
  setMode('name');                       // ← 新增
  setPendingLine(null);                  // ← 新增
  setEditingPath(null);
  setDirtyPaths(new Set());
}, [cwd]);

// header:
<Input ... />
<Switch
  size="small"
  data-testid="fs-search-mode"
  checked={mode === 'content'}
  onChange={(v) => setMode(v ? 'content' : 'name')}
  checkedChildren="内容"
  unCheckedChildren="文件名"
/>
{showHtmlToggle && <Segmented ... />}

// 左栏列表:
{query.trim().length > 0 ? (
  mode === 'content' ? (
    <FsContentSearchList
      entries={contentSearch.data?.entries ?? []}
      loading={contentSearch.loading}
      error={contentSearch.error}
      truncated={contentSearch.data?.truncated ?? false}
      query={query}
      onSelect={(p, l) => { setSelected(p); setPendingLine(l); }}
    />
  ) : (
    <FsSearchList
      entries={search.data?.entries ?? []}
      loading={search.loading}
      error={search.error}
      truncated={search.data?.truncated ?? false}
      query={query}
      onSelect={(p) => setSelected(p)}
    />
  )
) : /* 树形分支,不变 */}

// 右栏 preview:
<FilePreview file={file.data} htmlMode={htmlMode} pendingLine={pendingLine} />
```

`FilePreview`(FsTab.tsx:223-383 内嵌)新增可选 `pendingLine?: number | null` prop。文本 kind 时:
- 渲染每行包 `<span data-line={n}>`(n=1-based)。
- `useEffect([pendingLine, file.content])`:等待 content 就绪 → 找 `[data-line="<pendingLine>"]` → `scrollIntoView({block:'center',behavior:'smooth'})` → 加 `.fs-line-highlight` class → setTimeout 2000ms 移除。cleanup 内 clearTimeout 防 unmount 后操作。

### 4.8 CSS

**决策**:走内联 style 而非新建 `.css` 文件 — FsTab 现有 header / 列表 / preview 全部内联 style(`rgba(255,255,255,*)` 直接写),与现有风格一致,不引入额外的样式文件加载路径。

FilePreview 渲染时给 `<span data-line={n}>` 加内联 `style={{ background: 'rgba(255,200,0,0.3)', transition: 'background 0.3s' }}`,2s 后 setState 移除该 prop。

## 5. 关键场景

### 场景 1:基础流
输入 "TODO" + 切到"内容" → 200ms debounce → ripgrep → 结果列表 → 点 `foo.ts:42` → 右侧 preview 加载 → 滚到 line 42 → 黄底闪烁 2s。

### 场景 2:Switch 切换不停输入
打 "T" → 切到内容模式 → 立刻看到 T 命中 → 切回文件名模式 → abort inflight → 输入 "Todo" → fuzzy 文件名命中。`useFsContentSearch` `enabled=false` 时 abort。

### 场景 3:大仓库截断
ripgrep 完成但命中 > 200 → server 截断 + `truncated:true` → UI 显示 "结果已截断,继续输入以收窄范围"。

### 场景 4:二进制 / 大文件
ripgrep `--glob` + `--max-filesize` 过滤,server 拿不到命中 → 空 entries + ok:true。无需特殊 UI。

### 场景 5:无 ripgrep
`resolveRgPath()` null → server 200 + ok:false + "ripgrep 未安装" → 列表组件 error 槽显示 `<Empty>` 红字。

### 场景 6:cwd 切换
`useEffect([cwd])` reset `mode='name'` + `pendingLine=null`,`useFsContentSearch` 因 cwd 变 abort + 重拉(但因 mode 已被 reset 为 name,enabled=false,不再发请求)。

### 场景 7:Abort
快速打字 / 切 mode / 切 cwd / 卸载,统一走 `useFsContentSearch` 内 `ac.abort()`,server handler 收 SIGTERM → cleanup。

### 场景 8:行号超界
ripgrep 返回 line=9999,但文件实际只 100 行(搜索后文件被改)→ preview useEffect 找不到 `[data-line="9999"]` → silently no-op,不抛错。

## 6. 已知薄弱点

- `GrepTool.ts` 的 ripgrep 路径解析仍与 `services/ripgrep.ts` 重复 — 本期不重构 GrepTool,后续可统一。
- `FilePreview` 行号定位依赖 `<span data-line>` 包裹;若 preview 改成 CodeMirror 渲染,定位逻辑要切换到 CodeMirror `doc.line(line).handleDOMPos`(留 TODO,不阻塞本期)。
- `path` 参数透传给 ripgrep 但**永远不允许越界**(`resolveSafePath` 强制限定为 cwd 子路径),因此 UI 上不需要暴露 path 输入框 — 当前只有 searchRoot 隐式 = cwd。
- ripgrep vendor 平台只覆盖 darwin + win32;Linux x64 / arm64 用户需 `rg` 装系统路径 — UI 给出明确"不可用"提示,不静默失败。
- 内容搜索不做正则 / case-sensitive toggle — 用户明确选择 YAGNI,后续可加 antd Popover 放 advanced toggles。

## 7. 测试矩阵

| 文件 | 用例 |
|---|---|
| `services/ripgrep.test.ts` | resolveRgPath 优先 vendor;spawn 正常 / SIGTERM abort / 超时 EAGAIN errno 11 |
| `routes/fs.content-search.test.ts` | happy path;空 q 400;q 过长 400;path 越界 403;rg 不存在 200 ok:false;truncated;abort;二进制 glob 过滤;相对路径 |
| `useFsContentSearch.test.tsx` | debounce;stale 覆盖;abort;enabled=false 不发请求;empty query 不发请求 |
| `FsContentSearchList.test.tsx` | 空 / 加载 / 错误 / 空结果 / 命中渲染 / 行点击透传 path+line / truncated tail |
| `FsTab.test.tsx`(新增) | Switch 默认 name;切到 content 后 useFsContentSearch 触发;切回 name abort;行点击 setSelected + setPendingLine;pendingLine 触发 preview 高亮;cwd 切换 reset mode + pendingLine |

## 8. 实施步骤(粗粒度)

1. 抽 `services/ripgrep.ts` + 单测(同时不破坏 GrepTool)
2. `shared/fs.ts` 加 schema 类型
3. `routes/fs.ts` 加 `/fs/content-search` handler + 单测
4. `useFsContentSearch.ts` + 单测
5. `FsContentSearchList.tsx` + 单测
6. `FsTab.tsx` 接 Switch + 接列表 + pendingLine + FilePreview 高亮
7. `FsTab.test.tsx` 集成测试
8. 跑 `pnpm -w test` 全套绿,跑 `pnpm -w typecheck`,跑 `pnpm -w lint`
9. 手动 smoke:开 dev server,Files tab → 切内容 → 输入 "TODO" → 看命中 → 点行 → 看 preview 高亮