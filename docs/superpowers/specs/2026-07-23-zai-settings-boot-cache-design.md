# zai 启动时 settings.json 加载与全局缓存设计

> 在 `createApp()` 启动初始化时按"zai → claude → OpenCC 默认"三级解析
> `~/.zai/settings.json`,落地到内存缓存供所有读路径共用;写路径通过
> 直接调用保持缓存同步。

---

## 1. 背景与目标

### 1.1 现状

zai 当前有三处独立的 `readZaiSettings()` 重复实现,每次调用都直接读盘:

| 位置 | 同步/异步 | 备注 |
|---|---|---|
| `packages/zai/src/server/services/zaiSettingsStore.ts:18` | async | 规范实现,被 `routes/agentSettings.ts` 使用 |
| `packages/zai/src/server/services/modelCaller.ts:51` | sync (`readFileSync`) | 错误吞掉 → `{}`,用于构造 Anthropic 客户端 |
| `packages/zai/src/server/lib/resolveModel.ts:31` | sync (`readFileSync`) | 解析 5 层 model 优先级 |

- 没有启动时初始化逻辑:`~/.zai/settings.json` 缺失时所有读路径返回 `{}`。
- 没有跨进程共享的内存缓存:每次模型解析、每次 agent/prompt 都重新读盘。
- 第一次启动 zai 的全新用户:没有 OpenCC 凭据、没有 model 配置,settings 永远空。

### 1.2 目标

1. **三级回退初始化** —— `createApp()` 启动时按以下顺序解析 `~/.zai/settings.json`:
   1. `~/.zai/settings.json` 存在且 JSON 合法 → 直接使用
   2. 否则 `~/.claude/settings.json` 存在且 JSON 合法 → 用整个对象种子写入 `~/.zai/settings.json`,再使用
   3. 否则用 zai 内置的 OpenCC 默认值(`BUILTIN_DEFAULT_SETTINGS`)种子写入 `~/.zai/settings.json`,再使用
2. **单一缓存入口** —— 所有读路径统一调用新的 `getCachedZaiSettings()` / `getCachedZaiSettingsSync()`,不再各自读盘。
3. **写路径同步缓存** —— `writeZaiSettings()` 写盘成功后,直接调用 `refreshCache()` 更新内存,无需事件总线、无需文件监听。
4. **消除重复实现** —— `modelCaller.ts` / `resolveModel.ts` 的本地 `readZaiSettings()` 删除,改用缓存 API。

### 1.3 非目标 (YAGNI)

- 不实现文件 watcher / mtime 失效 —— zai 进程是 `settings.json` 的唯一写者,重启即刷新。
- 不实现合并/过滤 OpenCC 字段 —— `~/.claude/settings.json` 整个对象原样拷贝(含 zai 不识别的字段),保持 zai schema 与 OpenCC schema 的松耦合。
- 不实现"settings 变更广播"事件总线 —— `writeZaiSettings` 直接同步刷新缓存,所有读路径立即可见。
- 不实现 agent-core 侧的 `~/.zai/settings.json` 缓存 —— agent-core 的 `opencc-internals/*` 仍走 `~/.claude/settings.json` 路径,与本规格正交。
- 不迁移现有用户 —— 已有 `~/.zai/settings.json` 的用户 tier 1 命中,行为不变。

---

## 2. 架构

```
createApp(opts)                              ← packages/zai/src/server/index.ts
   └─ await initZaiSettingsCache()           ← 新增启动钩子
        ├─ tier 1: read ~/.zai/settings.json
        │    ├─ hit + valid → cache.set(parsed), return
        │    └─ miss / invalid JSON → 继续
        ├─ tier 2: read ~/.claude/settings.json
        │    ├─ hit + valid → cache.set(parsed), await writeZaiSettings(parsed) [seed 落盘]
        │    └─ miss / invalid JSON → 继续
        └─ tier 3: cache.set(BUILTIN_DEFAULT_SETTINGS),
                   await writeZaiSettings(BUILTIN_DEFAULT_SETTINGS) [seed 落盘]

zaiSettingsCache.ts  (新文件, ~90 行)
   ├─ initZaiSettingsCache()         → 执行三级回退,返回 Promise<void>,幂等
   ├─ getCachedZaiSettings()         → async, 返回缓存值;未初始化则 await 初始化
   ├─ getCachedZaiSettingsSync()     → sync, 缓存值或 {} (兜底同现状)
   ├─ refreshCache(value)            → 写路径使用,同步更新缓存
   └─ __resetCacheForTests()         → 测试钩子

zaiSettingsStore.ts  (改动)
   ├─ readZaiSettings()              → 内部改用 getCachedZaiSettings()
   ├─ writeZaiSettings(next)         → 原子写盘 + refreshCache(next) [NEW]
   └─ re-export getCachedZaiSettings / getCachedZaiSettingsSync

调用方迁移:
   modelCaller.ts:51 readZaiSettings()       → getCachedZaiSettingsSync()
   resolveModel.ts:31  readZaiSettings()      → getCachedZaiSettingsSync()
   routes/agentSettings.ts:117,154 readZaiSettings() → 保留 readZaiSettings() (已自动走缓存)
```

