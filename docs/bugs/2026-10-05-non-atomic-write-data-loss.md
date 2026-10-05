# 文件保存截断写入导致用户数据丢失

**日期：** 2026-10-05
**发现者：** `--by opencc`
**状态：** 已确认，未修复
**严重度：** 严重（不可逆的用户数据丢失）

## 摘要

`PUT /api/fs/file`（前端分屏文件编辑器的唯一保存路径）用 `writeFile` 直接覆盖目标文件，
Node 默认 flag `'w'` = `O_WRONLY|O_CREAT|O_TRUNC` —— **文件在 fd 打开的瞬间即被截断为 0 字节**，
内容才开始写入。没有 tmp+rename，没有备份。

open 之后任何失败（`ENOSPC`、`EIO`、SIGKILL、进程崩溃、断电）都会留下 0 字节或半截文件，
**原内容无法恢复**，而 UI 只收到一个干净的 500 报错。

## 位置

| 文件 | 行 | 内容 |
|------|----|------|
| `packages/zai/src/server/utils/fsWrite.ts` | 85 | `await writeFile(absPath, content, 'utf8');` |
| `packages/zai/src/server/routes/fs.ts` | 593 | 调用点 `writeTextFile(safe.abs, content, { ifMatch })` |
| `packages/zai/src/web/src/components/splitPane/useFsWrite.ts` | — | 前端调用方 |

上限 `MAX_FILE_BYTES` 为 2MB，截断窗口不小。

## 为什么这是"同一个 bug 被漏掉的一处"

本项目**已经诊断并修复过完全相同的缺陷**。`packages/zai/src/server/services/instanceStore.ts:110-114`
的注释是原始事故记录：

> 直接 `writeFile(path, ...)` 会在 open('w') 截断后、内容写完前被 SIGKILL 打中,
> 留下一个空文件 —— 下次启动所有实例定义凭空消失,这就是 2026-09-28 那次
> `instances.json` 变成 0 字节的机制。

修复后 `instanceStore`（lock + tmp+rename + `.corrupt` 保留）、`zaiSettingsStore`、
`fileStore`、`WeixinPairingStore`、`ContextTokenStore` 全部改用了 tmp+rename。

`fsWrite.ts` 是唯一直接写**用户源码**（而非应用状态）的路径，恰好被漏掉。
同一个 bug 类，项目在应用状态上栽过一次并修好，在用户数据上留着。

## 复现

```
写入前：1200 bytes
open("w") 之后：0 bytes     ← 原内容此刻已丢失
```

任何在 open 之后、rename 之前发生的失败都会留下 0 字节文件。
`sleep`/强制 kill 父进程可稳定复现（open 与 write 之间存在竞态窗口）。

## 修复

照抄 `instanceStore` 的现成模式：

1. 在目标文件同目录写临时文件 `${absPath}.${process.pid}.tmp`
2. `rename(tmp, absPath)` —— 同文件系统内 rename 是原子的，读者要么看到旧内容要么看到新内容
3. 失败时 `unlink(tmp).catch(() => {})`，不要把 tmp 留在用户目录里

注意保留现有的 `ifMatch`（sha256 乐观锁）语义与错误码映射（`ENOENT` / `EACCES` /
`ENOSPC` / `CONFLICT`），它们都在 `writeFile` 之前的独立逻辑里，不受影响。

## 关联问题

`fsWrite.ts:99` 的 `const info = await stat(absPath)` 位于 `try/catch` 之外。
Express 是 `^4.21.2` 且无 async wrapper，此处抛错（写入与 stat 之间文件被删、`EACCES`）
会成为 unhandled rejection —— 响应永不发出、客户端挂起，**而文件此时已被修改**。
建议一并纳入 `try/catch`。
