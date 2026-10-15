# Vendor FileWriteTool 无符号链接拒绝 —— 权限检查在链接路径上评估、写入落到链接目标

**日期：** 2026-10-05
**发现者：** `--by claude`
**状态：** 已确认，未修复（**故意未移植**，`da74a635`）
**严重度：** 高（权限边界绕过，可写出被检查路径之外的文件）

## 摘要

opencc 上游已加入 `symlinkDenyDecision`，Write 与 Edit 都会在写入前用 `lstat`
拒绝符号链接。zai 的 vendor 副本**没有移植这道守卫**，且 vendor 的
`writeFileSyncAndFlush_DEPRECATED` **显式读取符号链接并穿透写入**。

结果是：权限检查在**链接本身**的路径上评估（通过），实际写入落在
**链接指向的目标**上（未检查）。攻击者只需在仓库里放一个符号链接
（`.git/hooks/` 下的条目、checkout 出来的树里任意一个 planted link），
模型的 Write 就能写到权限系统看不见的地方。

## 位置

| 文件 | 行 | 内容 |
|------|----|------|
| `packages/zn-agent-core/src/opencc-src/utils/file.ts` | 373-383 | **显式读链接并穿透写入** |
| 同上 | 97 | `writeTextContent` → 调用点 |
| `packages/zn-agent-core/src/opencc-src/tools/FileWriteTool/FileWriteTool.ts` | 136 | `checkWritePermissionForTool` —— 权限检查 |
| 同上 | 308 | 调用 `writeTextContent` |
| 上游 `/Users/ethan/code/opencc/src/tools/FileWriteTool/FileWriteTool.ts` | 149 | `symlinkDenyDecision`（vendor 缺失） |
| 同上 | 301, 206 | Write / Edit 两处调用点 |

### vendor 的穿透写实现

```ts
// packages/zn-agent-core/src/opencc-src/utils/file.ts:370-383
// Note: We don't use safeResolvePath here because we need to manually handle
// symlinks to ensure we write to the target while preserving the symlink itself
let targetPath = filePath
try {
  const linkTarget = fs.readlinkSync(filePath)
  targetPath = isAbsolute(linkTarget)
    ? linkTarget
    : resolve(dirname(filePath), linkTarget)
  logForDebugging(`Writing through symlink: ${filePath} -> ${targetPath}`)
} catch {
  // ENOENT or EINVAL — keep targetPath = filePath
}
```

注释把「穿透写入并保留符号链接本身」描述为**有意设计**。
上游后来认定这是缺陷并反转了该行为。

### 上游的修复形态

```ts
// /Users/ethan/code/opencc/src/tools/FileWriteTool/FileWriteTool.ts:149
export function symlinkDenyDecision(...) {
  const stats = lstatSync(fullFilePath)     // lstat, 不是 stat
  ...
  // 注释: Dangling symlink: we know it IS a link but not where it lands.
}
// :301 (Write) 与 :206 (Edit) 两处调用
const symlinkDeny = symlinkDenyDecision(fullFilePath)
if (symlinkDeny) return symlinkDeny
```

## 当时的移植决策记录了错误的理由

commit `da74a635` 决定不移植这道守卫，理由是：

> 本 vendor 的 FileWriteTool 完全没有符号链接逻辑,不对称不存在
> (属未移植而非移植错误)

**结论（守卫缺失）是对的，推理是错的。** vendor 不是「对称且安全」，
而是**以一个上游已经修掉的方式不安全**。「不存在不对称」只说明了没跟着上游改，
没有说明当前行为是安全的 —— 而上游正是从同样的代码出发做出相反判断的。

这个区分很重要：不移植一个上游**已知是安全增强**的补丁，与不移植一个
上游认为是**行为变更**的补丁，风险性质完全不同。

## 失败场景

1. 仓库中存在一个符号链接，例如 `evil.md -> ~/.ssh/authorized_keys`，
   或 `.git/hooks/pre-commit -> /tmp/evil.sh`。这类链接在 checkout 出来的
   树里很常见。
2. 模型对 `evil.md` 调用 Write。
3. `checkWritePermissionForTool`（`FileWriteTool.ts:136`）在 `evil.md` 这个
   **链接路径**上评估权限 —— 通过。
4. `writeTextContent` → `writeFileSyncAndFlush_DEPRECATED` 读链接 →
   `targetPath` 变成 `~/.ssh/authorized_keys` → 写入落地。

**实际效果：绕过整个权限系统写入任意文件。**

一个缓解因素：若模型此前 Read 过该文件，stale-guard
（`FILE_UNEXPECTEDLY_MODIFIED_ERROR`）会先触发 —— 但前提是那个链接指向的
文件**可读**。指向不可读 / 不存在目标的 dangling symlink 不触发任何守卫。

## 修复

1. 从上游移植 `symlinkDenyDecision`，在 `FileWriteTool` 的 Write（:308 附近）
   与 Edit 两条路径上都调用，位置对齐上游的 :301 / :206。
2. 移植后同步处理 `file.ts:373-383` 的穿透写 —— 至少要让它与守卫的决策一致，
   否则守卫通过后仍然穿透，等于没修。
3. **补上这次跳过移植所缺的记录**：在 vendor 侧留注释说明
   「`da74a635` 曾判定此处无需对齐上游，理由为『不存在不对称』；
   实际是跳过了上游的安全增强，重估于 2026-10-05」，
   避免下一轮 vendor 同步时再次按同一理由跳过。

## 关联问题

- 同属「vendor 与上游漂移」的还有
  `docs/bugs/2026-10-05-vendor-type-gate-blind-spot.md` 记录的类型闸门失明 ——
  两者都是 vendor 同步流程缺少系统性校验导致的。
- `docs/bugs/2026-10-05-non-atomic-write-data-loss.md` 描述的 `fsWrite.ts`
  截断写入与本条是不同的问题（本条是链接穿透，那条是写入原子性），
  但两者都能让「写入落到非预期位置」，建议一并复核 `file.ts:386` 之后的
  tmp+rename 逻辑对 `targetPath` 的处理。
