# 符号链接穿透：resolveSafePath 不跟随链接，写/删可逃出 cwd

**日期：** 2026-10-05
**状态：** 已确认，未修复
**严重度：** 中（写/删逃逸出 cwd 锚定范围）
**发现：** zai

## 摘要

`resolveSafePath` 用 `path.resolve` 做包含性检查，而 **`path.resolve` 不跟随
符号链接**。`safePath.ts` 的注释把这一点记录为「已缓解」，理由是「端点是只读的」。

这个理由**已经不成立了** —— `fs.ts` 里至少两处写/删路径走了同一个检查：
`PUT /fs/file`（写用户源码）和 delete（删文件）。一个 cwd 内的符号链接指向
cwd 外，路径检查通过，实际操作落在链接目标上。

## 位置

| 文件 | 行 | 内容 |
|------|----|------|
| `packages/zai/src/server/utils/safePath.ts` | 10-17 | 注释：「these endpoints are read-only... Mitigated」 |
| `packages/zai/src/server/utils/safePath.ts` | 39 | `const abs = resolve(root, expandTilde(rel))` —— **不 follow symlink** |
| `packages/zai/src/server/routes/fs.ts` | 548 | `resolveSafePath(cwd, rel)` → `writeTextFile(safe.abs, ...)` —— **写** |
| `packages/zai/src/server/routes/fs.ts` | 1516 | `resolveSafePath(cwd, rel)` → 删除 —— **删** |

`safePath.ts:10-17` 原文（已失效的假设）：

> Note: this does NOT follow symlinks (path.resolve does not).
> ... Documented risk: malicious symlinks. Mitigated because the endpoints
> are read-only and the agent core already runs in a sandbox.

## 实证

代码层确认（`sed` 读 `fs.ts:540-556` 与 `:1510-1522`）：
两处都是 `const safe = resolveSafePath(cwd, rel)` 之后直接用 `safe.abs`
去写 / 删，中间**没有任何 `realpath` 解析**。

`safePath.ts:39` 只有 `resolve()`，无 `fs.realpath`。

## 攻击场景

1. 用户（或仓库里的一个恶意依赖的 postinstall）在 cwd 内创建
   `~/.claude/link -> /Users/ethan/.ssh/id_rsa`（或任意目标）。
2. `PUT /api/fs/file { path: "link", content: "..." }` ——
   `resolveSafePath` 认为 `~/.claude/link` 在 cwd 内，放行。
3. 实际写入的是 `~/.ssh/id_rsa`。

反向（删）同理：cwd 内一个指向项目外的目录链接，可被用来删除 cwd 外的文件。

## 为什么原注释的缓解理由失效了

注释写于「端点只读」时期。之后 `fs.ts` 增加了写入与删除能力，复用了同一个
`resolveSafePath` 却没有更新这条安全论证 —— **同一个 helper 的安全前提变了，
代码没变**。

`AGENTS.md` 记录的 macOS 路径白名单绕过（`macos-path-allowlist-resolve-bypass`
skill）描述的是同一类 `resolve` vs `realpath` 的陷阱。

## 修复

1. **对写/删路径补 `realpath` 解析**：用 `fs.realpath` 解析父目录（或解析整个
   路径，文件可能尚不存在时解析父目录），再对解析结果做 `resolveSafePath`。
   需要 `lstat` 区分「路径不存在」与「是链接」。
2. **或者**：给 `resolveSafePath` 加一个 `followSymlinks` 选项，写/删路径传
   `true`，保持只读路径的现有行为不变（性能与语义都更稳）。
3. **更新 `safePath.ts:10-17` 的注释** —— 它现在是**误导性文档**，会让下一个
   读者以为写路径也安全。

注意 TOCTOU：检查与使用之间链接可能被换掉。彻底解法是
`O_NOFOLLOW`（macOS/Linux），但 Node 的 `writeFile` 不直接暴露，
`fs.open` + `O_NOFOLLOW` 需要手写。就当前威胁模型（本地单用户），
realpath 解析已足够。

## 关联

- [DNS rebinding 任意文件读](2026-10-05-dns-rebinding-no-host-check--by-zai.md) ——
  `fs.ts` 内路径校验不一致：preview/raw 无检查，PUT/delete 用 `resolveSafePath`，
  而 `resolveSafePath` 本身对链接无效。
