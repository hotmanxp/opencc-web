import { Dropdown, Switch, Tag, Tooltip, Typography } from 'antd'
import { DownOutlined } from '@ant-design/icons'
import type { PluginDto } from '../../../../shared/plugins.js'

type Props = {
  plugin: PluginDto
  writing?: 'writing' | undefined
  onToggle: (next: boolean) => void
  onUpdate: () => void
  onUninstall: () => void
}

const STATUS_COLOR: Record<string, string> = {
  enabled: 'var(--success)',
  disabled: 'var(--text-tertiary)',
  error: 'var(--error)',
  update: '#eab308',
}

const SCOPE_LABEL: Record<string, string> = {
  user: 'user',
  project: 'project',
  local: 'local',
  builtin: '内置',
}

/**
 * 已安装插件列表里的一行 — 左侧状态圆点(错误 > 待更新 > 启用 > 停用),
 * 中间名称/版本/来源/作用域,右侧启停开关 + 更新/卸载菜单.
 *
 * 非 writable(project / local 作用域)时开关禁用并给 Tooltip 说明,
 * 且不显示写操作菜单 — 与后端 `writable` 语义保持一致.
 */
export function PluginRow({ plugin, writing, onToggle, onUpdate, onUninstall }: Props) {
  const dot =
    plugin.errors.length > 0
      ? STATUS_COLOR.error
      : plugin.hasUpdate
        ? STATUS_COLOR.update
        : plugin.enabled
          ? STATUS_COLOR.enabled
          : STATUS_COLOR.disabled

  const switchEl = (
    <Switch
      checked={plugin.enabled}
      disabled={!plugin.writable || writing === 'writing'}
      loading={writing === 'writing'}
      aria-label={`启用 ${plugin.name ?? plugin.id}`}
      onChange={onToggle}
    />
  )

  return (
    <div
      data-testid="plugin-row"
      className="flex gap-3 py-2.5 px-3 items-start"
      style={{ borderBottom: '1px solid var(--border-subtle)' }}
    >
      <span
        className="rounded-full shrink-0 mt-1.5"
        style={{ width: 8, height: 8, background: dot }}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Typography.Text strong>{plugin.name}</Typography.Text>
          {plugin.version && (
            <Typography.Text type="secondary" className="text-xs">
              v{plugin.version}
            </Typography.Text>
          )}
          <Tag style={{ margin: 0 }}>{plugin.marketplace}</Tag>
          <Tag color={plugin.scope === 'builtin' ? 'blue' : 'default'} style={{ margin: 0 }}>
            {SCOPE_LABEL[plugin.scope] ?? plugin.scope}
          </Tag>
          {plugin.hasUpdate && (
            <Tag color="warning" style={{ margin: 0 }}>
              待更新
            </Tag>
          )}
        </div>
        {plugin.description && (
          <Typography.Text type="secondary" className="text-xs block mt-0.5">
            {plugin.description}
          </Typography.Text>
        )}
        {plugin.errors.length > 0 && (
          <Typography.Text type="danger" className="text-xs block mt-0.5">
            {plugin.errors.join('；')}
          </Typography.Text>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {plugin.writable ? (
          switchEl
        ) : (
          <Tooltip title="由项目配置管理，请用 CLI 修改" aria-label="由项目配置管理">
            <span>{switchEl}</span>
          </Tooltip>
        )}
        {plugin.writable && (
          <Dropdown
            menu={{
              items: [
                { key: 'update', label: '更新', disabled: !plugin.hasUpdate, onClick: onUpdate },
                { key: 'uninstall', label: '卸载', danger: true, onClick: onUninstall },
              ],
            }}
          >
            <DownOutlined style={{ cursor: 'pointer', color: 'var(--text-secondary)' }} />
          </Dropdown>
        )}
      </div>
    </div>
  )
}
