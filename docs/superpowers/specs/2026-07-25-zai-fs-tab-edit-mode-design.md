# zai FsTab 文件预览编辑模式 — 设计

> 状态: 待 review
> 日期: 2026-07-25
> 范围: `packages/zai/src/server/routes/fs.ts`(新增 `PUT /fs/file`)+ `packages/zai/src/web/src/components/splitPane/{FsTab,TextEditor}.tsx`(新增编辑器 + 切换态)+ `useFsWrite` hook

## 1. 背景

zai 的 Files 标签(`FsTab`)右侧预览区目前**只读**:选中文件后只能查看(代码经 Prism 高亮、Markdown 经 `MarkdownText` 渲染、图片 / HTML 走 `<img>` / sandboxed `<iframe>`)。用户需求是在文本 / 代码文件上做"简单编辑":点击进入可编辑态,改完后保存到磁盘。

现行只读实现的代码位置:
- 服务端:`packages/zai/src/server/routes/fs.ts`,GET `/fs/file`(`fs.ts:266-361`),扩展名白名单 `TEXT_EXTS`(L14-23)。
- 前端:`packages/zai/src/web/src/components/splitPane/FsTab.tsx`,`renderPreview(file, htmlMode)`(L151-256);`useFsFile(cwd, selected)` hook(`useFsFile.ts`)。
- 公共类型:`packages/zai/src/shared/fs.ts`,`FsFile.kind: 'text' | 'image' | 'html'`,text 才有 `content: string`。

## 2. 设计

### 2.1 服务端 — `PUT /api/fs/file`

新增 `fsRouter.put('/fs/file', ...)`(`fs.ts` 紧接现有 `GET /fs/file` 之后):

- 入参 body:`{ path: string, content: string }`。`path` 相对 cwd;`content` 是 UTF-8 文本。
- 安全:复用 `resolveSafePath(cwd, rel)`(`utils/safePath.ts:17-39`)做越界 + NUL 字符防护;复用现有 `TEXT_EXTS` 白名单(`fs.ts:14-23`)+ `IMAGE_EXTS` / `HTML_EXTS` 取反判断 — 仅文本类可写。
- 校验:`path` 缺失 → 400;扩展名不在 `TEXT_EXTS` / dotfile 不允许 → 400(`不允许写入:` + 扩展名);越界 → 403(沿用 `resolveSafePath` 的 error 字符串);NUL → 400。
- 大小限制:`Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES`(2 MB)→ 413,error 形如`内容过大 (X.XX MB > 2 MB)`。
- 写入:`writeFile(safe.abs, content, 'utf8')` 覆盖写入。读后用 `await stat(...)` 取新 `mtime` / `size`。
- 响应:`FsFile` 形态(复用现有 schema 即可):
  ```ts
  { ok: true, path, name, mtime, size }   // 成功
  { ok: false, error: string }             // 失败, 上面 status code 对应
  ```
- 状态码映射:
  - 200:写入成功
  - 400:`path` 缺失 / NUL / 扩展名不允许
  - 403:路径越界
  - 404:`stat` 返回 ENOENT(写入前文件被删)
  - 413:内容超过 2 MB
  - 500:`stat` / `writeFile` 失败(权限、磁盘满等)

**冲突处理 — 不做**:本期不做 mtime 比对 / 文件锁。两个客户端同时写入是 last-write-wins,这是"简单编辑"目标的合理取舍(若以后要做,沿用 proper-lockfile 路径)。

### 2.2 前端 — 编辑器封装 `TextEditor`

新建 `packages/zai/src/web/src/components/splitPane/TextEditor.tsx`:

- 依赖:`@codemirror/state` + `@codemirror/view` + `@codemirror/commands` + 5 个 lang 包(`@codemirror/lang-javascript` 覆盖 typescript / javascript / jsx / tsx;`@codemirror/lang-json`;`@codemirror/lang-python`;`@codemirror/lang-rust`;`@codemirror/lang-go`;`@codemirror/lang-sql`)。组件内一个 `langLoader(extension: string)` switch 把 `extToLanguage()` 返回的 Prism lang id 映射到对应 CodeMirror 语言包;不在映射中的(less / xml / powershell / graphql / ruby / java / kotlin / swift / c / cpp / shell)走纯文本 fallback。
- props:
  ```ts
  interface TextEditorProps {
    initialContent: string;     // 来自 server 的 content
    language: string | null;    // extToLanguage(name) 的输出
    onSave: (newContent: string) => void | Promise<void>;
    onCancel: () => void;
    saving?: boolean;           // 显示 Save 按钮的 loading 态
  }
  ```
