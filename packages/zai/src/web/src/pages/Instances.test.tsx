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
