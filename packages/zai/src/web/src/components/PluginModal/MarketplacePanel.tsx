import { Alert, Button, Empty, Skeleton, Tag, Typography } from 'antd'
import type { MarketplacePluginDto } from '../../../../shared/plugins.js'
import type { FetchStatus, WriteState } from './usePlugins'

type Props = {
  plugins: MarketplacePluginDto[]
  status: FetchStatus
  writing: WriteState
  onInstall: (p: MarketplacePluginDto) => void
}

/**
 * "市场" Tab — 后端 `listAvailable` 已过滤掉已安装项,所以这里的每一条
 * 都可以直接安装,不需要再判断 `installed`.
 */
export function MarketplacePanel({ plugins, status, writing, onInstall }: Props) {
  if (status === 'loading' || status === 'idle') {
    return <Skeleton active style={{ padding: 16 }} />
  }
  if (status === 'error') {
    return <Alert type="error" message="加载失败" showIcon style={{ margin: 16 }} />
  }
  if (plugins.length === 0) {
    return <Empty description="市场里没有可安装的插件" style={{ marginTop: 40 }} />
  }
  return (
    <div>
      {plugins.map((p) => (
        <div
          key={p.id}
          data-testid="marketplace-row"
          style={{
            display: 'flex',
            gap: 12,
            padding: '10px 12px',
            borderBottom: '1px solid var(--border-subtle)',
            alignItems: 'flex-start',
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Typography.Text strong>{p.name}</Typography.Text>
              {p.version && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  v{p.version}
                </Typography.Text>
              )}
              <Tag style={{ margin: 0 }}>{p.marketplace}</Tag>
              {p.category && <Tag style={{ margin: 0 }}>{p.category}</Tag>}
            </div>
            {p.description && (
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>
                {p.description}
              </Typography.Text>
            )}
          </div>
          <Button
            type="primary"
            size="small"
            loading={writing[p.id] === 'writing'}
            onClick={() => onInstall(p)}
          >
            安装
          </Button>
        </div>
      ))}
    </div>
  )
}
