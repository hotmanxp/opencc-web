# Spec — zai 会话归档（transcript 过期移入 `~/.zai/archive/`）

- 日期：2026-09-23
- 状态：待实现
- 相关代码（现状）：
  - `packages/zai/src/server/services/agentRuntime.ts`（`initAgentRuntime` :568、`restoreAllSessions` :223 与调用点 :690）
  - `packages/zai/src/server/routes/agent.ts`（`GET|POST /agent/sessions` :2002/:2016）
  - `packages/zai/src/server/routes/agentSettings.ts`（`GET /agent/settings`、`PUT /agent/settings/*`）
  - `packages/zai/src/shared/settings.ts`（`ZaiSettings`）
  - `packages/zai/src/web/src/components/SettingsDrawer.tsx`（`SettingsRow` :49 已支持 `kind: 'number'`）
  - `packages/zn-agent-core/src/compat/runtime/legacyTranscriptStore.ts`（`TranscriptStore.dirFor` :75、内联 `sanitizePath` :37）
- 先例：`packages/zai/src/server/services/historyArchive.ts`（任务工厂终态任务过期归档）

## 0. TL;DR

同一工作目录下，transcript 超过保留阈值就移到归档目录，**只在服务启动时自动跑一次**，另提供一个手动触发入口：

- 保留集 = **最近 `keepCount` 条**（默认 20）**∪ 最近 3 天内修改过的**；
- 归档 = 既不在前 `keepCount` 条、又早于 3 天前；
- 归档单元 = `<sessionId>.jsonl` + 同名 `<sessionId>/` 目录（子 Agent transcript）整组移动；
- 目标路径 `~/.zai/archive/projects/<sanitizePath(cwd)>/`，保留原始 project 编码路径段；
- 归档后对 Web UI **完全透明** —— 侧栏不再列出（文件已不在 `projects/` 下），无归档列表页、无恢复按钮；
- `keepCount` 在设置里可配；3 天阈值与 10 分钟保护窗是模块常量。

## 1. 动机

`~/.zai/projects/<encoded-cwd>/` 会无限累积 `<sessionId>.jsonl`。实测单个活跃项目目录已有 **230 个** transcript，占几百 MB（单文件可达 4 MB+）。这些文件：

- 拖慢每次 Web UI 侧栏加载（`GET /api/agent/sessions` 要对目录里**每个** `.jsonl` 做 `readdir` + `stat` + 全量 `readEntries` 解析，见 `legacyTranscriptStore.ts:247`）；
- 拖慢启动（`initAgentRuntime` → `restoreAllSessions` 会 list + read 全部会话，见 `agentRuntime.ts:223-262`）；
- 绝大多数永不再被打开。

需求（用户原话）：**同一工作目录下，会话数量默认 20 条最近记录或者最近 3 天内的记录，20 条排序以外且 3 天前的日志 transcript 移动到归档目录 `~/.zai/` 的归档目录（保持原始的 project 编码路径）；检查过期的时间为每次服务启动的时候**；补充：**设置中可以配置默认归档的会话数量阈值**。

## 2. 决策记录

| # | 决策 | 取值 |
|---|---|---|
| D1 | 归档后 Web UI 呈现 | 纯磁盘收纳，UI 不可见（无归档列表页 / 无恢复 UI） |
| D2 | 启动扫描范围 | 只归档**本实例 cwd** 对应的那个 project 目录 |
| D3 | 归档单元 | `<sid>.jsonl` + 同名 `<sid>/` 目录整组 |
| D4 | 可配置项 | 只配数量阈值 `archive.keepCount`（默认 20）；3 天固定 |
| D5 | 活跃保护窗 | 跳过最近 10 分钟内有写入的文件 |
| D6 | 手动触发 | 新增 `POST /api/agent/sessions/archive` + 设置页「立即归档」按钮 |

## 3. 路径与归档单元