- 实现要点:
  - 受控:用 `EditorState.create({ doc: initialContent, extensions: [...] })` 初始化。
  - extensions 列表:行号(`lineNumbers()`)、折叠、Ctrl/Cmd+S 拦截(`keymap.of([{ key: 'Mod-s', run: () => { onSave(view.state.doc.toString()); return true; }, preventDefault: true }])`)、Esc 拦截(`'Escape'` → `onCancel()`)。
  - theme:`EditorView.theme({...})` 与项目 dark UI 对齐(`#0d0d0d` 背景,白色文字)。
  - 容器:`<div ref={parentRef} style={{ flex: 1, minHeight: 0 }} />`,把 CM 挂到 ref 上。
  - 卸载:`useEffect` cleanup 调 `view.destroy()`。
- 不引入 CodeMirror 自带查找 / 多光标菜单 / settings(本期 YAGNI)。

### 2.3 `FsTab.tsx` — 切换态

`FsTab` 现状:`renderPreview(file, htmlMode)` 返回三种分支(image / html / md+code+text)。新增"编辑态"概念,在 `FsTab` 内用 `useState<{ path: string | null }>` 管理 `editingPath`:

- 当 `editingPath === file.path` 且 `file.kind === 'text'` 时,右侧预览区替换为 `<TextEditor initialContent={file.content} ... />`,顶部加 Save / Cancel。
- 其他情况维持原 `renderPreview`。
- 切换文件 / 切换 cwd:`useEffect([cwd])` 已经在 L281-287 清空 `selected`;同一处追加 `setEditingPath(null)`,确保跨文件不残留。
- 状态机:
  ```
  view → [Edit]    → edit
  edit → [Save]   → save() → 成功 → view + dirty.dot(path)
                       → 失败 → 留 edit + error toast
  edit → [Cancel] → view(丢弃本地)
  edit → [Esc]    → view(丢弃本地)
  edit → [Mod-s]  → save()
  ```

### 2.4 顶部按钮 — Edit / Save / Cancel

预览区 header(`fs-tab-header`, L367-402)新增右侧按钮组,仅当 `file.kind === 'text'` 显示:

```tsx
{file.kind === 'text' && !editingPath && (
  <Button size="small" onClick={() => setEditingPath(file.path)}>编辑</Button>
)}
{editingPath === file.path && (
  <>
    <Button size="small" loading={saving} onClick={handleSave}>保存</Button>
    <Button size="small" onClick={handleCancel}>取消</Button>
  </>
)}
```

按钮放在 `Refresh` 按钮之前,与现有 `Segmented`(HTML 预览切换)位置一致 — 都是"该类型文件专属操作"。

### 2.5 `useFsWrite` hook

新建 `packages/zai/src/web/src/components/splitPane/useFsWrite.ts`:

- 接口:
  ```ts
  export interface UseFsWriteResult {
    save: (path: string, content: string) => Promise<{ ok: boolean; mtime?: string; size?: number; error?: string }>;
    saving: boolean;
  }
  export function useFsWrite(): UseFsWriteResult;
  ```
- 实现:`api.put<FsFile>('/fs/file', { path, content })`(沿用 `lib/api.ts:33-37` 已有的 `put` 方法);`saving` 是单 flag(reflect 当前 in-flight 请求)。
- `FsTab` 在保存成功后调 `dirtySet.add(path)`(下一节)。`api.put` 失败会抛 `ApiError`(`lib/api.ts:13-18`),`save()` catch 后返回 `{ ok: false, error }`,不抛出。

### 2.6 脏标记 — `dirtyPaths` 内存 set

`FsTab` 内 `const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set())`:

- 保存成功:`setDirtyPaths(prev => new Set(prev).add(path))`。
- 取消 / 切换文件 / 切换 cwd:**不**清除(`dirtyPaths` 是"哪些文件曾被本会话改过"的整体记录,与当前是否编辑无关)。
- 切换 cwd 时清空(已经在 `useEffect([cwd])` 内统一重置)。
- Tree 渲染:`renderTree` 内对 `dirtyPaths.has(e.path)` 的项,在 title 前渲染 `<span style={{ width: 6, height: 6, borderRadius: '50%', background: 'rgba(255,102,0,0.7)', display: 'inline-block', marginRight: 6 }} />`(淡橙小圆点)。
- 不发 SSE / 不通知 agent:与 `FsContextMenu` 的删除操作同源(都是用户主动修改文件),LLM 通过 filesystem tool 看到变更即可。

