# zai 移动端常用指令抽屉新增 Diff Tab — 设计

> 单文件、纯前端的最小改动。在 `MobileQuickDrawer` 的 `Segmented` 末尾新增 `Diff` tab,展示当前 session 的 git working tree 状态(文件列表),并允许单文件 revert。

## 1. 目标与范围

| 项 | 内容 |
|---|---|
| 用户故事 | 在手机端打开常用指令抽屉 → 切到 `Diff` → 一眼看到当前 session 工作区改动了哪些文件;对单个文件可一键撤销 |
| 范围内 | `MobileQuickDrawer.tsx` 新增 `'diff'` tab 分支;复用既有 `useGitStatus` + `gitApi.revertFile` |
| 范围外 | 不展示具体 diff 行(unified diff);不改 PC 端 `splitPane/GitTab.tsx`;不新增 git HTTP 接口;不新增 git store;不动 `useGitStatus` / `gitApi.ts` |
| 替代方案 | A)抽出独立 `MobileDiffTab.tsx` — 不采纳,tab 仍小且与现有内联 bash/prompt 分支一致。B)复用 PC `GitTab` 隐藏左列 — 不采纳,绑两栏布局。 |

## 2. 架构与依赖

**唯一改动文件**: `packages/zai/src/web/src/components/MobileQuickDrawer.tsx`(287 → 约 +120 行)。

**复用(零改动)**:
- `useGitStatus(cwd)` → `components/splitPane/useGitStatus.ts`,返回 `{ data: GitStatus | null, loading, error, refetch }`,内部 5 s 轮询 `GET /api/git/status`。
- `gitApi.revertFile(path)` → `lib/gitApi.ts`,`POST /api/git/revert`。
- `STATUS_COLORS` / `STATUS_LABELS` → `components/splitPane/shared.ts`,已用于 PC 端。
- 类型 `GitStatusFile.status` / `staged` → `shared/git.ts`。

**新增类型成员**:
- `type TabKey = 'bash' | 'prompt' | 'diff'`。
- `Segmented options` 末尾追加 `{ label: 'Diff', value: 'diff' }`(保持原顺序,Bash → 常用指令 → Diff)。
- 局部 state:`const [loadingPath, setLoadingPath] = useState<string | null>(null)`(防双击重发)。

**组件树(增量)**:
```
MobileQuickDrawer
  ├─ Segmented (bash | prompt | diff)
  └─ {tab === 'diff' && <DiffTab>}
        ├─ 头部: ReloadOutlined 手动 refetch (与 Bash tab 同款刷新按钮)
        ├─ error 非空 / data?.ok === false
        │     → <Empty description={error ?? '当前目录不是 git 仓库'} />
        ├─ data.ok && data.files.length === 0
        │     → <Empty description="无变更" />
        └─ data.ok && data.files.map → 行
              ├─ <Tag color={STATUS_COLORS[file.status]}>{STATUS_LABELS[file.status]}</Tag>
              ├─ <span ellipsis title={file.path}>{file.path}</span>
              └─ <Button icon={<UndoOutlined/>} loading={loadingPath === file.path}
                         onClick={() => confirmRevert(file)} />
```

## 3. 数据流

```
抽屉 open
  → tab 切换到 'diff'
  → DiffTab 挂载 → useGitStatus(cwd) 首次 load()
  → 每 5 s 轮询(只在抽屉 + DiffTab 挂载期间跑;抽屉关闭 → 抽屉卸载 → DiffTab 卸载 → useEffect cleanup → clearInterval)

用户点 Revert 按钮
  → Modal.confirm({title: '撤销 <path>?',
                   content: file.staged === 'untracked'
                              ? '该文件未跟踪,撤销将永久删除' : '将丢弃该文件的本地改动'})
       onOk → setLoadingPath(file.path)
              → gitApi.revertFile(file.path)
              → { ok: true }  → message.success('已撤销') + refetch() + setLoadingPath(null)
              → { ok: false } → message.error(result.message) + setLoadingPath(null)
                              (不 refetch,因为状态未变)
  → Modal.confirm 取消 → loadingPath 保持 null,无副作用
```

## 4. 错误处理与边界

