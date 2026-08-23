/**
 * ripgrep 桥 — 兼容 shim。
 *
 * 历史：B2 P1-2 阶段手写的 ripgrep 工具桥，依赖 PATH 上有 `rg` 二进制，
 * 否则回退到 Node RegExp（**所有元字符被转义为字面量**）。
 *
 * Phase 4 P1 起，dsh-bridge 改用 harness 原生 `@deepseek-ai/dsh-tool-fs-search`
 * 提供的 `grep` + `glob` 工具——它通过 `@vscode/ripgrep` npm 包携带真二进制，
 * 支持完整 ripgrep 正则、`--type` 过滤、自动 ignore、超额 spill 落盘，
 * 以及结构化 `presentationMeta`（SearchResultView）。
 *
 * 本文件**不再注册**手写 `Ripgrep` 工具，但仍导出 `createRipgrepTool` /
 * `registerRipgrepTool` 给 zai-side 旧 import 路径用（返回 no-op dispose），
 * 避免破坏现存 `from '@zn-ai/dsh-bridge/tools/ripgrep.js'` 引用。
 *
 * 真正注册 `grep` / `glob` 的是 `createDshRuntime.ts` 里的
 * `ctx.loader.create({name:'@deepseek-ai/dsh-tool-fs-search'})` —— 见
 * `dsh-tool-fs-search-integration_2026-08-23/findings.md`。
 */

import type { Context } from '@deepseek-ai/cordis'

export interface RipgrepToolOptions {
  cwd: string
}

/**
 * @deprecated 已被 harness `@deepseek-ai/dsh-tool-fs-search` 的 `grep` 工具取代。
 *             保留此导出仅为兼容 zai-side import, 返回 no-op dispose。
 */
export function createRipgrepTool(_opts: RipgrepToolOptions): never {
  throw new Error(
    '[dsh-bridge] createRipgrepTool is deprecated — use the harness `grep` tool ' +
      '(loaded by @deepseek-ai/dsh-tool-fs-search via createDshRuntime).',
  )
}

/**
 * @deprecated 兼容 shim —— 见 `createRipgrepTool` 注释.
 *             不再注册手写 `Ripgrep` 工具到 dsh ctx.tools,
 *             返回 no-op 函数让 `disposers.push(...)` 链路不报错.
 */
export function registerRipgrepTool(
  _ctx: Context,
  _opts: RipgrepToolOptions,
): () => void {
  // No-op: harness `@deepseek-ai/dsh-tool-fs-search` 已在 createDshRuntime
  // 装载阶段把 `grep` / `glob` 工具注册到 ctx.tools. 此处若再注册一个
  // 名为 `Ripgrep` 的旧工具会与 harness 路径产生 tool name 不一致问题.
  // 保留此函数仅为兼容 zai-side 历史 import, 不做实际工作.
  return () => {}
}