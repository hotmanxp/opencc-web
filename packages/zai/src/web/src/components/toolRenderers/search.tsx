/**
 * 结构化 grep / glob 渲染器 — Phase 4 P2.
 *
 * 渲染管线对齐现有 fileDisplayRenderer / diffRenderer 模式:
 *   - **renderFull 整块接管**: 与 Edit/Write/FileDisplay 同模式 (跳过默认折叠
 *     面板/参数/结果三段, 直接挂 mount).
 *   - **状态点**: 与 DiffBlock 头部同款 (#3fb950 done / #ff6600 start /
 *     #f85149 error), 让用户一眼看出调用状态.
 *   - **结果列表 = antd Card 数组**: 每个文件一张 Card (与 fileDisplayRenderer
 *     `FileCard` 同款), 头部显示文件名 + 命中数 Tag + 预览/打开目录按钮.
 *   - **匹配行 = monospace gutter + 高亮**: 仿 DiffBlock 的 DiffRowLine 行渲染,
 *     每行左侧行号 (44px 右对齐 gutter) + 行内容, 命中的关键词用 `<mark>` 高亮.
 *   - **截断 footer**: 与 DiffBlock 的 `+N −M` summary 同款, 显示
 *     "showing X of Y — Z more omitted".
 *
 * 数据源: dsh `tool/result.meta` (SearchResultView) 由 dsh-bridge
 * `translate/sessionEvents.ts:tool/result` case 透传, 通过 zod schema 守
 * 卫. meta 缺失/非法时降级到 renderOutput 文本路径 (走 stringFromOutput,
 * 与旧 grepRenderer / globRenderer 一致).
 *
 * 工具名: harness `@deepseek-ai/dsh-tool-fs-search` 注册小写 `grep` / `glob`,
 * 旧大写 `Grep` / `Glob` / `Ripgrep` 仍走 grepRenderer / globRenderer 文本路径.
 */

import React from "react"
import { Button, Card, Space, Tag, Tooltip, Typography } from "antd"
import {
  FileSearchOutlined,
  FolderOpenOutlined,
  EyeOutlined,
} from "@ant-design/icons"
import type { ToolRenderer } from "./types.js"
import type { AgentMessage } from "../../store/useAgentStore.js"
import { useAgentStore } from "../../store/useAgentStore.js"
import { FieldLabel, PreBlock, stringFromOutput, truncate } from "./shared.js"
import { linkifyText } from "../../lib/linkify.js"

// ── 视觉常量 (与 DiffBlock 对齐) ───────────────────────────────────────

const MONO =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"

// 匹配行内 highlight: 复用 GitHub 搜索结果的浅黄底, light/dark 双主题
// 下都能保持 1.5:1 以上的对比度. 不依赖 antd 算法生成的 token.
const MATCH_BG = "rgba(250,173,20,0.22)"
const MATCH_FG = "var(--text, inherit)"

const DOT_COLOR: Record<ToolStatus, string> = {
  start: "#ff6600",
  done: "#3fb950",
  error: "#f85149",
}
type ToolStatus = "start" | "done" | "error"

function statusOf(type: string): ToolStatus {
  if (type === "tool_use:done") return "done"
  if (type === "tool_use:error" || type === "tool_use:invalid" || type === "tool_use:denied") {
    return "error"
  }
  return "start"
}

// ── SearchMeta 形态 (与 harness @deepseek-ai/dsh-tool-fs-search/presentation.ts
//    SearchMeta 保持结构兼容, 不引入 dsh 包依赖) ──────────────────────

interface SearchLineMatch {
  lineNumber: number
  line: string
}
interface SearchFileMatches {
  path: string
  matches: SearchLineMatch[]
}
type SearchMeta =
  | { shape: "matches"; files: SearchFileMatches[]; truncated: boolean; total: number }
  | { shape: "paths"; paths: string[]; truncated: boolean; total: number }

/** 防御式 narrowing: AgentMessage 是 RuntimeEvent 有 `[key: string]: unknown`,
 *  拿到 meta 必须验证形态再渲染. 失败 → undefined → 降级到文本路径. */