```
源   <dataDir>/projects/<sanitizePath(cwd)>/<sid>.jsonl
                              <sid>/subagents/agent-*.jsonl
目标 <dataDir>/archive/projects/<sanitizePath(cwd)>/<sid>.jsonl
                                            <sid>/subagents/agent-*.jsonl
```

`dataDir` 走 `resolveDataDir().resolved`（`@zn-ai/zn-agent-core` 导出；`ZAI_DATA_DIR` 可覆盖，默认 `~/.zai`）。归档根追加一层 `archive/`，其下**原样保留** `projects/<encoded-cwd>/` 两段，因此同一个 cwd 的所有归档会话都落在同一个可预测目录里。

### 3.1 `sanitizePath` 从 core 导出，不内联第 4 份副本

仓库里有三份 `sanitizePath`，其中两份**不能**用：

| 位置 | 阈值 | 可用于本项目目录？ |
|---|---|---|
| `compat/transcript/paths.ts:30` | **80** | ❌ 阈值不同，长路径会算出不同目录名 |
| `opencc-src/utils/sessionStoragePortable.ts:311` | 200（`Bun.hash` / `djb2` 二选一） | ⚠️ Bun 下 hash 算法不同 |
| `compat/runtime/legacyTranscriptStore.ts:36` | **200**（纯 `djb2`） | ✅ 与本实例落盘目录逐字一致 |

zai 侧 transcript 的实际落盘目录由 `legacyTranscriptStore.dirFor()` 决定，所以**第三份是唯一正确的实现**。

**决策（2026-09-23 调整）**：与其在 zai 侧内联第 4 份逐字副本，改为给第三份加 `export` 并在 `zn-agent-core` 主入口 re-export，zai 侧 import 使用：

```ts
// packages/zn-agent-core/src/compat/runtime/legacyTranscriptStore.ts
export function sanitizePath(name: string): string { /* 不变 */ }

// packages/zn-agent-core/src/index.ts
export { sanitizePath } from './compat/runtime/legacyTranscriptStore.js'

// packages/zai/src/server/services/sessionArchive.ts
import { resolveDataDir, sanitizePath } from '@zn-ai/zn-agent-core'
```

**代价**：这是本特性唯一改动 `zn-agent-core` 的地方，改完**必须**跑 `pnpm run build:core` —— zai 通过 `node_modules/@zn-ai/zn-agent-core/dist/` 加载，不重建就用不到新导出。

**收益**：消除逻辑块重复（内联副本会被代码评审按「verbatim duplication」驳回），且编码只有一处真源，未来改动不会漂移。

> 注意 `compat/transcript/paths.ts` 那份 80 阈值版本**依然存在且依然不对**，只是本特性不走它。要不要一并收敛不在本 spec 范围内。

### 3.2 归档单元

一个 session 的磁盘痕迹是**两个**条目：

```
<sessId>.jsonl          ← 主 transcript（含 session-meta / 消息 / title）
<sessId>/               ← 可选：该会话派生的子 Agent transcript
  subagents/agent-<id>.jsonl
  subagents/agent-<id>.meta.json
```

**两者一起移动**：只移 `.jsonl` 会把 `<sessId>/` 留成永远没人认领的孤儿目录（占用空间且不可发现）。`<sessId>/` 不存在时只移单文件。

`projects/<encoded-cwd>/` 下的其它内容**一律不动**：`memory/`（项目级记忆）、`knowledge_graph.json` / `knowledge.orama` / `knowledge.db`（知识图谱）。这些不是会话级数据。

## 4. 判定算法

```
候选 = readdir(projectDir) 中所有以 .jsonl 结尾的 <sid>（含 0 字节占位文件）
       —— 排除目录（<sid>/ 不在候选内，它是随行者）
对每个 sid：mtime = stat(<sid>.jsonl).mtimeMs   （stat 失败 → 跳过该条）

按 mtime 降序排序
保留集 =  前 keepCount 条
        ∪ { mtime >= now - 3 day }
归档集 = 候选 \ 保留集

对归档集中每一条：
  if (now - mtime < 10 min)          → 跳过（保护窗）
  if (目标已存在)                     → warn 跳过
  else rename(<sid>.jsonl → 目标)；若 <sid>/ 存在则一并 rename
```

