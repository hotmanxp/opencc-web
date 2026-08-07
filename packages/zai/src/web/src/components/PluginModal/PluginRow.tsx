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
      onChange={onToggle}
    />
  )

  return (
    <div
      data-testid="plugin-row"
      style={{
        display: 'flex',
        gap: 12,
        padding: '10px 12px',
        borderBottom: '1px solid var(--border-subtle)',
        alignItems: 'flex-start',
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 4, background: dot, marginTop: 6, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Typography.Text strong>{plugin.name}</Typography.Text>
          {plugin.version && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
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
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>
            {plugin.description}
          </Typography.Text>
        )}
        {plugin.errors.length > 0 && (
          <Typography.Text type="danger" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>
            {plugin.errors.join('；')}
          </Typography.Text>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {plugin.writable ? (
          switchEl
        ) : (
          <Tooltip title="由项目配置管理，请用 CLI 修改">
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