function parseSearchMeta(raw: unknown): SearchMeta | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.truncated !== "boolean") return undefined
  if (typeof r.total !== "number") return undefined
  if (r.shape === "matches") {
    if (!Array.isArray(r.files)) return undefined
    const files: SearchFileMatches[] = []
    for (const f of r.files) {
      if (f === null || typeof f !== "object" || Array.isArray(f)) return undefined
      const fr = f as Record<string, unknown>
      if (typeof fr.path !== "string") return undefined
      if (!Array.isArray(fr.matches)) return undefined
      const matches: SearchLineMatch[] = []
      for (const m of fr.matches) {
        if (m === null || typeof m !== "object" || Array.isArray(m)) return undefined
        const mr = m as Record<string, unknown>
        if (typeof mr.lineNumber !== "number" || typeof mr.line !== "string") {
          return undefined
        }
        matches.push({ lineNumber: mr.lineNumber, line: mr.line })
      }
      files.push({ path: fr.path, matches })
    }
    return { shape: "matches", files, truncated: r.truncated, total: r.total }
  }
  if (r.shape === "paths") {
    if (!Array.isArray(r.paths)) return undefined
    const paths: string[] = []
    for (const p of r.paths) {
      if (typeof p !== "string") return undefined
      paths.push(p)
    }
    return { shape: "paths", paths, truncated: r.truncated, total: r.total }
  }
  return undefined
}

// ── 高亮渲染 ────────────────────────────────────────────────────────────

/**
 * 在文本中按 pattern 高亮所有出现 — 用于 grep matches 行内显示命中片段.
 * pattern 为空或无效时返回原文. 转义 <>& 防止 XSS, 保留空格和换行.
 */
function highlightMatches(text: string, pattern: string): React.ReactNode {
  if (!pattern) return text
  // 防御: regex 编译失败 → 原文
  let regex: RegExp
  try {
    regex = new RegExp(pattern, "g")
  } catch {
    return text
  }
  const parts: React.ReactNode[] = []
  let lastIdx = 0
  for (const m of text.matchAll(regex)) {
    const idx = m.index ?? 0
    if (idx > lastIdx) parts.push(text.slice(lastIdx, idx))
    parts.push(
      <mark
        key={`m-${idx}`}
        style={{
          background: MATCH_BG,
          color: MATCH_FG,
          padding: "0 2px",
          borderRadius: 2,
          fontWeight: 600,
        }}
      >
        {m[0]}
      </mark>,
    )
    lastIdx = idx + m[0].length
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx))
  return parts.length > 0 ? parts : text
}

// ── 输入区域 (Phase 4 P1 风格: FieldLabel + PreBlock, 与 bash 一致) ──

/** grep 输入: pattern + path + include (harness tool-fs-search grep 接受 include 过滤 glob) */
function renderGrepInput(input: Record<string, unknown>): React.ReactNode {
  const pattern = typeof input.pattern === "string" ? input.pattern : ""
  const path = typeof input.path === "string" ? input.path : ""
  const include = typeof input.include === "string" ? input.include : ""
  const showInclude = include && include.trim().length > 0
  return (
    <div>
      <FieldLabel>pattern</FieldLabel>
      <PreBlock>{linkifyText(pattern)}</PreBlock>
      {path && (
        <>
          <FieldLabel>path</FieldLabel>
          <PreBlock>{linkifyText(path)}</PreBlock>
        </>
      )}
      {showInclude && (
        <>
          <FieldLabel>include</FieldLabel>
          <PreBlock>{linkifyText(include)}</PreBlock>
        </>
      )}
    </div>
  )
}

/** glob 输入: 只有 pattern + path. include 是 grep 专属, 不展示 (避免误导用户) */
function renderGlobInput(input: Record<string, unknown>): React.ReactNode {
  const pattern = typeof input.pattern === "string" ? input.pattern : ""
  const path = typeof input.path === "string" ? input.path : ""
  return (
    <div>
      <FieldLabel>pattern</FieldLabel>
      <PreBlock>{linkifyText(pattern)}</PreBlock>
      {path && (
        <>
          <FieldLabel>path</FieldLabel>
          <PreBlock>{linkifyText(path)}</PreBlock>
        </>
      )}
    </div>
  )
}