---

## 3. 数据流

### 3.1 启动 (cold path, 每进程一次)

```
initZaiSettingsCache()
  let value: ZaiSettings

  // Tier 1
  try {
    value = await readFile(zaiSettingsPath())
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) {
      // fall through
    } else {
      throw err  // 真实 IO 错误向上抛,createApp 启动失败
    }
  }
  if (value !== undefined) {
    cached = value
    return
  }

  // Tier 2
  try {
    value = await readFile(claudeSettingsPath())
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) {
      // fall through
    } else {
      console.warn('[zai-settings-cache] tier-2 read failed:', err)
      // 不阻塞启动,继续 tier 3
    }
  }
  if (value !== undefined) {
    cached = value
    await writeZaiSettings(value).catch(e =>
      console.warn('[zai-settings-cache] tier-2 seed write failed:', e)
    )
    return
  }

  // Tier 3
  cached = BUILTIN_DEFAULT_SETTINGS
  await writeZaiSettings(BUILTIN_DEFAULT_SETTINGS).catch(e =>
    console.warn('[zai-settings-cache] tier-3 seed write failed:', e)
  )
```

### 3.2 写路径 (`PUT /api/agent/settings/output-style` 等)

```
writeZaiSettings(next: ZaiSettings)
  path = zaiSettingsPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path + '.tmp', JSON.stringify(next, null, 2))
  await rename(path + '.tmp', path)        // 原子写
  refreshCache(next)                       // NEW: 直接同步缓存
```

`refreshCache` 与 `rename` 同进程同步执行,无 race。

### 3.3 读路径 (所有调用方)

```
getCachedZaiSettings()       → return cached
getCachedZaiSettingsSync()   → return cached ?? {}
```

零磁盘 I/O。`modelCaller` / `resolveModel` 在初始化未完成时被同步调用时返回 `{}`,与现状"文件缺失"行为一致,首条请求延迟不变。

---

## 4. 接口设计

### 4.1 新增 API (`zaiSettingsCache.ts`)

```ts
/** Tier-3 默认值。 */
export const BUILTIN_DEFAULT_SETTINGS: ZaiSettings = {
  env: {},
  defaultMode: 'default',
  outputStyle: 'default',
}

/** 幂等启动初始化。多次调用共享同一 Promise。 */
export function initZaiSettingsCache(): Promise<void>

/** Async 读缓存。初始化未完成时 await 初始化。 */
export function getCachedZaiSettings(): Promise<ZaiSettings>

/** Sync 读缓存。返回缓存值或 {} (与 readFileSync 错误兜底一致)。 */
export function getCachedZaiSettingsSync(): ZaiSettings

/** 写路径使用,原子替换缓存。 */
export function refreshCache(value: ZaiSettings): void

/** 测试钩子: 清空模块级状态。 */
export function __resetCacheForTests(): void
```

### 4.2 `zaiSettingsStore.ts` 改动

```ts
// 保留: zaiSettingsPath / readZaiSettings / writeZaiSettings / resolveOutputStyle / isValidOutputStyle
// 改动:
//   readZaiSettings() → async getCachedZaiSettings()  (签名不变, 内部实现替换)
//   writeZaiSettings() → 末尾追加 refreshCache(next)
// 新增 re-export: getCachedZaiSettings / getCachedZaiSettingsSync / initZaiSettingsCache
```

### 4.3 `BUILTIN_DEFAULT_SETTINGS` 位置

放在 `packages/zai/src/shared/settings.ts`,与 `ZaiSettings` 类型同处。导出供 `zaiSettingsCache.ts` 与测试共用。

---

## 5. 错误处理

