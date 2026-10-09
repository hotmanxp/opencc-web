import { useCallback, useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type {
  PluginActionResult,
  MarketplaceActionResult,
  MarketplaceDto,
  MarketplacePluginDto,
  PluginListResult,
} from '../../../../shared/plugins.js'

export type FetchStatus = 'idle' | 'loading' | 'ready' | 'error'

export type WriteState = Record<string, 'writing' | undefined>

export type PluginWriteOp = 'enable' | 'disable' | 'install' | 'uninstall' | 'update'

/**
 * 插件弹框的数据层 — 只在 `enabled`(弹框打开)时拉取,关闭时不发请求.
 *
 * 写操作(enable/disable/install/uninstall/update)后端会连同最新的 `state`
 * 一起返回, 因此这里直接用 `r.state` 覆盖本地列表, 省掉一次 refetch;
 * 后端没带 state 时保持原样, 由调用方决定是否 `refresh()`.
 */
export function usePlugins(enabled: boolean) {
  const [installed, setInstalled] = useState<PluginListResult>({ plugins: [], errors: [] })
  const [available, setAvailable] = useState<MarketplacePluginDto[]>([])
  const [marketplaces, setMarketplaces] = useState<MarketplaceDto[]>([])
  const [status, setStatus] = useState<FetchStatus>('idle')
  const [writing, setWriting] = useState<WriteState>({})
  const [addingMarketplace, setAddingMarketplace] = useState(false)
  const [updatingMarketplace, setUpdatingMarketplace] = useState<string | undefined>()

  const refresh = useCallback(async () => {
    if (!enabled) return
    setStatus('loading')
    try {
      const [inst, av, mk] = await Promise.all([
        api.get<PluginListResult>('/plugins/'),
        api.get<{ plugins: MarketplacePluginDto[] }>('/plugins/available'),
        api.get<{ marketplaces: MarketplaceDto[] }>('/plugins/marketplaces'),
      ])
      setInstalled(inst)
      setAvailable(av.plugins)
      setMarketplaces(mk.marketplaces)
      setStatus('ready')
    } catch {
      setStatus('error')
    }
  }, [enabled])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const write = useCallback(async (id: string, op: PluginWriteOp): Promise<PluginActionResult> => {
    setWriting((w) => ({ ...w, [id]: 'writing' }))
    try {
      const r = await api.post<PluginActionResult>(`/plugins/${op}`, { id })
      if (r.state) setInstalled(r.state)
      return r
    } finally {
      setWriting((w) => {
        const rest = { ...w }
        delete rest[id]
        return rest
      })
    }
  }, [])

  /**
   * 添加市场 — 克隆/拉取可能较慢, 用独立的 `addingMarketplace` 而不是
   * 按 id 索引的 `writing`(此时还没有 id). 成功时后端会回带最新的
   * `marketplaces` + `available`, 同 `write` 一样省掉一次 refetch.
   */
  const addMarketplace = useCallback(async (source: string): Promise<MarketplaceActionResult> => {
    setAddingMarketplace(true)
    try {
      const r = await api.post<MarketplaceActionResult>('/plugins/marketplaces/add', { source })
      if (r.marketplaces) setMarketplaces(r.marketplaces)
      if (r.available) setAvailable(r.available)
      return r
    } finally {
      setAddingMarketplace(false)
    }
  }, [])

  /**
   * 刷新单个市场来源的上游清单 — 同 `addMarketplace`,网络操作可能较慢,
   * 用 `updatingMarketplace` 存市场名(而非按 id 索引的 `writing`,那个是
   * 插件维度的),这样行内 loading 与「其余行禁用」都能精确到单个来源.
   */
  const updateMarketplace = useCallback(async (name: string): Promise<MarketplaceActionResult> => {
    setUpdatingMarketplace(name)
    try {
      const r = await api.post<MarketplaceActionResult>('/plugins/marketplaces/update', { name })
      if (r.marketplaces) setMarketplaces(r.marketplaces)
      if (r.available) setAvailable(r.available)
      return r
    } finally {
      setUpdatingMarketplace(undefined)
    }
  }, [])

  return {
    installed,
    available,
    marketplaces,
    status,
    writing,
    addingMarketplace,
    updatingMarketplace,
    refresh,
    write,
    addMarketplace,
    updateMarketplace,
    setInstalled,
  }
}