// ── 行为: openFilePreview + reveal (与 fileDisplay FileCard 同套) ─────

function openInFinder(path: string): void {
  // 与 FileCard.onReveal 完全相同 — reveal endpoint, fire-and-forget,
  // 不阻塞 UI. 错误被 fetch 静默吞, 用户体验: 点了一下没反应 = 系统没装 Finder
  void fetch("/api/fs/reveal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  })
}

// ── 渲染: matches 形态 (grep) ──────────────────────────────────────────

interface MatchCardProps {
  filePath: string
  matches: SearchLineMatch[]
  pattern: string
}

/**
 * 一张文件 Card: 顶部文件名 + 命中数 + 按钮, 主体每个 match 一行.
 * 仿 fileDisplay.FileCard 布局 + DiffBlock 行样式.
 */
function MatchCard({ filePath, matches, pattern }: MatchCardProps) {
  const openFilePreview = useAgentStore((s) => s.openFilePreview)
  const displayName = filePath.split("/").pop() ?? filePath
  return (
    <Card size="small" style={{ marginBottom: 8 }} data-testid="grep-match-card">
      <Space direction="vertical" size={4} style={{ width: "100%" }}>
        <Space style={{ width: "100%", justifyContent: "space-between" }}>
          <Space>
            <FileSearchOutlined style={{ color: "var(--text-dim-65)" }} />
            <Typography.Text strong>{displayName}</Typography.Text>
            <Tag color="warning">{matches.length} 处命中</Tag>
          </Space>
          <Space>
            <Tooltip title="在预览抽屉中打开文件">
              <Button
                size="small"
                icon={<EyeOutlined />}
                onClick={() => openFilePreview(filePath)}
                data-testid="grep-open-preview"
              >
                预览
              </Button>
            </Tooltip>
            <Tooltip title="在文件管理器中显示">
              <Button
                size="small"
                icon={<FolderOpenOutlined />}
                onClick={() => openInFinder(filePath)}
                data-testid="grep-reveal"
              >
                打开目录
              </Button>
            </Tooltip>
          </Space>
        </Space>
        <Typography.Text
          type="secondary"
          ellipsis
          style={{ maxWidth: "100%", fontSize: 12 }}
          title={filePath}
        >
          {filePath}
        </Typography.Text>
        {/* matches 行: monospace gutter + 高亮行内容, 与 DiffRowLine 同款 */}
        <div
          style={{
            fontFamily: MONO,
            fontSize: 12,
            lineHeight: 1.55,
            border: "1px solid var(--border-light)",
            borderRadius: 6,
            padding: "6px 0",
            maxHeight: 280,
            overflow: "auto",
            background: "var(--bg-faint-02)",
          }}
          data-testid="grep-match-list"
        >
          {matches.map((m, idx) => (
            <div
              key={`${m.lineNumber}:${idx}`}
              style={{ display: "flex", minWidth: "max-content" }}
              data-testid="grep-match-line"
            >
              <span
                style={{
                  flexShrink: 0,
                  width: 52,
                  textAlign: "right",
                  paddingRight: 10,
                  color: "var(--text-dim-30)",
                  userSelect: "none",
                }}
              >
                {m.lineNumber}
              </span>
              <span
                style={{
                  whiteSpace: "pre",
                  paddingRight: 12,
                  color: "var(--text)",
                }}
              >
                {highlightMatches(m.line, pattern)}
              </span>
            </div>
          ))}
        </div>
      </Space>
    </Card>
  )
}

function renderMatches(meta: SearchMeta & { shape: "matches" }, pattern: string): React.ReactNode {
  if (meta.files.length === 0) {
    return (
      <PreBlock variant="muted">No matches found</PreBlock>
    )
  }
  return (
    <div data-testid="grep-results">
      {meta.files.map((f, i) => (
        <MatchCard key={`${f.path}:${i}`} filePath={f.path} matches={f.matches} pattern={pattern} />
      ))}
    </div>
  )
}

// ── 渲染: paths 形态 (glob) ───────────────────────────────────────────

interface PathCardProps {
  filePath: string
}

function PathCard({ filePath }: PathCardProps) {
  const openFilePreview = useAgentStore((s) => s.openFilePreview)
  const displayName = filePath.split("/").pop() ?? filePath
  return (
    <Card size="small" style={{ marginBottom: 6 }} data-testid="glob-path-card">
      <Space style={{ width: "100%", justifyContent: "space-between" }}>
        <Space>
          <FileSearchOutlined style={{ color: "var(--text-dim-65)" }} />
          <Typography.Text>{displayName}</Typography.Text>
          <Typography.Text type="secondary" ellipsis style={{ maxWidth: 400, fontSize: 12 }}>
            {filePath}
          </Typography.Text>
        </Space>
        <Space>
          <Tooltip title="在预览抽屉中打开文件">
            <Button
              size="small"
              icon={<EyeOutlined />}
              onClick={() => openFilePreview(filePath)}
              data-testid="glob-open-preview"
            >
              预览
            </Button>
          </Tooltip>
          <Tooltip title="在文件管理器中显示">
            <Button
              size="small"
              icon={<FolderOpenOutlined />}
              onClick={() => openInFinder(filePath)}
              data-testid="glob-reveal"
            >
              打开目录
            </Button>
          </Tooltip>
        </Space>
      </Space>
    </Card>
  )
}

function renderPaths(meta: SearchMeta & { shape: "paths" }): React.ReactNode {
  if (meta.paths.length === 0) {
    return <PreBlock variant="muted">No files found</PreBlock>
  }
  return (
    <div data-testid="glob-results">
      {meta.paths.map((p, i) => (
        <PathCard key={`${p}:${i}`} filePath={p} />
      ))}
    </div>
  )
}

// ── 截断 footer (与 DiffBlock `summary` 同款视觉密度) ──────────────────

function renderTruncatedFooter(meta: SearchMeta): React.ReactNode {
  if (!meta.truncated) return null
  const shown =
    meta.shape === "matches"
      ? meta.files.reduce((acc, f) => acc + f.matches.length, 0)
      : meta.paths.length
  const omitted = Math.max(0, meta.total - shown)
  // overflow-y: auto 容器内 footer 单独占一行, 不挤压上方主体
  return (
    <div
      style={{
        marginTop: 4,
        fontSize: 11,
        color: "var(--text-dim-55)",
        fontFamily: MONO,
      }}
      data-testid="search-truncated-footer"
    >
      showing {shown} of {meta.total}
      {omitted > 0 ? ` — ${omitted} more omitted` : ""}
    </div>
  )
}

// ── 公共基础组件: 状态点 + 工具名 + 摘要 ──────────────────────────────

interface HeaderProps {
  status: ToolStatus
  toolName: string
  summary: string
}

function ToolHeader({ status, toolName, summary }: HeaderProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontFamily: MONO,
        fontSize: 13,
        marginBottom: 8,
        minWidth: 0,
      }}
      data-testid="search-tool-header"
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: DOT_COLOR[status],
          flexShrink: 0,
        }}
      />
      <span style={{ color: "var(--text-dim-90)", fontWeight: 600 }}>
        {toolName}
      </span>
      {summary && (
        <span
          style={{
            color: "var(--text-dim-55)",
            flexShrink: 0,
            marginLeft: 4,
          }}
        >
          {summary}
        </span>
      )}
    </div>
  )
}

