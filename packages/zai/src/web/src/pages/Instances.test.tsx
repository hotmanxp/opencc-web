// @vitest-environment happy-dom
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Instances from './Instances.js'
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

const running: InstanceSnapshot = {
  ...demo,
  state: 'running',
  port: 9202,
  pid: 42,
  startedAt: '2026-08-04T00:00:00.000Z',
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
        return new Response('{"instance":{...}}', { status: 201 })
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

  it('navigates the popup to the running instance port after create', async () => {
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
    const popup = {
      closed: false,
      location: { href: 'about:blank' },
      close: vi.fn(),
    }
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)

    render(<MemoryRouter><Instances /></MemoryRouter>)
    fireEvent.click(screen.getByText('新建实例'))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'demo' } })
    fireEvent.change(screen.getByTestId('cwd-input'), { target: { value: '/tmp/demo' } })
    fireEvent.click(screen.getByRole('button', { name: /创\s*建/ }))

    await waitFor(() => {
      expect(popup.location.href).toBe('http://localhost:9202')
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/instances/inst_1')
    expect(openSpy).toHaveBeenCalled()
  })

  it('closes the popup and surfaces the error when the instance goes down', async () => {
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
    const popup = {
      closed: false,
      location: { href: 'about:blank' },
      close: vi.fn(),
    }
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)

    render(<MemoryRouter><Instances /></MemoryRouter>)
    fireEvent.click(screen.getByText('新建实例'))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'demo' } })
    fireEvent.change(screen.getByTestId('cwd-input'), { target: { value: '/tmp/demo' } })
    fireEvent.click(screen.getByRole('button', { name: /创\s*建/ }))

    await waitFor(() => {
      expect(popup.close).toHaveBeenCalled()
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
    vi.spyOn(window, 'open').mockReturnValue({ closed: false, location: { href: '' }, close: vi.fn() } as unknown as Window)

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