**时间基准取 `mtime`**，与 `TranscriptStore.list()` 的 `updatedAt`（`legacyTranscriptStore.ts:262`）同源 —— 判定与 UI 排序看到的是同一个时间，不会出现「侧栏排第 3 却因为另一个时间戳被归档」。

**`keepCount` 与实际保留数**：保留集是并集，所以实际保留数 ≥ `keepCount`。若该目录最近 3 天内活跃过的会话超过 20 条，则一条都不会归档 —— 这是设计意图（3 天窗口优先于数量上限）。

### 4.1 保护窗的真实覆盖面（重要，别当成万能）

保护窗**唯一可达的路径是「扫描与写入撞车」**：候选扫描时的第一次 `stat` 读到旧 mtime（进归档集），移动前的第二次 `stat` 读到刚被写入的新 mtime（触发跳过）。第二次 `stat` 存在的意义就是它 —— 判定条件「早于 3 天」与保护窗「10 分钟」在**同一个 mtime** 上不可能同时成立，所以没有这次重读，保护窗就是一段永不执行的分支。

它**防不住**的是「另一个实例持有一个 ≥3 天没写入的会话」（mtime 早于 3 天，也不在保护窗内）。

真正可靠的方案是排除"运行中实例的活跃会话集合"，但那需要跨实例通信（每实例的活跃 session 是进程内状态，没有共享注册表）。**接受此残留风险**，列入 §9。

### 4.2 边界情形

| 情形 | 行为 |
|---|---|
| 0 字节占位文件（新建未用） | 参与判定；超期即归档（顺手清理垃圾） |
| `stat` 失败（竞态删除 / 权限） | warn + 跳过该条，不影响其余 |
| 候选数 ≤ `keepCount` | 无归档，直接返回 |
| project 目录不存在 | 静默返回（新目录 / 从未跑过会话） |
| `mtime` 为未来时间（时钟回拨） | 归入"最近"，不会被归档 |

## 5. 配置

### 5.1 `ZaiSettings`

```ts
// packages/zai/src/shared/settings.ts
archive?: {
  /** 保留最近 N 条会话；不在此列且早于 3 天的才归档。默认 20，clamp [1,1000]。 */
  keepCount?: number
}
```

`BUILTIN_DEFAULT_SETTINGS` **不**写入该字段（与 `memory` / `autoDreamEnabled` 同款：缺失走解析函数默认值，避免种子写入把用户没碰过的设置固化进文件）。

### 5.2 解析函数

`packages/zai/src/server/services/sessionArchive.ts` 导出：

```ts
export const ARCHIVE_KEEP_COUNT_DEFAULT = 20
export const ARCHIVE_KEEP_COUNT_MIN = 1
export const ARCHIVE_KEEP_COUNT_MAX = 1000
/** 3 天 —— 固定，不可配（需求明确只暴露数量阈值）。 */
export const ARCHIVE_KEEP_DAYS = 3
/** 10 分钟保护窗。 */
export const ARCHIVE_PROTECT_WINDOW_MS = 10 * 60_000

export function toArchiveKeepCount(value: unknown): number | null
export function resolveArchiveKeepCount(settings: ZaiSettings): number
```

- `toArchiveKeepCount`：`null` / `undefined` 直接返回 `null`（**必须先挡**：`Number(null) === 0` 是有限数，会一路 clamp 成 1）；其余接受 number 或可转数字的字符串（与 `max-visible-messages` 的 handler 同款宽容度）；`Number.isFinite` 不成立 → `null`；否则 `Math.floor` 后 clamp `[1,1000]`。
- `resolveArchiveKeepCount`：`toArchiveKeepCount(settings.archive?.keepCount) ?? 20` —— 缺失 / 手编垃圾值都折叠为默认 20（与 `resolveMaxVisibleMessages`、`resolveAutoUpdate` 同款风格）。

