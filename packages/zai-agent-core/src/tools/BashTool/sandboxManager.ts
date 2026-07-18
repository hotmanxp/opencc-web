/**
 * ZaiSandboxManager — 对标 opencc `utils/sandbox/sandbox-adapter.ts` 的 SandboxManager。
 *
 * zai 当前只有 `SandboxConfig`(单一 child_process executor)而无完整 sandbox 框架。
 * 本类把 SandboxConfig 包成 opencc 接口, 让 BashTool 的 `shouldUseSandbox` /
 * `annotateStderrWithSandboxFailures` 等代码可以在 zai 内运行, 同时保留配置语义:
 *
 * - `isSandboxingEnabled()` 永远返回 true (zai 默认开 sandbox)
 * - `getFsReadConfig()` 允许读任何路径
 * - `getFsWriteConfig()` 仅允许写 workdir
 * - `getNetworkRestrictionConfig()` 读 `networkEgress`
 * - `getAllowUnixSockets()` 返回 undefined
 * - `annotateStderrWithSandboxFailures()` 原样返回
 */
import type { SandboxConfig } from '../../runtime/types.js'

export type FsReadConfig = {
  denyOnly: string[]
  allowWithinDeny?: string[]
}

export type FsWriteConfig = {
  allowOnly: string[]
  denyWithinAllow: string[]
}

export type NetworkRestrictionConfig = {
  allowedHosts?: string[]
  deniedHosts?: string[]
}

class ZaiSandboxManager {
  private cfg: SandboxConfig

  constructor(cfg: SandboxConfig) {
    this.cfg = cfg
  }

  /** zai 默认 sandbox 开 — 只有 `ZAI_SANDBOX=off` 时关。runtime 已 enforce。 */
  isSandboxingEnabled(): boolean {
    return this.cfg.executor === 'child_process'
  }

  /** zai sh -c 不限制读路径。 */
  getFsReadConfig(): FsReadConfig {
    return { denyOnly: [] }
  }

  /** 仅允许写 workdir。 */
  getFsWriteConfig(): FsWriteConfig {
    return {
      allowOnly: [this.cfg.workdir],
      denyWithinAllow: [],
    }
  }

  /** 读 networkEgress 字段。 */
  getNetworkRestrictionConfig(): NetworkRestrictionConfig {
    if (this.cfg.networkEgress === 'block') {
      return { allowedHosts: [] }
    }
    return {}
  }

  /** zai 不支持 unix socket sandbox。 */
  getAllowUnixSockets(): string[] | undefined {
    return undefined
  }

  /** zai 不支持 violation 白名单。 */
  getIgnoreViolations(): string[] | undefined {
    return undefined
  }

  /** zai 不注入 sandbox 违规标注 — 原样返回。 */
  annotateStderrWithSandboxFailures(_cmd: string, output: string): string {
    return output
  }

  updateConfig(cfg: SandboxConfig): void {
    this.cfg = cfg
  }

  getConfig(): SandboxConfig {
    return this.cfg
  }
}

let _defaultManager: ZaiSandboxManager | null = null

export function setDefaultSandboxManager(cfg: SandboxConfig): ZaiSandboxManager {
  if (!_defaultManager) {
    _defaultManager = new ZaiSandboxManager(cfg)
  } else {
    _defaultManager.updateConfig(cfg)
  }
  return _defaultManager
}

export function getDefaultSandboxManager(): ZaiSandboxManager | null {
  return _defaultManager
}

/**
 * 便捷访问 — queryEngine / BashTool 调用入口。
 * 若 runtime 未注入 (测试 / 旧路径), 返回 null 让 caller 走 sandbox-not-configured 兜底。
 */
export function getSandboxManager(cfg?: SandboxConfig): ZaiSandboxManager | null {
  if (cfg) return new ZaiSandboxManager(cfg)
  return _defaultManager
}