### 2.7 依赖

`packages/zai/package.json` 新增(全部挂 dependencies,因为 web bundle 也需要):

```json
"@codemirror/state": "^6.4.0",
"@codemirror/view": "^6.30.0",
"@codemirror/commands": "^6.6.0",
"@codemirror/lang-javascript": "^6.2.2",
"@codemirror/lang-python": "^6.1.6",
"@codemirror/lang-json": "^6.0.1",
"@codemirror/lang-rust": "^6.0.1",
"@codemirror/lang-go": "^6.0.1",
"@codemirror/lang-sql": "^6.7.0"
```

`langLoader` 把 `extToLanguage` 输出映射到这些包:`typescript/tsx/javascript/jsx → javascript()`、`json → json()`、`python → python()`、`rust → rust()`、`go → go()`、`sql → sql()`。其他(less / xml / powershell / graphql / ruby / java / kotlin / swift / c / cpp / shell)走纯文本 fallback — 这是 CM 默认行为,不加 extension 即可。

## 3. 数据流

```
用户点击 [编辑] 按钮
  → FsTab.editingPath = file.path
  → renderPreview 替换为 <TextEditor initialContent={file.content} lang={...} />

用户在 textarea 中编辑 (CodeMirror 受控)
  ↓ [Mod-S] or [保存]
useFsWrite.save(path, newContent)
  → api.put('/fs/file', { path, content })
  → server: resolveSafePath → TEXT_EXTS check → byteLength ≤ 2MB → writeFile utf8 → stat → { ok, mtime, size }
  → ok: dirtyPaths.add(path) + 退出编辑态(editingPath=null) + toast.success('已保存')
  → err: toast.error(error) + 保留编辑态

用户 [Cancel] / [Esc]
  → editingPath=null,丢弃本地 content(不调 server)
```

## 4. 错误处理

- 服务端 400/403/404/413/500 都有具体 error 字符串,前端 `message.error(error)` 直接显示。
- 网络断开 / 服务端崩溃:`api.put` 抛 `ApiError`,被 `useFsWrite.save` catch,`{ ok: false, error: err.message }`,保留编辑态,不丢用户输入。
- CodeMirror 自身抛错(罕见):`useEffect` cleanup 兜底,不冒泡。
- 切换文件时若有未保存改动:**本期不弹确认**(YAGNI)。最坏情况用户按 Cancel,所有改动丢失;Mod-S 始终可用。

## 5. 测试

### 5.1 后端 — 扩展 `routes/fs.test.ts`

新增 `describe('PUT /fs/file', () => { ... })`:

- `test('writes a text file under cwd')`:写入后 `readFileSync` 拿到新内容。
- `test('returns new mtime and size')`:写入后 mtime 改变、size 等于新 byteLength。
- `test('rejects non-text extension')`:写 `.png` → 400。
- `test('rejects path traversal')`:`../../etc/passwd` → 403,`execFile`/`writeFile` 未被调用(用 `vi.spyOn(fs, 'writeFile')` 或纯对比文件未变)。
- `test('rejects NUL byte path')`:`path: 'src/foo\x00../etc/passwd'` → 400。
- `test('rejects empty path')`:`{}` → 400。
- `test('returns 404 when target missing')`:`rmSync(target)` 后写 → 404。
- `test('returns 413 when content > 2MB')`:超长 content → 413。
- `test('rejects dotfile outside TEXT_EXTS')`:`.bin`(非 dotfile 也不在白名单)→ 400。

### 5.2 前端 — `TextEditor.test.tsx`

新建 `packages/zai/src/web/src/components/splitPane/TextEditor.test.tsx`(`@vitest-environment happy-dom`):

- `it('mounts CodeMirror with initial doc')`:`initialContent='abc'` → DOM 含 `cm-content`、内容 `abc`。
- `it('fires onSave with current doc on Mod-S')`:模拟键盘事件 `Mod-s` → `onSave` 被调一次,参数为最新 doc;`preventDefault` 被调(用 `vi.fn()` spy)。
- `it('fires onCancel on Escape')`:`Escape` → `onCancel` 被调一次。
- `it('unmounts cleanly without throwing')`:`unmount()` 不抛。

### 5.3 前端 — 扩展 `FsTab.test.tsx`

