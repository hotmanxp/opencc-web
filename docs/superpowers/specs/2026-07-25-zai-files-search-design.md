# zai Files 视图文件搜索功能 — 设计文档

> **状态**: Draft(待 review)
> **作者**: brainstorming session (2026-07-25)
> **目标分支**: `feat/files-search`(基于 `main`)
> **Worktree**: `.worktrees/files-search`

## 1. 背景与目标

zai 的 Files 视图(`packages/zai/src/web/src/components/splitPane/FsTab.tsx`)目前依赖按需展开的目录树 — 想预览一个深路径文件,必须手动一层层点。 当用户知道文件名(或片段)想直接跳到预览时,缺少 CLI 风格 `cmd+p` 文件跳转能力。

**目标**: 在 Files 视图顶部加一个搜索框,输入 fuzzy 文件名片段 → 显示 top 200 匹配 → 点击复用 **现有右侧 60% 预览**(`useFsFile`)。

## 2. 范围

### 范围内
- 单文件 fuzzy 文件名搜索(子序列,大小写不敏感)
- 复用 `useFsFile` + 右侧预览面板 — 0 重写
- 服务端新增 `GET /api/fs/search?q=<query>`
- 复用现有 `IGNORED` 列表 + 隐藏文件跳过策略
- 输入防抖 200ms,旧请求 `AbortController` 取消

### 不做(YAGNI)
- ❌ 全文内容 grep(VSCode 风格)— 留给后续
- ❌ 索引持久化 / sqlite / lsp — 留给后续
- ❌ `fd` / `rg` 二进制依赖 — MVP 不引入
- ❌ ⌘P 快捷键 — UI 阶段再说
- ❌ 文件内容预览内检索 — 留给后续
- ❌ sub-agent 上下文改变 cwd — 已记录的薄弱点,不在本设计修

## 3. 架构

### 3.1 新文件

| 路径 | 作用 |
|------|------|
| `packages/zai/src/shared/fs.ts` [扩展] | 加 `FsSearchResult` / `FsSearchEntry` 类型 |
| `packages/zai/src/server/routes/fs.ts` [扩展] | 加 `GET /fs/search` handler |
| `packages/zai/src/server/routes/fs.search.test.ts` [新增] | vitest supertest 单测 |
| `packages/zai/src/web/src/components/splitPane/useFsSearch.ts` [新增] | fetch + debounce + aborter hook |
| `packages/zai/src/web/src/components/splitPane/FsSearchList.tsx` [新增] | 结果列表 + 高亮(纯展示) |
| `packages/zai/src/web/src/components/splitPane/FsSearchList.test.tsx` [新增] | React Testing Library 单测 |
| `packages/zai/src/web/src/components/splitPane/FsTab.tsx` [改] | 头部加 `<Input>`;query=='' → 树;非空 → 结果列表 |

### 3.2 数据流

```
用户在 FsTab 头部 <Input> 输入 "foo"
  │ (200ms debounce)
  ▼
useFsSearch({ cwd, query })
  │ GET /api/fs/search?q=foo[&case=1][&limit=200]
  │ AbortController + seqRef 守护(只接受最新请求的响应)
  ▼
fsRouter GET /fs/search
  ├─ resolveSafePath(cwd, '')               ← 强制 start=cwd, 不接 dir/query.start 防越界
  ├─ IGNORED 复用 + depthOf()≥1 && name.startsWith('.') 跳过
  ├─ 异步 walk (BFS, Promise.allSettled(stat))
  ├─ 对每个 file path 跑 fuzzyMatch(query, path, caseSensitive)
  ├─ 取 score ≥ 0 的命中,按 score desc + 路径长度 + 字典序稳定排序
  ├─ 截 top MAX_RESULTS=200, 设 truncated 标志
  └─ Race:walk 超时 200ms 后强制 return partial(走 AbortController 取消后续 stat)
  ▼
FsSearchList.render(entries)
  ▼ 用户点击某行
  onSelect(entry.path)
  └─ setSelected(entry.path) — 已存在的 state setter, 复用 useFsFile + 右侧 60% 预览面板
```

### 3.3 复用点

