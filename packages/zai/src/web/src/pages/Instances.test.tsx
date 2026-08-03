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
    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/tmp/demo' } })
    fireEvent.click(screen.getByRole('button', { name: /创\s*建/ }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/instances',
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })
})
