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
    return <Skeleton active className="p-4" />
  }
  if (status === 'error') {
    return <Alert type="error" message="加载失败" showIcon className="m-4" />
  }
  if (plugins.length === 0) {
    return <Empty description="市场里没有可安装的插件" className="mt-10" />
  }
  return (
    <div>
      {plugins.map((p) => (
        <div
          key={p.id}
          data-testid="marketplace-row"
          className="flex gap-3 py-2.5 px-3 items-start"
          style={{ borderBottom: '1px solid var(--border-subtle)' }}
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Typography.Text strong>{p.name}</Typography.Text>
              {p.version && (
                <Typography.Text type="secondary" className="text-xs">
                  v{p.version}
                </Typography.Text>
              )}
              <Tag style={{ margin: 0 }}>{p.marketplace}</Tag>
              {p.category && <Tag style={{ margin: 0 }}>{p.category}</Tag>}
            </div>
            {p.description && (
              <Typography.Text type="secondary" className="text-xs block mt-0.5">
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
