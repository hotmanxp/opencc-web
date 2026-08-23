/**
 * fs 工具桥 — **Phase 5P2: DEPRECATED**。
 *
 * 本文件是 dsh-bridge 自实现的 FileRead/FileWrite/FileEdit/FileStat 4 个工具。
 * Phase 5P2 起改由 harness 原生 `@deepseek-ai/dsh-tool-fs` 替换:
 *   - 上游工具名:`read` / `write` / `edit` / `read_image`(无 stat 工具)
 *   - 注册路径:由 dsh-bridge.patch.yml 的 `tool-fs` row 自动装载
 *   - 注册后 invariant:zai-side factory 不再调 `registerFsTools`
 *     (见 packages/dsh-bridge/src/tools/registry.ts:122-126 注释段)。
 *
 * 保留本文件仅为:
 *   1. zai-side 历史 import 路径兼容 (`createFileReadTool` / `FsToolOptions` 等)。
 *   2. 误调 `registerFsTools` 时给出清晰错误。
 *
 * 不再做任何文件 I/O — 真正执行来自 `@deepseek-ai/dsh-tool-fs` 的 `read/write/edit`。
 */

import type { Context } from '@deepseek-ai/cordis'

/** @deprecated Use upstream `@deepseek-ai/dsh-tool-fs` (auto-loaded). */
export interface FsToolOptions {
  /** 当前 cwd — 仅保留字段类型以兼容旧 import 路径;不再被任何函数使用。 */
  cwd: string
}

/**
 * @deprecated Use upstream `read` tool from `@deepseek-ai/dsh-tool-fs`.
 *             本函数返回 null-shape stub,如有人误用须显式抛错。
 */
export function createFileReadTool(_opts: FsToolOptions): never {
  throw new Error(
    '[dsh-bridge] createFileReadTool is deprecated — use `read` tool from ' +
      '@deepseek-ai/dsh-tool-fs (auto-loaded via dsh-bridge.patch.yml).',
  )
}

/** @deprecated Use upstream `write` tool from `@deepseek-ai/dsh-tool-fs`. */
export function createFileWriteTool(_opts: FsToolOptions): never {
  throw new Error(
    '[dsh-bridge] createFileWriteTool is deprecated — use `write` tool from ' +
      '@deepseek-ai/dsh-tool-fs.',
  )
}

/** @deprecated Use upstream `edit` tool from `@deepseek-ai/dsh-tool-fs`. */
export function createFileEditTool(_opts: FsToolOptions): never {
  throw new Error(
    '[dsh-bridge] createFileEditTool is deprecated — use `edit` tool from ' +
      '@deepseek-ai/dsh-tool-fs.',
  )
}

/**
 * @deprecated Use `ctx.fs.stat(target)` from `@deepseek-ai/dsh-fs` directly.
 *             上游 `@deepseek-ai/dsh-tool-fs` **不**暴露 `stat` tool — 模型
 *             需要 fs metadata 时,走 `ctx.fs.stat(target)` 或 `ctx.fs.lstat(path)`
 *             后端调用。
 */
export function createFileStatTool(_opts: FsToolOptions): never {
  throw new Error(
    '[dsh-bridge] createFileStatTool is deprecated — use `ctx.fs.stat(target)` ' +
      'from @deepseek-ai/dsh-fs (service loaded via ctx.plugin(LocalFileSystem)).',
  )
}

/**
 * @deprecated Use upstream `@deepseek-ai/dsh-tool-fs` (auto-loaded).
 *             本函数保留仅为兼容旧 zai-side `registerZaiTools({cwd})` 入口;
 *             调用立即抛错 — registry.ts 不再调用本函数。
 */
export function registerFsTools(
  _ctx: Context,
  _opts: FsToolOptions,
): Array<() => void> {
  throw new Error(
    '[dsh-bridge] registerFsTools is deprecated — fs 工具现在由 ' +
      '@deepseek-ai/dsh-tool-fs 自动注册 (read / write / edit / read_image)。',
  )
}