| 场景 | 行为 |
|---|---|
| 无 session / 无 cwd | `<Empty description="请先开启会话" />`(与 Bash tab 行为对齐) |
| `data?.ok === false`(含 `error === 'not a git repository'` 与其他后端错) | `<Empty description={data.error ?? '当前目录不是 git 仓库'} />`(把后端 error 透传;只有 `data.error` 为空时才落回「当前目录不是 git 仓库」) |
| `error` 非 null(`useGitStatus` catch 路径,`data` 可能仍为旧值) | `<Empty description={error} />`(覆盖网络失败) |
| `data.ok && data.files.length === 0` | `<Empty description="无变更" />` |
| revert 失败 | `message.error(result.message ?? '撤销失败')`,不 refetch |
| revert 成功 | `message.success('已撤销')` + 立即 `refetch()`(不等 5 s) |
| 二次点同一行的 revert | `loadingPath === path` 时 Button `loading` + `disabled`,`Modal.confirm` 还未 resolve 时按钮已 disabled 不会再次进入 onClick |
| untracked 文件 | Modal.confirm content 文案明确提示「将永久删除」;后端走 `unlink`(已存在) |
| 长路径溢出 | 行内 `overflow:hidden + text-overflow:ellipsis` + `title={file.path}` 长按查看全 |

## 5. 与现有约束的对齐

- **仅 isMobile 触发**:抽屉组件由 `AgentInputBox.tsx:845` 在 `isMobile === true` 才渲染按钮,所以改动只影响移动端。
- **cwd 来源一致**:`cwd` 沿用文件顶部已计算的 `cwdBySession[sessionId]`,与 Bash tab 同一来源,确保切 session 后立即跟随。
- **关闭即停轮询**:抽屉关闭 → `<Drawer open={false}>` → 组件内部 v-if 卸载 → `useGitStatus` 的 `useEffect` cleanup → `clearInterval`。**满足「只在打开时拉」的用户意图**。
- **不动 store**:`loadingPath` 仅组件局部,不污染全局。
- **不动类型**:`GitStatus` / `GitStatusFile` 已经能表达 `data.ok === false` 的 not-git-repo 路径(`shared/git.ts`),无需新增 union 成员。

## 6. 测试

**新增 `packages/zai/src/web/src/components/MobileQuickDrawer.test.tsx`**(若已存在则合并):

| Case | 断言 |
|---|---|
| 渲染 Diff tab | `Segmented` 选项含 `Diff`;点击 `Diff` 切换 tab |
| 文件列表渲染 | mock `useGitStatus` 返回 2 个文件 → 列表渲染 2 行,Tag 颜色按 `STATUS_COLORS` |
| 空状态 | `data.files.length === 0` → 渲染 `<Empty>` 文字「无变更」 |
| 非 git 仓 | `data.ok === false` + `error='not a git repository'` → 渲染 `<Empty>` 文字「当前目录不是 git 仓库」 |
| Revert 流程 | mock `gitApi.revertFile` → 点 Undo 按钮 → 确认窗 ok → mock 被调用一次 + `refetch` 被调一次 |
| Revert 取消 | 确认窗 cancel → mock 未被调用 |
| loadingPath 防双发 | 第一次 onClick 进入异步未结束前,Button `disabled` / `loading=true` |

**不重测**:`useGitStatus.test.ts` / `gitApi.test.ts` / `server/routes/git.test.ts`(契约已稳定)。

**手动验证**(vitest + 本地 dev server):
1. 启动 dev server,`window.resizeTo(375, 800)` 进入移动模式。
2. 打开抽屉 → Diff tab → 应立即看到文件列表(可能为空仓 → Empty)。
3. 终端改一个文件 → 等 ≤5 s → 列表新增一行。
4. 点 Undo → 确认 → 终端 `git status` 应回到改之前;列表对应行消失。
5. `cd` 出 git 仓(切 session 到非 git 项目)→ 列表渲染「当前目录不是 git 仓库」。

## 7. 风险与回滚

- **风险**:`loadingPath` 状态未持久化 — 抽屉关闭再开,loading 标志丢失,但因为抽屉关闭即停轮询 + revert 后立即 refetch,实际不会被感知。
- **回滚**:仅 `MobileQuickDrawer.tsx` 一个文件改动,`git revert` 即可。
- **不动后端**:无 API 兼容性问题。

## 8. 验收

- [ ] `pnpm -F zai test` 全绿(新增 7 case 通过)。
- [ ] 抽屉 Segmented 含三个 tab,顺序 Bash → 常用指令 → Diff。
- [ ] 抽屉关闭后再开,Diff tab 列表立即刷新。
- [ ] revert untracked 文件有「将永久删除」确认文案。
- [ ] 行长路径可滚动省略 + `title` 显示全。
- [ ] 不在 git 仓 → Empty 文案区分清楚。