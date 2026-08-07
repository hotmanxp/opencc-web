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
    return <Skeleton active style={{ padding: 16 }} />
  }
  if (status === 'error') {
    return <Alert type="error" message="加载失败" showIcon style={{ margin: 16 }} />
  }

  const submit = () => {
    const trimmed = source.trim()
    if (!trimmed || adding) return
    onAdd(trimmed)
    setSource('')
  }

  return (
    <div>
      <div style={{ padding: '4px 12px 12px' }}>
        <Space.Compact style={{ width: '100%' }}>
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
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
          支持 GitHub 简写(owner/repo)、git/https 地址、本地目录或 marketplace.json 路径。
        </Typography.Text>
      </div>

      {marketplaces.length === 0 ? (
        <Empty description="尚未配置任何插件市场" style={{ marginTop: 24, marginBottom: 24 }} />
      ) : (
        marketplaces.map((m) => {
          const updated = formatDate(m.lastUpdated)
          return (
            <div
              key={m.name}
              data-testid="marketplace-source-row"
              style={{
                padding: '10px 12px',
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Typography.Text strong>{m.name}</Typography.Text>
                <Tag style={{ margin: 0 }}>{m.sourceType}</Tag>
              </div>
              <Typography.Text
                type="secondary"
                style={{ fontSize: 12, display: 'block', marginTop: 2, wordBreak: 'break-all' }}
              >
                {m.source}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>
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