- **预览逻辑**: 不动。`useFsFile(cwd, selected)` + `renderPreview(file.data)` 维持原状
- **安全**: `resolveSafePath`(`packages/zai/src/server/utils/safePath.ts`)已拒绝 `..`/NUL/UNC,直接复用
- **列表 schema**: 复用 `FsEntry`(name/path/type/size)无需新增基础类型
- **css 变量**: 复用 `MONO` 字体栈 与现有 `rgba(255,255,255,*)` 色阶

## 4. 关键设计

### 4.1 Fuzzy 匹配算法

子序列匹配(query 字符按顺序出现在 path 中),打分规则(高分胜出):

| 规则 | 分数增量 |
|------|---------|
| 连续匹配 1 段每字符 | +5 |
| 边界匹配(首字符,或前一个为 `/`/`-`/`_`/`.`) | +10 |
| 大小写精确匹配(逐字符驼峰/全大写对齐) | +8 |
| 末尾匹配(扩展名/文件名结尾) | +6 |
| 路径深度(段数) | -2/段(浅路径优先) |
| 路径总长 | -1/字符(短路径优先) |
| 不匹配 | 0 排除 |

最终 `score = Σ(规则增量) - 深度惩罚 - 长度惩罚`,**`score ≤ 0` 丢弃**。

大小写默认不敏感;`?case=1` 切敏感。

### 4.2 服务端约束

- **安全 start**:`resolveSafePath(cwd, '')` 只接受 start=cwd。**忽略** `dir` / `start` / `cwd` query 参数(强制设计集中化,不放开给前端)。这是有意的:防止后续被前端不小心注入 `dir=/etc`。
- **超时**:服务端 `walk` 用 `AbortController`,200ms 后 `controller.abort()`,已经遍历到的命中按 partial 返回 + `truncated:true`。
- **stat 容错**: 单文件 `stat()` 失败(EACCES / EPERM) → `Settled.rejected` 跳过,不影响整体。
- **上限**:`MAX_RESULTS = 200`。超限 `truncated:true` 提示前。
- **错误响应**: 复用现有 `{ ok:false, error }` 模式,与 `/fs/list` 对齐。

### 4.3 前端 UX

- **Input 位置**:FsTab 头部"Files + (按需加载)"那一行 — 改成搜索框(占满宽度) + 右上角保留"刷新"按钮
- **空 query**:显示原有树(`renderTree` 不变)
- **非空 query**:树位置渲染 `<FsSearchList>`,200ms 防抖,加载中显示 `Spin`
- **键盘**:
  - `↑`/`↓` 选中条目
  - `Enter` 选中并触发预览(同点击)
  - `Esc` 清空 input 回到树(本设计要求 — 不加 ⌘P 快捷键)
- **点击**: `setSelected(entry.path)` — 已存在的 state setter,**0 改预览**逻辑
- **高亮**:query 子序列字符在 path 上加 `<mark>` 黄色背景
- **不区分大小写** 默认。⌘/Ctrl 不参与大小写切换(暂不加,后续扩展)

## 5. 数据契约

### 5.1 `FsSearchEntry`(`packages/zai/src/shared/fs.ts` 新增)

```typescript
export interface FsSearchEntry {
  /** Path relative to cwd, joined with forward slashes. */
  path: string
  /** Basename — 用于 UI 渲染和 fuzzy 高亮定位。 */
  name: string
  type: 'file'
  /** Fuzzy match score (for debugging / 测试可见)。 */
  score: number
}

export interface FsSearchResult {
  ok: boolean
  error?: string
  entries?: FsSearchEntry[]
  /** True when hit count exceeded MAX_RESULTS or scan timed out. */
  truncated?: boolean
  /** Elapsed ms since walk started(可给前端做埋点)。 */
  durationMs?: number
}
```

### 5.2 HTTP API

`GET /api/fs/search?q=<query>[&case=1][&limit=200]`

| 状态 | 含义 |
|------|------|
| 200 | `{ ok:true, entries:[...], truncated?:bool, durationMs:number }` |
| 400 | `q` 空 / 过长(> 64 chars) → `{ ok:false, error }` |
| 500 | walk 整体抛非预期错误 → `{ ok:false, error }` |

### 5.3 `useFsSearch(cwd, query, options?)` Hook

```typescript
interface UseFsSearchResult {
  data: FsSearchResult | null
  loading: boolean
  error: string | null
  /** 最近一次成功响应的耗时 (ms). */
  durationMs: number | null
}
```

