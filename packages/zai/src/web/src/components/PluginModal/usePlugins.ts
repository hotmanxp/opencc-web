import { useCallback, useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type {
  PluginActionResult,
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
  const [status, setStatus] = useState<FetchStatus>('idle')
  const [writing, setWriting] = useState<WriteState>({})

  const refresh = useCallback(async () => {
    if (!enabled) return
    setStatus('loading')
    try {
      const [inst, av] = await Promise.all([
        api.get<PluginListResult>('/plugins/'),
        api.get<{ plugins: MarketplacePluginDto[] }>('/plugins/available'),
      ])
      setInstalled(inst)
      setAvailable(av.plugins)
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

  return { installed, available, status, writing, refresh, write, setInstalled }
}
