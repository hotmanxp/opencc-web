export interface DesktopFsEntry {
  name: string
  kind: 'file' | 'dir'
  /** 完整子路径(服务端 path.join 生成,OS-native 分隔符——跨平台不必在前端拼) */
  path: string
  size: number
  mtime: number
  /** 服务端白名单命中 → 可预览;缺省/未命中 → 调系统默认应用打开 */
  preview?: boolean
}
export interface DesktopFsList {
  ok: boolean
  path?: string
  home?: string
  parent?: string | null
  entries?: DesktopFsEntry[]
  error?: string
}
export interface DesktopFsFile {
  ok: boolean
  mime?: string
  dataUrl?: string
  error?: string
}
export interface DesktopOpen {
  ok: boolean
  error?: string
}
