import { Modal, Tabs, message } from 'antd'
import { useCallback, useState } from 'react'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/useAppStore'
import type { PluginActionResult } from '../../../../shared/plugins.js'
import { usePlugins } from './usePlugins'
import { InstalledPanel } from './InstalledPanel'
import { MarketplacePanel } from './MarketplacePanel'
import { MarketplaceSourcePanel } from './MarketplaceSourcePanel'

/**
 * 插件管理弹框 — 三个 Tab:已安装 / 市场 / 市场来源.
 *
 * 数据层在 `usePlugins`,只在弹框打开时拉;写操作后端会回带最新列表,
 * 因此这里不需要额外 refetch. 反馈统一走 antd 静态 `message`(与
 * AgentInputBox / MessageBubble 一致 — 应用没有挂 antd `<App>` provider,
 * `App.useApp()` 在这里拿不到实例).
 */
export function PluginModal() {
  const open = useAppStore((s) => s.pluginModalOpen)
  const close = useAppStore((s) => s.closePluginModal)
  const [tab, setTab] = useState<'installed' | 'marketplace' | 'sources'>('installed')
  const {
    installed,
    available,
    marketplaces,
    status,
    writing,
    addingMarketplace,
    write,
    addMarketplace,
    setInstalled,
  } = usePlugins(open)

  const showResult = useCallback(
    (r: PluginActionResult) => {
      if (r.reloadFailed) {
        message.warning(`${r.message}（热重载失败，重启会话后生效）`)
      } else if (r.success) {
        message.success(r.message)
      } else {
        message.error(r.message)
      }
    },
    [message],
  )

  const handleToggle = useCallback(
    async (p: { id: string }, next: boolean) => {
      showResult(await write(p.id, next ? 'enable' : 'disable'))
    },
    [write, showResult],
  )

  const handleUpdate = useCallback(
    async (p: { id: string }) => {
      showResult(await write(p.id, 'update'))
    },
    [write, showResult],
  )

  const handleUninstall = useCallback(
    async (p: { id: string }) => {
      showResult(await write(p.id, 'uninstall'))
    },
    [write, showResult],
  )

  const handleInstall = useCallback(
    async (p: { id: string }) => {
      const r = await write(p.id, 'install')
      showResult(r)
      if (r.success) setTab('installed')
    },
    [write, showResult],
  )

  const handleReload = useCallback(async () => {
    try {
      const r = await api.post<PluginActionResult>('/plugins/reload')
      if (r.state) setInstalled(r.state)
      showResult(r)
    } catch (e) {
      message.error(`重载失败: ${String(e)}`)
    }
  }, [setInstalled, showResult])

  // 添加成功后跳到「市场」Tab —— 新市场的插件就在那儿等着安装.
  const handleAddMarketplace = useCallback(
    async (source: string) => {
      try {
        const r = await addMarketplace(source)
        if (r.success) {
          message.success(r.message)
          setTab('marketplace')
        } else {
          message.error(r.message)
        }
      } catch (e) {
        message.error(`添加市场失败: ${String(e)}`)
      }
    },
    [addMarketplace],
  )

  return (
    <Modal
      open={open}
      onCancel={close}
      footer={null}
      title="插件管理"
      width={720}
      destroyOnHidden
    >
      <Tabs
        activeKey={tab}
        onChange={(k) => setTab(k as 'installed' | 'marketplace' | 'sources')}
        items={[
          {
            key: 'installed',
            label: `已安装 (${installed.plugins.length})`,
            children: (
              <InstalledPanel
                data={installed}
                status={status}
                writing={writing}
                onToggle={handleToggle}
                onUpdate={handleUpdate}
                onUninstall={handleUninstall}
                onReload={handleReload}
              />
            ),
          },
          {
            key: 'marketplace',
            label: `市场 (${available.length})`,
            children: (
              <MarketplacePanel
                plugins={available}
                status={status}
                writing={writing}
                onInstall={handleInstall}
              />
            ),
          },
          {
            key: 'sources',
            label: `市场来源 (${marketplaces.length})`,
            children: (
              <MarketplaceSourcePanel
                marketplaces={marketplaces}
                status={status}
                adding={addingMarketplace}
                onAdd={handleAddMarketplace}
              />
            ),
          },
        ]}
      />
    </Modal>
  )
}

export default PluginModal