### 5.3 设置接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/agent/settings` | 响应增补 `archiveKeepCount: number`（派生值，不是裸字段） |
| PUT | `/api/agent/settings/archive-keep-count` | body `{ value: number }`；非法 → `400 { error }`；成功 → `{ value: <clamp 后的值> }` |

PUT 形态逐字对齐既有的 `PUT /agent/settings/memory-auto-write`（`agentSettings.ts:539`）：校验 → `readZaiSettings()` → `updateZaiSettings({ archive: {...current.archive, keepCount} })` → echoback。

**生效时机**：写盘即持久。因为归档只在启动与手动触发时读配置，所以下次启动 / 下次点「立即归档」就生效，不需要重启（与 memory 三件套的"重启后生效"不同，这条要写进设置项说明文案）。

## 6. 触发点

### 6.1 启动（自动）

`agentRuntime.ts` 的 `initAgentRuntime()` 内，在 `restoreAllSessions(agentRegistry)`（:690）**之前**插入一次 `await` sweep：

```ts
try {
  await sweepSessionArchive({ cwd, dataDir })
} catch (err) {
  console.warn('[initAgentRuntime] session archive sweep failed:', err)
}
```

为什么在 `restoreAllSessions` **之前**：restore 会 list 全部会话并为每个 `registryAgent(sessionId, agentId)`。先归档能保证 registry 里只有保留下来的会话，不会为一个已归档的 sessionId 留下 agent 绑定。

为什么不 fire-and-forget：这是启动期一次本地 `readdir` + `stat`（一个目录、几百个文件）+ 少量 `rename`，开销在校验启动路径可接受范围内；`await` 才能保证 §6.1 的"之前"语义。失败用 try/catch 兜住，**绝不阻断启动**。

**每个实例都跑**，各扫自己的 `cwd`（含受管子实例：task-factory / 微信专用实例）。这就是 D2「只归档本实例 cwd」的落地方式。

### 6.2 手动（设置页）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/agent/sessions/archive` | 用 `req.app.locals.instanceContext.cwd`，复用同一 sweep（in-flight 去重），返回 `{ archived: string[], kept: number, skipped: number }` |

**放在独立 router 文件 `packages/zai/src/server/routes/sessionArchive.ts`**，而不是塞进 `routes/agent.ts`。理由：`routes/agent.ts` 已 2300+ 行，且它的测试（`test/server/agent.test.ts`）必须 mock 掉整个 `agentRuntime.js` 才能加载模块；本端点完全不依赖 runtime，独立 router 可以像 `agentSettings.ts` 那样用裸 `express` + `supertest` 做自包含测试。

挂载：`server/index.ts` 的 `app.use('/api', ...)` 一串里新增 `app.use('/api', sessionArchiveRouter)`。与既有路由无冲突 —— `routes/agent.ts` 只有 `GET|POST /agent/sessions`（精确匹配）与 `GET|DELETE|PATCH /agent/sessions/:id`，**没有** `POST /agent/sessions/:id` 会吃掉 `archive` 这一段。

永不返回 5xx —— sweep 自带吞异常，端点照常 `200`，`archived: []` 表示没有可归档的。

### 6.3 in-flight 去重

与 `historyArchive.ts:117` 同款模块级 `inFlight: Promise | null`：sweep 进行中再次调用返回同一 Promise。防的是「启动 sweep 还没跑完，用户就点了立即归档」。

## 7. 服务实现

新增 `packages/zai/src/server/services/sessionArchive.ts`。除 `sanitizePath` 从 core 导入（§3.1，Task 0 提供）外，本服务是纯 zai 层。

