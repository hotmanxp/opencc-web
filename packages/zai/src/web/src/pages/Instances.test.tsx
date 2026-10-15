// @vitest-environment happy-dom
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Instances, { effectiveState, STALE_THRESHOLD_MS } from './Instances.js'
import { useInstanceStore } from '../store/useInstanceStore.js'
import type { InstanceSnapshot } from '../../shared/instances.js'

function seed(snaps: InstanceSnapshot[]): void {
  useInstanceStore.setState({ instances: snaps, loading: false })
}

const current: InstanceSnapshot = {
  id: '__current__',
  name: 'current',
  cwd: '/tmp/current',
  createdAt: '',
  state: 'running',
  port: 9201,
  pid: 1,
  startedAt: '2026-08-03T00:00:00.000Z',
  lastHeartbeatAt: null,
  lastError: null,
  isCurrent: true,
}

const demo: InstanceSnapshot = {
  id: 'inst_1',
  name: 'demo',
  cwd: '/tmp/demo',
  createdAt: '2026-08-03T00:00:00.000Z',
  state: 'stopped',
  port: null,
  pid: null,
  startedAt: null,
  lastHeartbeatAt: null,
  lastError: null,
  isCurrent: false,
}

const lan: InstanceSnapshot = {
  ...demo,
  id: 'inst_lan',
  name: 'lan-demo',
  lan: true,
}

const running: InstanceSnapshot = {
  ...demo,
  state: 'running',
  port: 9202,
  pid: 12345,
  startedAt: new Date().toISOString(),
  lastHeartbeatAt: new Date().toISOString(),
}

const aaOn: InstanceSnapshot = {
  ...demo,
  id: 'inst_aa',
  name: 'aa-demo',
  aa: true,
}

const aaOff: InstanceSnapshot = {
  ...demo,
  id: 'inst_aa_off',
  name: 'aa-off-demo',
  aa: false,
}

