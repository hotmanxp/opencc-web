/**
 * vendorSeam 注册表 — zai 与 dsh-bridge 唯一接口。
 *
 * 替代 globalThis 桥(`__zaiDshSubagentControl` / `__zaiDshSubagentDetail`)。
 * zai-side 不再 import `@zn-ai/dsh-bridge` 内部函数,只通过 `kernel.getSeam(name)`。
 */

export class MissingVendorSeamError extends Error {
  constructor(public readonly seamName: string) {
    super(`[zai] MissingVendorSeamError: seam "${seamName}" not registered`)
    this.name = 'MissingVendorSeamError'
  }
}

export type SeamName = 'subagent' | 'jobs'

export class SeamRegistry {
  private readonly seams = new Map<string, unknown>()

  register<T>(name: SeamName, instance: T): void {
    this.seams.set(name, instance)
  }

  get<T>(name: SeamName): T {
    const seam = this.seams.get(name)
    if (!seam) throw new MissingVendorSeamError(name)
    return seam as T
  }

  has(name: SeamName): boolean {
    return this.seams.has(name)
  }

  /** 测试用 — 清空所有 seam。 */
  clear(): void {
    this.seams.clear()
  }
}
