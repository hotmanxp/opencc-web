/**
 * fileDisplayRenderer — display_files 工具的 React 渲染。
 * 走 renderFull 整块接管 (header + card list),与 Edit/Write 的 diffRenderer 同模式。
 * 每个文件卡片:
 *   - name / size / mtime
 *   - 错误态红 Tag(若有 error 字段)
 *   - [预览] 按钮:无错误 + size ≤ 1 MiB 时启用
 *   - [打开目录] 按钮:总是 fire-and-forget POST /api/fs/reveal
 */
import React from "react"
import { Button, Card, Tag, Space, Tooltip, Typography } from "antd"
import { FileTextOutlined, EyeOutlined, FolderOpenOutlined, FileImageOutlined, CodeOutlined, FileUnknownOutlined } from "@ant-design/icons"
import type { ToolRenderer } from "./types.js"
import { useAgentStore } from "../../store/useAgentStore.js"

const ONE_MIB = 1024 * 1024

type FileMeta = {
  path: string
  name: string
  size: number
  mtime: number
  kind: 'text' | 'image' | 'html' | 'binary'
  error?: { code: string; message: string }
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function kindIcon(kind: FileMeta['kind']): React.ReactNode {
  switch (kind) {
    case 'text': return <FileTextOutlined />
    case 'image': return <FileImageOutlined />
    case 'html': return <CodeOutlined />
    default: return <FileUnknownOutlined />
  }
}

function errorLabel(code: string): string {
  switch (code) {
    case 'ENOENT': return '文件不存在'
    case 'EACCES':
    case 'EPERM': return '无权限'
    case 'EISDIR': return '是目录'
    case 'ETOOBIG': return '文件过大'
    default: return code
  }
}

/**
 * 适配 zai-native wire shape.
 *
 * displayFilesTool (Task 4) 把 Anthropic-style content block 序列化进
 * `output: JSON.stringify({ content: [{ type: 'json', json: { files } }] })`,
 * useAgentStore 把它原样存到 msg.output (字符串). 这跟 Anthropic 协议的
 * tool_result 数组形态不一样, 也跟 brief 里假设的"result.content[0]"形态不一样.
 * 因此这里:先 JSON.parse 字符串, 再走 content[0].json.files.
 */
function parseFiles(msg: any): FileMeta[] {
  const out = msg?.output
  if (typeof out !== 'string') return []
  try {
    const wrapper = JSON.parse(out)
    const block = Array.isArray(wrapper?.content) ? wrapper.content[0] : null
    const files = block?.json?.files
    return Array.isArray(files) ? files : []
  } catch {
    return []
  }
}

function FileCard({ file }: { file: FileMeta }) {
  const openPreview = useAgentStore((s) => s.openFilePreview)
  // zai patch (Task 10 集成验证补):binary kind 也不可预览,跟 spec §9.2
  // "binary [预览] disabled" 一致。原来只挡 error/size 上限,用户点 binary
  // 预览会看到 Drawer 的"不支持内联预览"Alert(没有 preview 价值)。把
  // kind === 'binary' 也纳入 disabled 集合,tooltip 也改成"二进制,无法预览"。
  const previewable =
    !file.error && file.size > 0 && file.size <= ONE_MIB && file.kind !== 'binary'

  const onReveal = () => {
    void fetch('/api/fs/reveal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: file.path }),
    })
  }

  const previewTooltip = file.error
    ? errorLabel(file.error.code)
    : file.kind === 'binary'
      ? '二进制文件,无法内联预览'
      : previewable
        ? '预览文件内容'
        : '文件过大,请在文件管理器中打开'

  return (
    <Card size="small" style={{ marginBottom: 8 }}>
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <Space>
          {kindIcon(file.kind)}
          <Typography.Text strong>{file.name}</Typography.Text>
          {file.error && <Tag color="error">{errorLabel(file.error.code)}</Tag>}
        </Space>
        <Space size="small" style={{ color: 'var(--text-dim-65)', fontSize: 12 }}>
          <span>{humanSize(file.size)}</span>
          {file.mtime > 0 && <span>{new Date(file.mtime).toLocaleString()}</span>}
          <Typography.Text type="secondary" ellipsis style={{ maxWidth: 400 }}>
            {file.path}
          </Typography.Text>
        </Space>
        <Space>
          <Tooltip title={previewTooltip}>
            <Button
              size="small"
              icon={<EyeOutlined />}
              disabled={!previewable}
              onClick={() => openPreview(file.path)}
            >
              预览
            </Button>
          </Tooltip>
          <Button size="small" icon={<FolderOpenOutlined />} onClick={onReveal}>
            打开目录
          </Button>
        </Space>
      </Space>
    </Card>
  )
}

export const fileDisplayRenderer: ToolRenderer = {
  skipOuterGroup: true,
  preview(input) {
    const paths = Array.isArray(input?.paths) ? input.paths : []
    return `展示 ${paths.length} 个文件`
  },
  renderFull(msg) {
    const files = parseFiles(msg)
    if (files.length === 0) return null
    return (
      <div data-testid="file-display-list">
        {files.map((f) => (
          <FileCard key={f.path} file={f} />
        ))}
      </div>
    )
  },
}