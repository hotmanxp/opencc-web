import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { parseNdjson } from './ndjsonStream.js'
import { ControlRequestRegistry } from './controlRequest.js'

describe('parseNdjson', () => {
  it('逐行解析合法 JSON 对象', async () => {
    const stream = Readable.from([
      '{"type":"system","subtype":"init"}\n',
      '{"type":"stream_event","event":{}}\n',
    ])
    const rows: unknown[] = []
    for await (const row of parseNdjson(stream)) rows.push(row)
    expect(rows).toHaveLength(2)
    expect((rows[0] as { type: string }).type).toBe('system')
    expect((rows[1] as { type: string }).type).toBe('stream_event')
  })

  it('忽略空行与非法 JSON 行(不抛错)', async () => {
    const stream = Readable.from([
      '\n',
      '   \n',
      '{this is not json}\n',
      '{"type":"result","subtype":"success"}\n',
    ])
    const rows: unknown[] = []
    for await (const row of parseNdjson(stream)) rows.push(row)
    expect(rows).toHaveLength(1)
    expect((rows[0] as { subtype: string }).subtype).toBe('success')
  })

  it('partial line / EOF 后正常结束', async () => {
    const stream = Readable.from(['{"type":"assistant"'])
    const rows: unknown[] = []
    for await (const row of parseNdjson(stream)) rows.push(row)
    expect(rows).toHaveLength(0) // 未闭合 JSON 被忽略,迭代正常结束
  })
})

describe('ControlRequestRegistry', () => {
  it('register 后 pending 计数为 1,respond resolve 对应 promise', async () => {
    const reg = new ControlRequestRegistry()
    const p = reg.register('r-1', 'can_use_tool', { tool_name: 'Bash' })
    expect(reg.pending).toBe(1)
    const record = reg.get('r-1')
    expect(record?.subtype).toBe('can_use_tool')
    const response = { behavior: 'allow' as const }
    reg.respond('r-1', response)
    await expect(p).resolves.toBe(response)
    expect(reg.pending).toBe(0)
  })

  it('respond 未知 request_id 不抛错', () => {
    const reg = new ControlRequestRegistry()
    expect(() => reg.respond('nope', {})).not.toThrow()
  })

  it('rejectAll 让所有 pending 拒绝(会话退出清场)', async () => {
    const reg = new ControlRequestRegistry()
    const p1 = reg.register('r-1', 'can_use_tool', {})
    const p2 = reg.register('r-2', 'set_permission_mode', {})
    reg.rejectAll('host killed')
    expect(reg.pending).toBe(0)
    await expect(p1).rejects.toThrow('host killed')
    await expect(p2).rejects.toThrow('host killed')
  })
})