import { randomUUID } from 'crypto'
import { join } from 'path'

/**
 * Transcript 路径布局 (对齐 opencc `<config>/projects/<sanitized-cwd>/`):
 *
 *   <dataDir>/
 *     transcripts/
 *       projects/                       # 新:按 cwd 分文件夹
 *         -<sanitized-cwd>/            # 主 session 平铺
 *           <sessionId>.json
 *           subagents/
 *             <subSessionId>.json      # sub-agent 独立子目录
 *
 * 注意:这是硬切换,旧版 `<dataDir>/transcripts/<id>.json` 平铺布局不再被读取/写入,
 * 既有 transcript 文件保留在磁盘上但不会被 store 列出 (`transcriptDir` 仍返回旧路径,
 * 仅供极少数历史代码引用,不在新路径里写)。
 */

const PROJECTS_DIR = 'projects'
const SUBAGENTS_DIR = 'subagents'
const MAX_SANITIZED_LENGTH = 80

/**
 * 把 cwd 转成文件系统安全的目录名。
 * 规则 (从 opencc `src/utils/sessionStoragePortable.ts:311` 移植):
 * - 非字母数字字符全部替换为 `-`
 * - 长度 > 80 时截断并追加 `-<djb2 hash>` 后缀,保证同一 cwd 永远得到同一目录名
 */
export function sanitizePath(cwd: string): string {
  const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized
  const hash = djb2Hash(cwd)
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`
}

function djb2Hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(36)
}

/** Memoized projectDir: 同一 cwd 永远返回同一路径,避免 cwd 变化导致目录漂移。 */
const projectDirCache = new Map<string, string>()
export function projectDir(dataDir: string, cwd: string): string {
  const key = `${dataDir}\0${cwd}`
  const cached = projectDirCache.get(key)
  if (cached) return cached
  const dir = join(transcriptsRoot(dataDir), PROJECTS_DIR, sanitizePath(cwd))
  projectDirCache.set(key, dir)
  return dir
}

/** 仅供测试使用:清空 memoize 缓存。 */
export function __resetProjectDirCacheForTest(): void {
  projectDirCache.clear()
}

/** `<dataDir>/transcripts` —— transcripts 根目录 (旧 API,保留以兼容既有调用)。 */
export function transcriptDir(dataDir: string): string {
  return join(dataDir, 'transcripts')
}

/** 新路径: `<dataDir>/transcripts` (与旧 transcriptDir 一致,语义更明确)。 */
export function transcriptsRoot(dataDir: string): string {
  return join(dataDir, 'transcripts')
}

/** Subagent 子目录相对路径 —— 供 queryEngine / listAllProjects 等需要显式拼装的地方复用。 */
export function subagentsDirName(): string {
  return SUBAGENTS_DIR
}

export interface TranscriptPathOptions {
  /** 主 session 的 cwd,用于定位 projectDir;缺失则回退到旧扁平路径。 */
  cwd?: string
  /** subagent session 文件应放在 projectDir/subagents/ 下 */
  subagent?: boolean
}

/**
 * 计算单个 transcript 文件的绝对路径。
 *
 * - 给出 cwd → 走 `<dataDir>/transcripts/projects/<sanitized>/[subagents/]<id>.json`
 * - 缺 cwd → 回退到旧扁平路径 `<dataDir>/transcripts/<id>.json` (硬切,只兜底测试 /
 *   还没透传 cwd 的旧调用点;新代码必须传 cwd)
 */
export function transcriptPath(
  dataDir: string,
  transcriptId: string,
  opts: TranscriptPathOptions = {},
): string {
  if (opts.cwd) {
    const base = projectDir(dataDir, opts.cwd)
    return opts.subagent
      ? join(base, SUBAGENTS_DIR, `${transcriptId}.json`)
      : join(base, `${transcriptId}.json`)
  }
  // 兜底:老扁平布局,不再写但保留以免破坏没迁移的旧调用
  return join(transcriptDir(dataDir), `${transcriptId}.json`)
}

export function generateTranscriptId(): string {
  return `sess-${randomUUID()}`
}

export function parseTranscriptId(id: string): string | null {
  return /^sess-[0-9a-f-]{36}$/i.test(id) ? id : null
}