行为:
- `query.trim() === ''` → 立刻 `data = null`,**不发请求**
- `cwd` 为 `null` → `data = null`,loading=false
- 200ms 防抖(`setTimeout` + cleanup)
- `AbortController`: 旧请求在 query / cwd 变化时被 abort;响应阶段用 `seqRef` 与时序对比,陈旧请求 setState 全部 short-circuit

## 6. 错误处理

| 场景 | 服务端 | 前端 |
|------|------|------|
| `q` 缺/空 | `400 {error:'缺少 q 参数'}` | `error` state |
| `q` 长度 > 64 | `400 {error:'q 太长'}` | `error` state |
| walk 抛 EACCES(整体) | `200 {ok:true, entries:[], truncated:false}` | 空列表正常显示 |
| 单文件 stat 失败 | 跳过该文件 | (前端无感) |
| cwd 不存在 / 删除 | `200 {ok:true, entries:[], truncated:false}` | 空列表 |
| 网络中断 | (服务端无关)| `error` state + 旧结果保留 |
| 请求取消 | (服务端无关)| short-circuit |
| walk 超 200ms | `{truncated:true, entries: [...已扫到的]}` | UI 末尾追加"(结果已截断)"提示 |

## 7. 测试策略

### 7.1 服务端(`fs.search.test.ts`)

| 用例 | 断言 |
|------|------|
| 顶层 README 匹配 `q=readme` | 返回 `path:'README.md'`, score > 0 |
| 子序列匹配 `q=rb` 命中 `src/runbook.md` | 子序列 score > 0 |
| 大小写敏感模式 `?case=1` `q=README` 命中 `README.md`,`q=readme` 不命中 | |
| IGNORED:`q=node` 不命中 `node_modules/foo.js` | |
| 隐藏文件 + depth≥1:`./project` 工作目录下 `q=dot` 命中 `dir/.dotfile` (dir 顶层可见),`a/b/.dotfile` 跳过 | |
| NUL 越界 `?q=README%00` | 不命中(不抛)或拒绝 |
| 安全:`?dir=..` & `?start=/etc` 等参数被忽略(强制 start=cwd) | |
| 截断:构造 > 200 文件夹 → `truncated:true` + 仅 200 条 | |
| 超时:较慢 IO 模拟 → 200ms 后 partial 返回 | (用 `controller.abort()` 测试) |
| 错误响应:`q=''` → 400 / `q=x`.repeat(65) → 400 | |
| 无 cwd:`req.app.locals.instanceContext = undefined` → 500 (走现有 ctx() 抛错) | 与现有 /fs/list 一致 |

### 7.2 前端(`FsSearchList.test.tsx` + `useFsSearch.test.tsx` 可选)

| 用例 | 断言 |
|------|------|
| 渲染空 entries | 显示 "无匹配" 占位 |
| 渲染 3 条 entries | 显示 3 行 + path 高亮 |
| 点击一行 | 触发 `onSelect(path)` prop |
| 加载中 | 显示 Spin |
| 错误 | 显示 error 文案 |
| query 切换 | 旧请求被 abort(`fetch` mock 检查 `signal.aborted`) |
| 防抖:连续 type 3 个 key,只触发 1 次 fetch | vi.useFakeTimers + flush |

## 8. 风险与权衡

| 风险 | 缓解 |
|------|------|
| 大仓库 walk 慢 | MAX_RESULTS=200 + 200ms 截断 + 给前端 `truncated` UI |
| user-controlled `dir` 越界 | 服务端不接 `dir`,强制 start=cwd |
| 隐藏文件泄露机密(e.g. `.env`) | IGNORED 不包含 `.env`,但和 `/fs/list` 一致;本搜索和列表行为对齐 |
| cwd 跨平台 `/` vs `\\` | 服务端在响应里统一用 `/`(与现有 FsEntry `path: rel.split(sep).join('/')` 对齐) |
| 单测难造"大仓库" | 用 `mkdirSync` 脚本生成 250 子文件 |
| 高亮渲染性能 | 用纯 `<mark>` 切字符段,React 文本节点即可,无需 memoize |

## 9. 未来扩展(不在本设计)

- 全文 grep(走 `grepRenderer` 已有 UI;后端暴露 `/fs/grep`)
- 索引化(ripgrep watch + sqlite FTS5,常驻服务)
- ⌘P 快捷键(全局 Focus 搜索框)
- 内容预览内二次检索(grep inside file)