// ── grep renderer (renderFull 接管, 仿 fileDisplay + DiffBlock) ──────

export const structuredGrepRenderer: ToolRenderer = {
  preview(input) {
    if (typeof input.pattern !== "string") return ""
    const path = typeof input.path === "string" ? ` in ${input.path}` : ""
    return truncate(`${input.pattern}${path}`, 80)
  },

  renderFull(msg: AgentMessage) {
    const rawMeta = (msg as { meta?: unknown }).meta
    const meta = parseSearchMeta(rawMeta)
    const input = (msg.input as Record<string, unknown>) ?? {}
    const pattern = typeof input.pattern === "string" ? input.pattern : ""
    const status = statusOf((msg.type as string) ?? "tool_use:start")

    // Summary: total + 文件数 + truncated 状态
    let summary = ""
    if (meta?.shape === "matches") {
      const fileCount = meta.files.length
      const matchCount = meta.files.reduce((acc, f) => acc + f.matches.length, 0)
      summary = `Found ${meta.total} matches in ${fileCount} ${fileCount === 1 ? "file" : "files"}`
      if (meta.truncated) summary += " (capped)"
    } else if (meta?.shape === "paths") {
      summary = `Found ${meta.total} ${meta.total === 1 ? "file" : "files"}`
      if (meta.truncated) summary += " (capped)"
    } else {
      // meta 缺失: 走文本路径 (与 fallback renderOutput 一致)
      const text = stringFromOutput(msg.output)
      return (
        <div style={{ marginBottom: 8 }}>
          <ToolHeader status={status} toolName="Grep" summary="" />
          {renderGrepInput(input)}
          <FieldLabel>结果</FieldLabel>
          {text ? (
            <PreBlock variant="success">{linkifyText(text)}</PreBlock>
          ) : (
            <PreBlock variant="muted">No output</PreBlock>
          )}
        </div>
      )
    }

    return (
      <div style={{ marginBottom: 8 }} data-testid="structured-grep">
        <ToolHeader status={status} toolName="Grep" summary={summary} />
        {renderGrepInput(input)}
        {meta.shape === "matches" && renderMatches(meta, pattern)}
        {meta.shape === "paths" && renderPaths(meta, pattern)}
        {renderTruncatedFooter(meta)}
      </div>
    )
  },

  // Fallback: meta 缺失时由 MessageBubble 标准路径调用 (renderOutput).
  // 保持与 grepRenderer 一致的文本 fallback, 让旧 transcript 历史不破坏.
  // 签名严格保持 (output, isError) — 不引入新参数, 不破坏 opencc 路径.
  renderOutput(output, _isError) {
    const text = stringFromOutput(output)
    if (!text) return null
    return <PreBlock variant="success">{linkifyText(text)}</PreBlock>
  },
}

