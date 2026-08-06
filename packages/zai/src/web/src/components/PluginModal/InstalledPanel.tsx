import { Alert, Empty, Skeleton, Typography } from 'antd'
import type { PluginDto, PluginListResult } from '../../../../shared/plugins.js'
import type { FetchStatus, WriteState } from './usePlugins'
import { PluginRow } from './PluginRow'

type Props = {
  data: PluginListResult
  status: FetchStatus
  writing: WriteState
  onToggle: (p: PluginDto, next: boolean) => void
  onUpdate: (p: PluginDto) => void
  onUninstall: (p: PluginDto) => void
  onReload: () => void
}

/** "已安装" Tab — 加载骨架 / 失败提示 / 空态 / 插件行 + 底部重载入口. */
export function InstalledPanel({ data, status, writing, onToggle, onUpdate, onUninstall, onReload }: Props) {
  if (status === 'loading' || status === 'idle') {
    return <Skeleton active style={{ padding: 16 }} />
  }
  if (status === 'error') {
    return <Alert type="error" message="加载失败" showIcon style={{ margin: 16 }} />
  }
  return (
    <div>
      {data.errors.length > 0 && (
        <Alert
          type="warning"
          message={`${data.errors.length} 个插件加载失败`}
          description={data.errors.join('；')}
          showIcon
          closable
          style={{ margin: 12 }}
        />
      )}
      {data.plugins.length === 0 ? (
        <Empty description="尚未安装任何插件" style={{ marginTop: 40 }} />
      ) : (
        data.plugins.map((p) => (
          <PluginRow
            key={p.id}
            plugin={p}
            writing={writing[p.id]}
            onToggle={(next) => onToggle(p, next)}
            onUpdate={() => onUpdate(p)}
            onUninstall={() => onUninstall(p)}
          />
        ))
      )}
      <div style={{ textAlign: 'right', padding: 8 }}>
        <Typography.Link data-testid="plugin-reload" onClick={onReload}>
          重载插件
        </Typography.Link>
      </div>
    </div>
  )
}