| 导出 | 职责 |
|---|---|
| `ARCHIVE_*` 常量 | §5.2 |
| `toArchiveKeepCount(value)` / `resolveArchiveKeepCount(settings)` | 配置解析与校验 |
| `projectDirFor(dataDir, cwd)` | `<dataDir>/projects/<sanitizePath(cwd)>`（源目录） |
| `archiveDirFor(dataDir, cwd)` | `<dataDir>/archive/projects/<sanitizePath(cwd)>`（目标目录） |
| `sweepSessionArchive({ cwd, dataDir?, now?, keepCount? })` | 主入口，返回 `SessionArchiveResult` |
| `__resetSessionArchiveForTests()` | 清 in-flight 缓存（测试 seam，对齐 `historyArchive.__resetForTests`） |

`sweepSessionArchive` 的可注入参数（`dataDir` / `now` / `keepCount`）是给单测用的 —— 测试不应该依赖真实 `~/.zai`，也不应该依赖墙钟。生产调用只传 `cwd`：

- `dataDir` 未传 → `resolveDataDir().resolved`；
- `now` 未传 → `Date.now()`；
- `keepCount` 未传 → `resolveArchiveKeepCount(await readZaiSettings())`。

返回值 `SessionArchiveResult = { archived: string[]; kept: number; skipped: number }`：`kept` = 保留集大小，`skipped` = 进了归档集但因保护窗 / 目标同名 / `stat` 失败而**没有**移动的条数。

**约定（逐条对齐 `historyArchive.ts`）**：

- 单体错误只 `console.warn`，绝不抛出；
- 目标同名 → warn 跳过（不合并、不覆盖、不生成 `-1` 后缀）；
- 整个 sweep 异常 → warn 吞掉；
- `rename` 优先（同盘原子零拷贝）；捕获 `EXDEV`（跨设备，例如用户把 archive 做成指向另一块盘的符号链接）→ 降级 `fs.promises.cp(src, dst, { recursive: true, preserveTimestamps: true })` + `rm(src, { recursive: true, force: true })`；
- 移动 `<sid>/` 目录失败的**不单独 warn 就完事** —— 若 `.jsonl` 已移走而 `<sid>/` 留下，必须 warn 指名该孤儿目录（可观测性；不尝试回滚，因为回滚同样可能失败）。

日志：结束时一行汇总 `[sessionArchive] cwd=<cwd> archived=N kept=M skipped=K`。数量为 0 时降级为不打印（避免每次启动都刷一行）。

## 8. 前端

### 8.1 保留数（schema 行）

`SettingsDrawer.tsx` 在 `buildStaticSchema` 里新增一个 section：

```
会话归档
  保留会话数            [ 20 ]  (number row, min 1, max 1000, step 1)
```

- **number row 无需扩展 schema** —— `SettingsRow`（`SettingsDrawer.tsx:49-68`）已有 `kind: 'number'` 分支（`min` / `max` / `step`），渲染与键盘编辑（`SettingsList` 的 `numberEdit` / `adjustNumber`）都已实现并测试过。本行与「显示 → 消息最大显示条数」（`SettingsDrawer.tsx:668-676`）是同一个形态，逐条照抄其接线：`buildStaticSchema` 参数 + `useState` 初始化 + `useEffect` 单向同步 store → schema + `handleChange` 分支（乐观写 store + `PUT`）。
- `useAppStore` 加 `archiveKeepCount: number`（默认 20）+ `setArchiveKeepCount`。
- `Layout.tsx` / `MobileLayout.tsx` 的 `GET /api/agent/settings` mount effect 里加 `archiveKeepCount` hydrate（与 `maxVisibleMessages` 同款 clamp），冷启动不闪默认值。

### 8.2 「立即归档」按钮（手写区块）

按钮**不能**放进 schema（schema 只描述 boolean/enum/number 行）。照抄同文件里「服务」区块（`SettingsDrawer.tsx:1424-1520`）的既有做法 —— 一个手写的 `<div>` + AntD `Button`，紧跟 `<SettingsList>` 之后：

```
会话归档
  保留最近 N 条，且 3 天内修改过的一律保留；其余在服务启动时移入 ~/.zai/archive/。
  [ 立即归档 ]
```