// ── glob renderer (同样 renderFull 接管) ──────────────────────────────

export const structuredGlobRenderer: ToolRenderer = {
  preview(input) {
    if (typeof input.pattern !== "string") return ""
    const path = typeof input.path === "string" ? ` in ${input.path}` : ""
    return truncate(`${input.pattern}${path}`, 80)
  },

  renderFull(msg: AgentMessage) {
    const rawMeta = (msg as { meta?: unknown }).meta
    const meta = parseSearchMeta(rawMeta)
    const input = (msg.input as Record<string, unknown>) ?? {}
    const status = statusOf((msg.type as string) ?? "tool_use:start")

    let summary = ""
    if (meta?.shape === "paths") {
      summary = `Found ${meta.total} ${meta.total === 1 ? "file" : "files"}`
      if (meta.truncated) summary += " (capped)"
    } else if (meta?.shape === "matches") {
      // glob 理论上不会收 matches; 防御性渲染
      const fileCount = meta.files.length
      summary = `Found ${meta.total} matches in ${fileCount} ${fileCount === 1 ? "file" : "files"}`
    } else {
      const text = stringFromOutput(msg.output)
      return (
        <div style={{ marginBottom: 8 }}>
          <ToolHeader status={status} toolName="Glob" summary="" />
          {renderGlobInput(input)}
          <FieldLabel>结果</FieldLabel>
          {text ? (
            <PreBlock variant="success">{linkifyText(text)}</PreBlock>
          ) : (
            <PreBlock variant="muted">No output</PreBlock>
          )}
        </div>
      )
    }

    return (
      <div style={{ marginBottom: 8 }} data-testid="structured-glob">
        <ToolHeader status={status} toolName="Glob" summary={summary} />
        {renderGlobInput(input)}
        {meta.shape === "paths" && renderPaths(meta, "")}
        {meta.shape === "matches" && renderMatches(meta, "")}
        {renderTruncatedFooter(meta)}
      </div>
    )
  },

  renderOutput(output, _isError) {
    const text = stringFromOutput(output)
    if (!text) return null
    return <PreBlock variant="success">{linkifyText(text)}</PreBlock>
  },
}