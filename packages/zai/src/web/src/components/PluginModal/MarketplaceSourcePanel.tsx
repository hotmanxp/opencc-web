import { Alert, Button, Empty, Input, Skeleton, Space, Tag, Typography } from 'antd'
import { useState } from 'react'
import type { MarketplaceDto } from '../../../../shared/plugins.js'
import type { FetchStatus } from './usePlugins'

type Props = {
  marketplaces: MarketplaceDto[]
  status: FetchStatus
  adding: boolean
  onAdd: (source: string) => void
}

/** `2026-08-07T...` → `2026-08-07`,拿不到就不显示. */
function formatDate(iso?: string): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString()
}

/**
 * "市场来源" Tab — 列出已配置的插件市场,并提供添加入口.
 *
 * 添加是唯一的写操作:删除/更新市场目前仍走 CLI(`claude marketplace remove|update`),
 * 因为删除会连带卸载该市场下已安装的插件,需要更重的确认流程.
 */
export function MarketplaceSourcePanel({ marketplaces, status, adding, onAdd }: Props) {
  const [source, setSource] = useState('')

  if (status === 'loading' || status === 'idle') {
    return <Skeleton active className="p-4" />
  }
  if (status === 'error') {
    return <Alert type="error" message="加载失败" showIcon className="m-4" />
  }

  const submit = () => {
    const trimmed = source.trim()
    if (!trimmed || adding) return
    onAdd(trimmed)
    setSource('')
  }

  return (
    <div>
      <div className="pt-1 px-3 pb-3">
        <Space.Compact className="w-full">
          <Input
            data-testid="marketplace-source-input"
            placeholder="owner/repo、https://... 或本地路径 ./path"
            value={source}
            disabled={adding}
            onChange={(e) => setSource(e.target.value)}
            onPressEnter={submit}
          />
          <Button
            type="primary"
            data-testid="marketplace-add"
            loading={adding}
            disabled={!source.trim()}
            onClick={submit}
          >
            添加市场
          </Button>
        </Space.Compact>
        <Typography.Text type="secondary" className="text-xs block mt-1.5">
          支持 GitHub 简写(owner/repo)、git/https 地址、本地目录或 marketplace.json 路径。
        </Typography.Text>
      </div>

      {marketplaces.length === 0 ? (
        <Empty description="尚未配置任何插件市场" className="my-6" />
      ) : (
        marketplaces.map((m) => {
          const updated = formatDate(m.lastUpdated)
          return (
            <div
              key={m.name}
              data-testid="marketplace-source-row"
              className="py-2.5 px-3"
              style={{ borderBottom: '1px solid var(--border-subtle)' }}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <Typography.Text strong>{m.name}</Typography.Text>
                <Tag style={{ margin: 0 }}>{m.sourceType}</Tag>
              </div>
              <Typography.Text
                type="secondary"
                className="text-xs block mt-0.5 break-all"
              >
                {m.source}
              </Typography.Text>
              <Typography.Text type="secondary" className="text-xs block mt-0.5">
                {/* pluginCount 为 undefined 表示该市场缓存读不出来,不能当成 0 个插件 */}
                {m.pluginCount === undefined ? '插件清单读取失败' : `${m.pluginCount} 个插件`}
                {` · 已安装 ${m.installedCount}`}
                {updated ? ` · 更新于 ${updated}` : ''}
              </Typography.Text>
            </div>
          )
        })
      )}
    </div>
  )
}
