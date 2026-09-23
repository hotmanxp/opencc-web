// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import McpServersSection from './McpServersSection.js'

/**
 * 设置页的 MCP 服务器入口。
 *
 * 覆盖的关键分支:
 *   - 汇总 Tag 按 connecting / failure / connected 三态选色选文案(用户就是
 *     靠这个 Tag 发现"MCP 挂了");
 *   - 弹窗里的失败 Alert 要给出 server 名与"重启前不会自动再连"的说明;
 *   - 重新连接按钮打 POST /api/mcp/reconnect 并用响应刷新状态;
 *   - `/api/mcp/status` 503(旧后端 / runtime 未就绪)时静默,不炸组件。
 */

const FAILURE = {
  at: 1_700_000_000_000,
  failed: 1,
  total: 2,
  servers: ['cua-driver'],
}

const STATUS = {
  lazyConnect: true,
  connecting: false,
  servers: [
    { name: 'codegraph', type: 'connected', toolCount: 3, commandCount: 1 },
    { name: 'cua-driver', type: 'failed', toolCount: 0, commandCount: 0, error: 'spawn ENOENT' },
  ],
  commands: [
    {
      name: 'mcp__codegraph__build-graph',
      displayName: 'codegraph:build-graph (MCP)',
      description: '构建依赖图',
      serverName: 'codegraph',
    },
  ],
  lastConnectFailure: FAILURE,
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse(STATUS))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('McpServersSection', () => {
  it('存在失败 server 时入口处亮红 Tag', async () => {
    render(<McpServersSection drawerOpen />)
    expect(await screen.findByText('1 个失败')).toBeTruthy()
  })

  it('全部连上时显示连接数', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        ...STATUS,
        servers: [STATUS.servers[0]],
        lastConnectFailure: null,
      }),
    )
    render(<McpServersSection drawerOpen />)
    expect(await screen.findByText('1 个已连接')).toBeTruthy()
  })

  it('drawer 未打开时不请求状态', () => {
    render(<McpServersSection drawerOpen={false} />)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('弹窗展示失败 Alert、server 列表与工具数', async () => {
    render(<McpServersSection drawerOpen />)
    await screen.findByText('1 个失败')

    fireEvent.click(screen.getByTestId('open-mcp-servers'))

    expect(await screen.findByTestId('mcp-failure-alert')).toBeTruthy()
    expect(screen.getByText(/上次连接有 1\/2 个 server 失败/)).toBeTruthy()
    expect(screen.getByText(/未连上:cua-driver/)).toBeTruthy()
    expect(screen.getByTestId('mcp-server-codegraph')).toBeTruthy()
    expect(screen.getByText(/3 个工具 · 1 个命令/)).toBeTruthy()
    // 失败 server 的错误信息要露出来,否则用户无从判断
    expect(screen.getByText(/spawn ENOENT/)).toBeTruthy()
  })

  it('点重新连接会 POST /api/mcp/reconnect 并用响应刷新', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/mcp/reconnect') && init?.method === 'POST') {
        return jsonResponse({ ...STATUS, lastConnectFailure: null })
      }
      return jsonResponse(STATUS)
    })
    render(<McpServersSection drawerOpen />)
    await screen.findByText('1 个失败')

    fireEvent.click(screen.getByTestId('open-mcp-servers'))
    fireEvent.click(screen.getByTestId('mcp-reconnect'))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/mcp/reconnect',
        expect.objectContaining({ method: 'POST' }),
      )
    })
    // 重连成功后失败 Tag 消失
    await waitFor(() => {
      expect(screen.queryByText('1 个失败')).toBeNull()
    })
  })

  it('status 接口 503 时静默降级,不渲染 Tag 也不炸', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'runtime_not_ready' }, 503))
    render(<McpServersSection drawerOpen />)
    // 入口行本身仍在
    expect(await screen.findByTestId('open-mcp-servers')).toBeTruthy()
    expect(screen.queryByText(/个失败/)).toBeNull()
  })
})