describe('Instances page', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"instances":[]}', { status: 200 })))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    useInstanceStore.setState({ instances: [], loading: false })
  })

  it('renders the current instance row with a 当前 tag and disabled actions', () => {
    seed([current, demo])
    render(<MemoryRouter><Instances /></MemoryRouter>)
    expect(screen.getByText('current')).toBeInTheDocument()
    expect(screen.getByText('当前')).toBeInTheDocument()
    const buttons = screen.getAllByRole('button')
    // current row's actions must be disabled (we assert at least one disabled button
    // belongs to the current row by checking buttons near the '当前' tag).
    const currentRowButton = buttons.find((b) => b.textContent?.includes('启动'))
    expect(currentRowButton).toBeDisabled()
  })

  it('fires POST /api/instances when 新建 modal is submitted', async () => {
    seed([])
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/instances' && init?.method === 'POST') {
        const starting: InstanceSnapshot = { ...demo, state: 'starting' }
        return new Response(JSON.stringify({ instance: starting }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{"instances":[]}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<MemoryRouter><Instances /></MemoryRouter>)
    fireEvent.click(screen.getByText('新建实例'))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'demo' } })
    fireEvent.change(screen.getByTestId('cwd-input'), { target: { value: '/tmp/demo' } })
    fireEvent.click(screen.getByRole('button', { name: /创\s*建/ }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/instances',
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })

  it('opens the new instance tab only after it is running, not as a blank about:blank', async () => {
    seed([])
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/instances' && init?.method === 'POST') {
        const starting: InstanceSnapshot = { ...demo, state: 'starting' }
        return new Response(JSON.stringify({ instance: starting }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url === '/api/instances/inst_1' && (!init || init.method === undefined || init.method === 'GET')) {
        return new Response(JSON.stringify({ instance: running }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{"instances":[]}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)

    render(<MemoryRouter><Instances /></MemoryRouter>)
    fireEvent.click(screen.getByText('新建实例'))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'demo' } })
    fireEvent.change(screen.getByTestId('cwd-input'), { target: { value: '/tmp/demo' } })
    fireEvent.click(screen.getByRole('button', { name: /创\s*建/ }))

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        'http://localhost:9202',
        '_blank',
        expect.stringContaining('noopener'),
      )
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/instances/inst_1')
    // 关键断言: 不应在创建初期就预开 about:blank — 这就是用户报告的
    // "新建实例后默认打开 about:blank 空白页" bug 的根因。
    const preOpen = openSpy.mock.calls.find((c) => c[0] === 'about:blank')
    expect(preOpen).toBeUndefined()
  })

  it('opens sub-instances on the host the page was served from, not localhost', async () => {
    // 从局域网 IP 进来的人(手机 / 另一台电脑)点「打开」时,子实例地址
    // 必须用同一个 IP —— 写死 localhost 会落到「他自己机器」的 127.0.0.1。
    // happy-dom 的 location 是只读的,replaceState 换 origin 会抛
    // SecurityError,只能走 happyDOM.setURL。
    const w = window as unknown as { happyDOM?: { setURL(url: string): void } }
    const originalHref = window.location.href
    w.happyDOM?.setURL('http://192.168.1.20:9987/instances')
    try {
      seed([running])
      render(<MemoryRouter><Instances /></MemoryRouter>)
      await waitFor(() => {
        expect(screen.getByRole('link', { name: '打开' })).toHaveAttribute(
          'href',
          'http://192.168.1.20:9202',
        )
      })
    } finally {
      w.happyDOM?.setURL(originalHref)
    }
  })

  it('does not open a new tab and surfaces the error when the instance goes down', async () => {
    seed([])
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/instances' && init?.method === 'POST') {
        const starting: InstanceSnapshot = { ...demo, state: 'starting' }
        return new Response(JSON.stringify({ instance: starting }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url === '/api/instances/inst_1') {
        const down: InstanceSnapshot = {
          ...demo,
          state: 'down',
          lastError: { at: '2026-08-04T00:00:00.000Z', message: 'cwd failed' },
        }
        return new Response(JSON.stringify({ instance: down }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{"instances":[]}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)

    render(<MemoryRouter><Instances /></MemoryRouter>)
    fireEvent.click(screen.getByText('新建实例'))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'demo' } })
    fireEvent.change(screen.getByTestId('cwd-input'), { target: { value: '/tmp/demo' } })
    fireEvent.click(screen.getByRole('button', { name: /创\s*建/ }))

    await waitFor(() => {
      expect(screen.getByText('cwd failed')).toBeInTheDocument()
    })
    // 错误路径不应打开任何新标签页。
    expect(openSpy).not.toHaveBeenCalled()
  })
  it('renders a LAN switch on each non-current card with the persisted flag reflected', () => {
    seed([current, demo, lan])
    render(<MemoryRouter><Instances /></MemoryRouter>)
    // antd Switch renders a `button[role=switch]` with `aria-checked`.
    // demo has no lan → switch unchecked.
    const demoSwitch = screen.getByTestId('lan-switch-inst_1') as HTMLElement
    expect(demoSwitch.getAttribute('aria-checked')).toBe('false')
    // lan has lan=true → switch checked.
    const lanSwitch = screen.getByTestId('lan-switch-inst_lan') as HTMLElement
    expect(lanSwitch.getAttribute('aria-checked')).toBe('true')
    // current row never shows the switch.
    expect(screen.queryByTestId('lan-switch-__current__')).not.toBeInTheDocument()
  })

  it('PATCH /api/instances/:id with {lan:true} when the LAN switch is toggled on', async () => {
    seed([current, demo])
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/instances/inst_1' && init?.method === 'PATCH') {
        const body = JSON.parse(init.body as string) as { lan: boolean }
        return new Response(
          JSON.stringify({ instance: { ...demo, lan: body.lan } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('{"instances":[]}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<MemoryRouter><Instances /></MemoryRouter>)
    fireEvent.click(screen.getByTestId('lan-switch-inst_1'))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/instances/inst_1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ lan: true }),
        }),
      )
    })
  })

  it('rolls back the LAN switch when PATCH fails', async () => {
    seed([current, lan])
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/instances/inst_lan' && init?.method === 'PATCH') {
        return new Response(JSON.stringify({ error: 'nope' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{"instances":[]}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<MemoryRouter><Instances /></MemoryRouter>)
    const sw = screen.getByTestId('lan-switch-inst_lan') as HTMLElement
    expect(sw.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sw) // optimistic flip to false
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/instances/inst_lan',
        expect.objectContaining({ method: 'PATCH' }),
      )
    })
    // After rollback, the switch must reflect the original (true) state.
    await waitFor(() => {
      expect((screen.getByTestId('lan-switch-inst_lan') as HTMLElement).getAttribute('aria-checked')).toBe('true')
    })
  })

  it('submits lan=true in POST body when the new-instance modal checkbox is ticked', async () => {
    seed([])
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/instances' && init?.method === 'POST') {
        return new Response(JSON.stringify({ instance: { ...demo, lan: true } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{"instances":[]}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<MemoryRouter><Instances /></MemoryRouter>)
    fireEvent.click(screen.getByText('新建实例'))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'demo' } })
    fireEvent.change(screen.getByTestId('cwd-input'), { target: { value: '/tmp/demo' } })
    // Tick the LAN checkbox. Antd renders a real <input type="checkbox">
    // inside Form.Item; we click it to toggle, then assert the body.
    const checkbox = screen.getByTestId('lan-checkbox').querySelector('input[type="checkbox"]') as HTMLInputElement
    fireEvent.click(checkbox)
    fireEvent.click(screen.getByRole('button', { name: /创\s*建/ }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/instances',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'demo', cwd: '/tmp/demo', lan: true }),
        }),
      )
    })
  })

  // ── AA 开关:关态必须发显式 `aa:false` ──
  // 回归钉:关态曾发空 body `{}`,被 supervisor 的「空补丁守卫」400
  // (`no patchable fields supplied`)拒掉 —— 开关怎么都关不掉。
  // 省略字段也不行:那等于「不改」,def.aa 保持原值,下次 start 又带 --aa。
  it('PATCHes {aa:false} when the AA switch is turned off (never an empty body)', async () => {
    seed([current, aaOn])
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/instances/inst_aa' && init?.method === 'PATCH') {
        const body = JSON.parse(init.body as string) as { aa: boolean }
        return new Response(
          JSON.stringify({ instance: { ...aaOn, aa: body.aa } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('{"instances":[]}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<MemoryRouter><Instances /></MemoryRouter>)

    const sw = screen.getByTestId('aa-switch-inst_aa') as HTMLElement
    expect(sw.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sw)

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (c) => c[0] === '/api/instances/inst_aa' && (c[1] as RequestInit)?.method === 'PATCH',
      )
      expect(patch).toBeDefined()
      const body = (patch![1] as RequestInit).body as string
      expect(JSON.parse(body)).toEqual({ aa: false })
      // 关键:不能是空 body
      expect(body).not.toBe('{}')
    })
  })

  it('PATCHes {aa:true} when the AA switch is turned on', async () => {
    seed([current, demo])
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/instances/inst_1' && init?.method === 'PATCH') {
        return new Response(
          JSON.stringify({ instance: { ...demo, aa: true } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('{"instances":[]}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<MemoryRouter><Instances /></MemoryRouter>)

    fireEvent.click(screen.getByTestId('aa-switch-inst_1'))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/instances/inst_1',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ aa: true }) }),
      )
    })
  })

  it('rolls the AA switch back to on when the PATCH fails', async () => {
    seed([current, aaOn])
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/instances/inst_aa' && init?.method === 'PATCH') {
        return new Response(
          JSON.stringify({ error: 'no patchable fields supplied' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('{"instances":[]}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<MemoryRouter><Instances /></MemoryRouter>)

    fireEvent.click(screen.getByTestId('aa-switch-inst_aa'))

    await waitFor(() => {
      expect(
        (screen.getByTestId('aa-switch-inst_aa') as HTMLElement).getAttribute('aria-checked'),
      ).toBe('true')
    })
  })

  it('labels the three AA states distinctly', () => {
    // auto(缺省) / 强制禁用(false) / --aa(true) 三种 Tag 都要能区分,
    // 否则用户把开关关掉后会看到「auto」,以为回到了「跟随 root」,
    // 实际落盘是 force-off —— 语义完全相反,必须说清楚。
    seed([current, demo, aaOn, aaOff])
    render(<MemoryRouter><Instances /></MemoryRouter>)

    // demo 缺 aa → auto
    expect(screen.getByTestId('aa-tag-inst_1')).toHaveTextContent('auto')
    // aaOn → --aa
    expect(screen.getByTestId('aa-tag-inst_aa')).toHaveTextContent('--aa')
    // aaOff → 已禁用(不是 auto)
    expect(screen.getByTestId('aa-tag-inst_aa_off')).toHaveTextContent('已禁用')
    // 两个 Switch 都在关态(unchecked),但 Tag 不同 —— 区分靠的是 Tag
    expect((screen.getByTestId('aa-switch-inst_1') as HTMLElement).getAttribute('aria-checked')).toBe('false')
    expect((screen.getByTestId('aa-switch-inst_aa_off') as HTMLElement).getAttribute('aria-checked')).toBe('false')
  })
})

describe('effectiveState (3 分钟 stale 阈值)', () => {
  const base: InstanceSnapshot = {
    id: 'inst_x',
    name: 'x',
    cwd: '/tmp/x',
    createdAt: '',
    state: 'down',
    port: null,
    pid: null,
    startedAt: null,
    lastHeartbeatAt: null,
    lastError: null,
    isCurrent: false,
  }

  it('down 但 lastHeartbeatAt 刚发生 → 仍按 down 渲染', () => {
    const snap: InstanceSnapshot = { ...base, lastHeartbeatAt: new Date().toISOString() }
    expect(effectiveState(snap)).toBe('down')
  })

  it('down + lastHeartbeatAt 在阈值内 → 仍按 down', () => {
    const snap: InstanceSnapshot = {
      ...base,
      lastHeartbeatAt: new Date(Date.now() - (STALE_THRESHOLD_MS - 1000)).toISOString(),
    }
    expect(effectiveState(snap)).toBe('down')
  })

  it('down + lastHeartbeatAt 超过阈值 → 视作 stopped', () => {
    const snap: InstanceSnapshot = {
      ...base,
      lastHeartbeatAt: new Date(Date.now() - (STALE_THRESHOLD_MS + 1000)).toISOString(),
    }
    expect(effectiveState(snap)).toBe('stopped')
  })

  it('down 但 lastHeartbeatAt 为 null → 仍按 down(没数据不假阳)', () => {
    const snap: InstanceSnapshot = { ...base, lastHeartbeatAt: null }
    expect(effectiveState(snap)).toBe('down')
  })

  it('非 down 状态不受阈值影响', () => {
    const snap: InstanceSnapshot = {
      ...base,
      state: 'running',
      lastHeartbeatAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    }
    expect(effectiveState(snap)).toBe('running')
  })
})