- 点击 → `POST /api/agent/sessions/archive` → `message.success('已归档 N 个会话')`（N=0 → `message.info('没有需要归档的会话')`）；失败 → `message.error`。
- 请求期间按钮 `loading`（`useState` 一个 `archiving`），防重复点击。
- **不做 `Modal.confirm`** —— 归档是可逆的磁盘移动（文件仍在 `~/.zai/archive/`），不需要二次确认；「服务」区块用 confirm 是因为重启会中断对话。
- 归档 API 调用放进 `packages/zai/src/web/src/lib/agentSessionApi.ts`（该文件已存在且已承载 session 相关请求）。

**门控**：与「微信机器人」入口不同，归档配置**不按 `instanceContext.instanceId` 门控** —— 每个实例各扫自己的 cwd，子实例上配置同样有意义。

文案必须含「3 天」与「服务启动时 + 手动触发」两个时机，否则用户无法预期它什么时候跑；**保留数这一行改动后立即生效（写盘即持久），不需要重启** —— 与 memory 三件套的"重启后生效"不同。

## 9. 风险与已知限制

| 风险 | 说明与缓解 |
|---|---|
| 同一 cwd 双实例（如 920x 正式 + 8101 dev） | 实例 A 启动时归档了实例 B 正在使用但 ≥3 天未写入的会话 → B 后续 append 会**新建**文件，历史分裂。D5 的 10 分钟保护窗防不住此场景（§4.1）。**接受**：3 天阈值很长，日常不会命中；文件只是被移走，可手工 `mv` 回 `projects/` 恢复。 |
| `sanitizePath` 编码漂移 | 已通过 §3.1 的单一实现消掉重复；残留风险是 `TranscriptStore` 未来换编码而无人在归档侧发现。缓解：core 侧契约测试断言「落盘目录 == `projects/<sanitizePath(cwd)>`」，zai 侧 Task 1 再对拍一次。 |
| 误归档 | 无 UI 可见性、无恢复入口，只能手工 `mv`。缓解：保留集是"前 N **∪** 3 天内"的并集，比单纯数量上限保守得多；首次上线时默认 20 / 3 天不激进。 |
| 归档目录无限增长 | 明确不做 TTL / 自动删除（归档的语义就是"留着但别碍事"）。用户可自行 `rm -rf ~/.zai/archive/`。 |
| 启动期阻塞 | `await` sweep 会加一点点启动耗时（一个目录的 readdir + N 次 stat）。缓解：只在 project 目录存在时扫；候选数 ≤ keepCount 时直接返回。 |
| core 导出忘了 rebuild | zai 侧 `sanitizePath` 会是 `undefined`，Task 1 直接 `TypeError`。缓解：计划 Task 0 Step 5 用一个 `node -e` 显式验证 `dist` 里确实有该导出。 |

## 10. 明确不做（YAGNI）

- 归档会话的列表页 / 恢复按钮 / 恢复 API（D1）；
- 3 天阈值可配（D4）；
- 归档目录的 TTL / 自动清理；
- 启动时扫描全部 `~/.zai/projects/*`（D2）；
- 打开归档会话 URL 的读取 fallback —— `GET /api/agent/sessions/:id` 对归档会话仍返回 `404`（文件已不在 `projects/` 下）；
- 把 `historyArchive.ts` 抽象成通用 sweep helper（两者归档对象、时间来源、目标桶都不同，强行抽象会造出不合适的通用件）；
- 缓存 / 去重 / 增量扫描（每次启动全量重算，单个目录数量级在几百，成本可忽略）。

## 11. 测试

### 11.1 `packages/zai/test/server/services/sessionArchive.test.ts`

用临时目录（`mkdtemp`）造 `dataDir`，直接铺 `projects/<encoded>/` 下的文件并用 `utimes` 设定 mtime：

