import { describe, expect, it } from 'vitest'
import { ReplSession, ReplBusyError } from '../ReplSession.js'

describe('ReplSession — 初始化与状态', () => {
  it('新建实例 busy=false', () => {
    const s = new ReplSession('/tmp')
    expect(s.busy).toBe(false)
  })

  it('cwd 默认值', () => {
    const s = new ReplSession('/tmp')
    expect(s.cwd).toBe('/tmp')
  })

  it('有 child 在跑时 exec 抛 ReplBusyError', async () => {
    const s = new ReplSession(process.cwd())
    await s.exec('node -e "setTimeout(()=>{}, 60000)"')
    expect(s.busy).toBe(true)
    await expect(s.exec('echo second')).rejects.toBeInstanceOf(ReplBusyError)
    s.abort()
  })
})