新增:

- `it('shows 编辑 button only for text-kind files')`:`mockFile` 返回 `.ts` → 有 `[data-testid="fs-edit-btn"]`;`.png` / `.html` 没有。
- `it('enters edit mode on 编辑 click')`:点击 `[data-testid="fs-edit-btn"]` → `TextEditor` 渲染(断言 `[data-testid="fs-editor"]` 或 CodeMirror 的 `.cm-editor`)。
- `it('saves and exits edit mode on Save click')`:mock `api.put` resolve `{ ok: true }` → 点击 `[data-testid="fs-save-btn"]` → 编辑器消失 + 文件树 dirty 点出现(`[data-testid="fs-tree-dirty-foo.ts"]`)。
- `it('does not save on Cancel click')`:mock `api.put`(`vi.fn()`) → 点击 `[data-testid="fs-cancel-btn"]` → 编辑器消失 + `api.put` 未被调。
- `it('stays in edit mode on save failure')`:mock `api.put` resolve `{ ok: false, error: '权限不足' }` → 点击 Save → 编辑器仍在 + 无 dirty 点。

(`FsTab.test.tsx` 已有 `useFsFile` / `useFsList` / `useFsSearch` 的 `vi.mock`,沿用。需新增 `vi.mock('./useFsWrite.js')`。)

### 5.4 前端 — `useFsWrite.test.ts`

新建 `packages/zai/src/web/src/components/splitPane/useFsWrite.test.tsx`:

- `it('calls api.put with path and content')`:`renderHook` 调 `save('a.txt', 'hi')` → `api.put` 被调一次,参数 `['/fs/file', { path: 'a.txt', content: 'hi' }]`。
- `it('returns { ok: true } on success')`:mock api.put resolve `{ ok: true, mtime, size }` → `save(...)` resolve 同结构。
- `it('returns { ok: false, error } on api throw')`:mock api.put reject → `save(...)` resolve `{ ok: false, error: ... }`,不抛。
- `it('exposes saving flag during in-flight')`:mock api.put 挂起 Promise → `save(...)` 启动后 `result.current.saving === true`,resolve 后回 `false`。

## 6. 已知边界 / 不做

不做(YAGNI):
- 文件锁 / mtime 并发检测
- 大文件(>2 MB)写入
- 非文本扩展名写入
- 文件名 / 大小写敏感的 `fs.rename`
- 在编辑态中切换文件时的"未保存确认"对话框(本期直接丢弃,后续加)
- 在编辑态中通过 SSE 自动 invalidate(用户改文件后磁盘变更被覆盖,本期不做)
- 把 CodeMirror 抽取为可复用通用组件(仅本组件用,放 splitPane 内)
- Monaco 或 Ace(CodeMirror 已满足需求)
- 编辑器侧的多 tab / split view
- 编辑历史 / undo 持久化
- 通知 agent 文件变更(用户明确不要)

边界:
- 切换 cwd 会清空 `dirtyPaths`(与现有 `useEffect([cwd])` 同步);切到同一 cwd 不清。
- 文件被外部修改:保存覆盖(无 mtime 检查);预览区内容保留旧的,需手动取消后再点开才能看到新内容。
- CodeMirror 加载失败 → 编辑区空白 + 顶部按钮仍可点(用户可 Cancel)。错误不弹 toast,本期跳过。
- Java/Kotlin/Swift/C-like/Bash 文件没有 lang 包 → 编辑器无高亮,纯文本模式。
- 未保存改动在切文件时丢失 — 不提示。

## 7. 文件清单

新增:
- `packages/zai/src/web/src/components/splitPane/TextEditor.tsx`
- `packages/zai/src/web/src/components/splitPane/TextEditor.test.tsx`
- `packages/zai/src/web/src/components/splitPane/useFsWrite.ts`
- `packages/zai/src/web/src/components/splitPane/useFsWrite.test.tsx`

修改:
- `packages/zai/package.json`(依赖)
- `packages/zai/src/server/routes/fs.ts`(`fsRouter.put('/fs/file', ...)`)
- `packages/zai/src/server/routes/fs.test.ts`(新增 `describe('PUT /fs/file')`)
- `packages/zai/src/web/src/components/splitPane/FsTab.tsx`(Edit 按钮 + editingPath state + dirtyPaths + renderTree 标点)
- `packages/zai/src/web/src/components/splitPane/FsTab.test.tsx`(5 个新 case)