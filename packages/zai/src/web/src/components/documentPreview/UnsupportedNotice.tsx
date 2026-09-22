/**
 * UnsupportedNotice —— 文档预览里「给不出内容但必须说清楚原因」的落地态。
 *
 * 三种来源:
 *   - legacy-office kind(.doc/.ppt/.rtf/.odt/.odp)→ 旧版二进制 / ODF,浏览器端无渲染器
 *   - /fs/raw 415 EENCRYPTED_OR_LEGACY → 容器嗅探命中 OLE,加密文档或旧版二进制
 *   - /fs/raw 415 EUNSUPPORTED / 413 ETOOBIG → 兜底
 *
 * 文案必须可操作:说清楚「为什么不行」+「怎么办」,而不是笼统的"不支持"。
 * 「打开目录」复用 /api/fs/reveal,与 FilePreviewBody 的 binary 分支一致。
 */
import React from 'react'
import { Alert, Button, Typography } from 'antd'
import { FolderOpenIcon } from 'lucide-react'

export type UnsupportedReason = 'legacy-office' | 'encrypted' | 'unsupported' | 'too-large'

const EXT_HINT: Record<UnsupportedReason, string> = {
  'legacy-office':
    '这是旧版二进制 Office 格式(或 ODF),浏览器端没有可用的渲染器。请用 Office/WPS 转存为 OOXML(.docx/.xlsx/.pptx)后再预览,或直接用系统应用打开。',
  encrypted:
    '这可能是受密码保护的文档(或披着新扩展名的旧版二进制文件),zai 不会解密文档。请先用 Office/WPS 去掉密码再预览。',
  unsupported: '该扩展名不在文档预览白名单内。',
  'too-large': '文件超过了该格式的预览上限。',
}

export function UnsupportedNotice({
  path,
  reason,
  detail,
}: {
  path: string
  reason: UnsupportedReason
  /** 附加说明(超过上限时的具体数字、服务端 message 等)。 */
  detail?: string
}) {
  const name = path.split(/[\\/]/).pop() ?? path
  const extIdx = name.lastIndexOf('.')
  const ext = extIdx > 0 ? name.slice(extIdx).toLowerCase() : ''
  return (
    <Alert
      data-testid="document-unsupported"
      type="warning"
      message="无法在浏览器内预览此文档"
      description={
        <div className="flex flex-col gap-2">
          <Typography.Paragraph className="!mb-0 text-xs">
            {EXT_HINT[reason]}
          </Typography.Paragraph>
          {detail && (
            <Typography.Paragraph data-testid="document-unsupported-detail" className="!mb-0 text-xs text-[#8c8c8c]">
              {detail}
            </Typography.Paragraph>
          )}
          {/* 固定浅灰(不取 var(--text-secondary)):本落地面板恒为白底黑字,
              暗色主题下那个变量解析成浅灰色,落在白底上几乎看不见。 */}
          <div className="text-xs text-[#8c8c8c] break-all">
            {ext ? `${ext} · ` : ''}
            {path}
          </div>
          <div>
            <Button
              icon={<FolderOpenIcon />}
              onClick={() => void fetch('/api/fs/reveal', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ path }),
              })}
            >
              打开目录
            </Button>
          </div>
        </div>
      }
    />
  )
}