| 用例 | 断言 |
|---|---|
| 超出阈值：25 条，最老 5 条 mtime = 5 天前 | 归档 5 条，且都出现在 `archive/projects/<encoded>/` 下 |
| 3 天窗口保护：25 条全部 mtime = 1 天前 | 归档 0 条（数量超了但都在窗口内） |
| 并集语义：22 条，其中 3 条是 5 天前但排序在后 3 位 | 归档 3 条 |
| 保护窗：`keepCount=1`，3 条全部 4 天前但其中 1 条 mtime = 3 分钟前 | 归档 2 条，保护窗内那条不动 |
| `<sid>/` 随行：归档项同时存在 `<sid>.jsonl` 与 `<sid>/subagents/agent-x.jsonl` | 两者都被移走；源目录里不再有 `<sid>/` |
| 目标同名：archive 下已存在同名文件 | 跳过 + warn；源文件仍在原地 |
| 非会话文件不受影响：`projects/<encoded>/memory/MEMORY.md`、`knowledge_graph.json` | 原地不动 |
| 目录不存在 | 返回 `archived: []`，不抛 |
| `keepCount` 可注入（=3） | 按 3 归档 |
| in-flight 去重 | 两次并发调用返回同一 Promise 值 |

`sanitizePath` 一致性用例（§9 缓解措施）：用 `new TranscriptStore(dataDir).create({ cwd, model }, { cwd })` 落一条真实会话，断言其所在目录与 `projectDirFor(dataDir, cwd)` 相同；再调一次 `sweepSessionArchive` 确认能把这个会话归档走。

### 11.2 `packages/zai/test/server/routes/sessionArchive.test.ts`

自包含（`express` + `express.json` + `app.locals.instanceContext` + `supertest`，不 mock `agentRuntime`，照抄 `test/server/agentSettings-memory.test.ts:13-33` 的 setup）：

- `POST /api/agent/sessions/archive` 用 `ctx.cwd` 扫；返回 `{ archived, kept, skipped }`；
- 无可归档时返回 `200 { archived: [] }`，不是 5xx；
- 归档目录用临时 `ZAI_DATA_DIR`，断言文件真的落到了 `archive/projects/<encoded>/`。

### 11.3 设置端点

- `GET /api/agent/settings` 响应含 `archiveKeepCount`（默认 20；settings 里写 5 则返回 5）；
- `PUT /api/agent/settings/archive-keep-count`：合法值 → `{ value }`；`"abc"` / `0` / `1e9` → 分别 `400` / clamp 到 1 / clamp 到 1000。

### 11.4 前端

- `SettingsDrawer.test.tsx` 补断言：「会话归档」section 渲染出 number row 且初值为 store 里的 `archiveKeepCount`；
- 按 §AGENTS.md「页面样式改动不跑单元测试」—— 样式本身不靠单测，功能路径（onChange → PUT 调用、按钮 → POST 调用）由 component test 覆盖。

### 11.5 真实浏览器验收

改完 `packages/zai/src/server` 与 `packages/zai/src/web`（core 已在 §3.1 那步 `build:core` 过；只有中途又改了 core 才需要再重建）：

```bash
pnpm --filter @zn-ai/zai dev -- --port 8102 --api-port 7715
```

走 `/agent` → 打开设置 → 「会话归档」section 改保留数 → 点「立即归档」→ 确认提示条数，并 `ls ~/.zai/archive/projects/<encoded>/` 核对落盘。**先询问用户**是否要跑这一步（AGENTS.md 规定非必须）。

## 12. 实施顺序

0. core 导出 `sanitizePath` + `pnpm run build:core`（§3.1，唯一改 core 的一步）；
1. `sessionArchive.ts` 服务 + 单测（§11.1）—— 纯函数 + 文件系统，最容易先验证；
2. 启动接入（§6.1）；
3. `routes/sessionArchive.ts` + 挂载 + 路由测试（§11.2）；
4. `ZaiSettings.archive` + 解析/校验 + 两个设置端点 + 测试（§11.3）；
5. `settingsHydrate.ts` clamp helper + 单测 → store → Layout/MobileLayout hydrate（§8.1）；
6. `SettingsDrawer` UI（§8.2）；
7. 真实浏览器验收（§11.5，先问用户）。