| 场景 | 行为 |
|---|---|
| `~/.zai/settings.json` 不存在 | tier 1 跳过 → tier 2 |
| `~/.zai/settings.json` JSON 非法 | tier 1 跳过 → tier 2 (与现有 `readZaiSettings` 行为一致) |
| `~/.zai/settings.json` 其他 IO 错误 | 抛错,`createApp` 启动失败 (与现状一致 — 真 IO 错误是 bug 信号) |
| `~/.claude/settings.json` 不存在 / 非法 | tier 2 跳过 → tier 3 |
| `~/.claude/settings.json` 其他 IO 错误 | `console.warn` 继续 → tier 3 (不阻塞启动) |
| tier-2 seed 写盘失败 | `console.warn` 继续,缓存已填充,下次 `writeZaiSettings` 会重建文件 |
| tier-3 seed 写盘失败 | `console.warn` 继续,缓存已填充,首次 PUT 会创建文件 |
| 同步读调用先于初始化 | 返回 `{}`,行为与现状"文件缺失"一致 |

---

## 6. 测试

### 6.1 单元测试 (`zaiSettingsCache.test.ts`, 新文件)

mock `node:os` 的 `homedir()` 重定向到 per-test temp 目录(沿用 `zaiSettingsStore.test.ts` 现有 pattern)。

- tier 1 hit:`~/.zai/settings.json` 已存在 → 不读 tier 2/tier 3(spy `readFile` 调用次数)
- tier 1 miss + tier 2 hit:`~/.zai/settings.json` 不存在,`~/.claude/settings.json` 存在 → 缓存填充 + `~/.zai/settings.json` 被 seed
- tier 1 miss + tier 2 miss:→ tier 3 → `~/.zai/settings.json` 被 seed 为 `BUILTIN_DEFAULT_SETTINGS`
- tier 1 非法 JSON:→ 走到 tier 2
- tier 2 非法 JSON:→ 走到 tier 3
- `writeZaiSettings({a:1})` → `getCachedZaiSettings()` 返回 `{a:1}`(同步刷新)
- 同步读调用先于初始化:返回 `{}`
- 异步读调用先于初始化:await 同一 promise
- 幂等:两次 `initZaiSettingsCache()` 只触发一次 tier chain

### 6.2 现有测试更新 (`zaiSettingsStore.test.ts`)

`readZaiSettings` 内部实现改为读缓存,新增 case:
- 初始化前 `readZaiSettings()` → `{}`
- `writeZaiSettings({...})` 后 `readZaiSettings()` → 新值(替代现有的"round-trips through disk"case,因为不再每调用读盘)

### 6.3 集成测试 (可选)

`packages/zai/test/server/agentSettings.test.ts` 现有 case 应继续通过(因为 `readZaiSettings` 签名不变)。

---

## 7. 改动文件清单

| 文件 | 改动 |
|---|---|
| `packages/zai/src/server/services/zaiSettingsCache.ts` | NEW (~90 行) |
| `packages/zai/src/server/services/zaiSettingsStore.ts` | 改 `readZaiSettings` / `writeZaiSettings` 内部,re-export 新 API |
| `packages/zai/src/server/index.ts` | 加 `await initZaiSettingsCache()` 启动钩子 |
| `packages/zai/src/server/services/modelCaller.ts` | 删本地 `readZaiSettings`,改用 `getCachedZaiSettingsSync()` |
| `packages/zai/src/server/lib/resolveModel.ts` | 删本地 `readZaiSettings`,改用 `getCachedZaiSettingsSync()` |
| `packages/zai/src/shared/settings.ts` | 加 `BUILTIN_DEFAULT_SETTINGS` 常量 |
| `packages/zai/src/server/services/zaiSettingsCache.test.ts` | NEW 单元测试 |
| `packages/zai/src/server/services/zaiSettingsStore.test.ts` | 更新 case 适配缓存语义 |

无新公共 API 暴露给前端;web 包通过现有 `GET /api/agent/settings` 读取,语义不变。

---

## 8. 验收标准

- [ ] `createApp()` 启动后 `~/.zai/settings.json` 必定存在(三级回退保证)
- [ ] 三个 `readZaiSettings` 重复实现收敛为一个缓存入口
- [ ] `writeZaiSettings()` 后同一进程内下次 `getCachedZaiSettings()` 立即返回新值,无需重启
- [ ] tier-1 命中场景与改动前行为等价(回归测试全绿)
- [ ] 单元测试覆盖所有 9 个 case (§6.1)
- [ ] 无新增 agent-core 公共 API