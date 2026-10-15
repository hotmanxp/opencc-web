# settings.json 双写者共用同一 tmp 路径导致静默丢更新

**日期：** 2026-10-05
**发现者：** `--by opencc`
**状态：** 已确认，未修复
**严重度：** 高（静默数据丢失 + 假成功响应）

## 摘要

两个互不感知的写入者对 `~/.zai/settings.json` 使用**完全相同的固定临时文件名**，
且其中一个不在串行化链内。并发写入时，先完成者的 `rename` 会把**对方的内容**
发给请求方并返回 `{ok: true}` —— 静默丢更新，且调用方拿到的是假的成功信号。

## 位置

| 文件 | 行 | 内容 |
|------|----|------|
| `packages/zai/src/server/services/zaiSettingsStore.ts` | 85 | `const tmpPath = \`${path}.tmp\`` |
| `packages/zai/src/server/services/fileStore.ts` | 70 | `const tmpPath = \`${path}.tmp\`` |

两者都解析到同一目标文件：`fileStore.ts:9-10` 的 `CONFIG_PATHS` 把 `zai` 与 `opencc`
都映射到 `join(homedir(), '.zai', 'settings.json')`，与 `zaiSettingsPath()` 一致。

## 根因

`zaiSettingsStore.ts:64-73` 的 `enqueueMutation` 链（`mutationChain`）只串行化
**它自己的调用方**（`writeZaiSettings` / `updateZaiSettings`）。

`fileStore.writeConfig` 不在这条链里，可从 `PUT /api/config/zai`
（`packages/zai/src/server/routes/config.ts:183`）到达。

## 失效路径

并发 `PUT /api/config/zai` + `PUT /api/agent/settings`：

1. A `writeFile(tmp)` 写入 A 的内容
2. B `writeFile(tmp)` **覆盖**同一 tmp 文件，写入 B 的内容
3. A `rename(tmp, path)` —— 发出的是 **B 的内容**，同时向 A 返回 `{ok: true}`
4. B `rename(tmp, path)` —— tmp 已不存在，抛 `ENOENT` → 500

A 的请求静默丢失了它的写入，却报告成功。

## 与已有设计的冲突

`zaiSettingsStore.ts:53-58` 的注释明确写了这个链要防的正是这类交错写入 ——
修复不完整，漏掉了 `fileStore` 这条并行路径。

`instanceStore.ts:114` 已经给出了正确写法：临时名带 pid
（`${path}.${process.pid}.tmp`），天然避免同进程内两个写者撞名。

## 修复

两个方向，任选其一（推荐第一个）：

1. **tmp 名带 pid**（与 `instanceStore` 对齐）：把两处的 `${path}.tmp` 改为
   `${path}.${process.pid}.tmp`，并确保失败路径 `unlink` 自己的 tmp。
   改动最小，且能同时防御未来新增的第三个写者。
2. **把 `fileStore.writeConfig` 并入 `enqueueMutation`**：语义更彻底，但需要
   `fileStore` 依赖 `zaiSettingsStore`，注意不要引入循环依赖。

## 同类未修路径

以下两处同为「原地 `writeFile` + 解析失败静默回落默认值」，与本 bug 同源，
严重度低于上面两条但同属一个根因家族：

- `packages/zai/src/server/services/factorySettings.ts:183`（写）/ `:151-154`（读）
  —— 文件被截断后，`docsDir` / `repoRoot` / 归档设置静默丢失，
  下一次 `setFactorySettings` 会把默认值**持久化覆盖**回去，丢失变为永久。
- `packages/zai/src/server/services/taskFactoryBridge.ts:89`（写）/ `:76-79`（读）
  —— 同上，`supervisorSessionId` 丢失后 `injectSupervisorCommand` 永久 no-op。
