/**
 * displayFilesOpencc — vendor-shape 内置工具,把一组本地路径以卡片列表
 * 渲染进当前对话(走 zai 前端 fileDisplayRenderer,见
 * packages/zai/src/web/src/components/toolRenderers/fileDisplay.tsx)。
 *
 * 背景:`compat/tools/displayFiles.ts` 定义了 zai-native 形状的
 * displayFilesTool(name + zod inputSchema + {output:string} executor),
 * 但 zai 当前 runtime 已切到 vendor `getAllBaseTools()` + mainAgent.tools
 * 槽机制 —— compat 形状不能直接进入 vendor 工具池(vendor 工具池走
 * utils/api.ts::toolToAPISchema → zodToJsonSchema(tool.inputSchema),
 * 而 compat 用的是 zod v3 跟 vendor zod v4 的 toJSONSchema 不兼容,
 * 强行挂入会触发 "Cannot read properties of undefined (reading 'def')")。
 *
 * 本模块复刻 compat/tools/displayFiles.ts 的核心行为(stat + classifyKind
 * + 错误归一化),用 vendor `buildTool` + zod v4 重新实现,挂入
 * opencc-src/server/mainAgents.ts 的 default agent.tools 槽。
 *
 * 实现位置:opencc-src/ 而不是 compat/tools/,因为:
 * 1) 复用 vendor 的 buildTool + ToolDef 接口(免 wrapAsOpenccTool 桥接)
 * 2) zod v4 schema 直接被 vendor 的 zodToJsonSchema 序列化进 API 请求
 * 3) 与 vendor 的 BashTool/FileReadTool 等并列 —— 真正成为"内置工具"
 *
 * zai patch (display_files / Task 5 + Task 10 集成修复): 之前
 * `displayFilesTool` 只挂在 dead-code `buildDefaultTools()` 上,实际
 * 没人调,模型永远看不到 DisplayFiles 描述。Task 10 /ego-browser 验收
 * 时所有模型(MiniMax-M3 / deepseek-v4-pro / zhiniao-glm-5.1)全部不
 * 调用 —— 把工具挂到 default 主 Agent 的 tools 槽后,DisplayFiles 才
 * 真正进入 `<tools>` 块,模型才会主动调它。
 */
import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { z } from 'zod/v4'
import { buildTool } from '../Tool.js'

// 扩展名分类规则与 compat/tools/displayFiles.ts:18-42 / zai/src/shared/
// fileKind.ts 保持同步(注释里点名的 png/jpg/html/ts/md 在各自单测
// 覆盖,作为规则同步护栏)。
const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonc', '.json5',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.scss', '.less', '.xml',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cc', '.cpp', '.h', '.hpp',
  '.sql', '.graphql', '.gql',
  '.env', '.gitignore', '.gitattributes', '.lock',
])
const HTML_EXTS = new Set(['.html', '.htm'])
const IMAGE_EXTS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
}

type FilePreviewKind = 'text' | 'image' | 'html' | 'binary'

function classifyKind(absPath: string): FilePreviewKind {
  const ext = extname(absPath).toLowerCase()
  if (ext in IMAGE_EXTS) return 'image'
  if (HTML_EXTS.has(ext)) return 'html'
  if (TEXT_EXTS.has(ext)) return 'text'
  return 'binary'
}

type FileErrorCode = 'ENOENT' | 'EACCES' | 'EISDIR' | 'EPERM' | 'EBUSY' | 'ELOOP'

interface FileMeta {
  path: string
  name: string
  size: number
  mtime: number
  kind: FilePreviewKind
  error?: { code: FileErrorCode; message: string }
}

function normalizeErrno(code: string | undefined): FileErrorCode {
  switch (code) {
    case 'ENOENT':
    case 'EACCES':
    case 'EISDIR':
    case 'EPERM':
    case 'EBUSY':
    case 'ELOOP':
      return code
    default:
      return 'EPERM'
  }
}

async function statOneFile(absPath: string): Promise<FileMeta> {
  const name = basename(absPath)
  try {
    const s = await stat(absPath)
    if (s.isDirectory()) {
      return {
        path: absPath,
        name,
        size: 0,
        mtime: s.mtimeMs,
        kind: 'binary',
        error: { code: 'EISDIR', message: '路径是目录,不是文件' },
      }
    }
    return {
      path: absPath,
      name,
      size: s.size,
      mtime: s.mtimeMs,
      kind: classifyKind(absPath),
    }
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    return {
      path: absPath,
      name,
      size: 0,
      mtime: 0,
      kind: 'binary',
      error: {
        code: normalizeErrno(err.code),
        message: err.message || String(e),
      },
    }
  }
}

const TOOL_DESCRIPTION =
  '把一组本地文件路径在当前会话中展示给用户:每个文件带 [预览] 与 [打开目录] 按钮。' +
  '适合在完成文件编辑/生成/汇报任务后,把产物路径列给用户。' +
  '文件大于 1 MiB 时仅展示元数据,不会内联预览。单次最多 20 个文件。'

const inputSchema = z.object({
  paths: z
    .array(z.string().min(1))
    .min(1, 'paths 不能为空')
    .max(20, '单次最多 20 个文件')
    .describe('一组待展示的本地文件绝对路径。'),
})

/**
 * vendor-shape Tool,直接挂入 mainAgent.tools 槽。
 *
 * 返回 `{ data: <shape> }` 是 vendor Tool.call 的标准契约 ——
 * utils/api.ts::toolToAPISchema 序列化时从 `result.data.output` 读
 * tool_result 内容(参看 compat/runtime/openccToolWrap.ts:280)。
 *
 * 这里直接产出 `{ data: { output: <json-stringified wrapper> } }`,
 * 跟 compat 版同一 wire shape(zai 前端 fileDisplayRenderer::parseFiles
 * 解析 output 字符串里的 content[0].json.files)。
 */
export const displayFilesOpenccTool = buildTool({
  name: 'DisplayFiles',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  async description() {
    return TOOL_DESCRIPTION
  },
  async prompt() {
    return TOOL_DESCRIPTION
  },
  get inputSchema() {
    return inputSchema
  },
  maxResultSizeChars: 50_000,
  async call({ paths }) {
    const files = await Promise.all(paths.map(statOneFile))
    // 与 compat 版完全同形 —— zai 前端 fileDisplayRenderer::parseFiles
    // 解析 output 字符串里的 wrapper.content[0].json.files 拿到 FileMeta[]。
    const output = JSON.stringify({
      content: [{ type: 'json' as const, json: { files } }],
    })
    return { data: { output } }
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage() {
    return null
  },
  mapToolResultToToolResultBlockParam(
    content: { output?: string },
    toolUseID: string,
  ) {
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: content?.output ?? '',
    }
  },
  toAutoClassifierInput() {
    return ''
  },
  checkPermissions(input) {
    return Promise.resolve({
      behavior: 'allow' as const,
      updatedInput: input,
      decisionReason: {
        type: 'mode' as const,
        mode: 'bypassPermissions' as const,
      },
    })
  },
  userFacingName: () => 'DisplayFiles',
})