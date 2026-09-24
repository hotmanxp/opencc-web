// @vitest-environment happy-dom
// 抽取 useFilePathActions 之前 FilePathChip 没有测试。这个文件是行为回归护栏:
// 抽取后 chip 的 resolve / 多候选 picker / 右键菜单必须与抽取前逐位一致。
import { describe, expect, test, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { message } from 'antd'
import { FilePathChip } from '../../../src/web/src/components/markdown/FilePathChip.js'

const openFilePathPreview = vi.hoisted(() => vi.fn())
const callFsCommand = vi.hoisted(() => vi.fn())

vi.mock('../../../src/web/src/lib/openFilePath.js', () => ({
  FILE_PREVIEW_OPEN_EVENT: 'zai:file-preview-open',
  openFilePathPreview,
  callFsCommand,
}))

// pickCandidate 会写 store 并派 window 事件 —— 这里只验证 picker 弹出,
// 不做候选点击,因此只需要一个不会在渲染期被调用的 store stub。
vi.mock('../../../src/web/src/store/useAgentStore.js', () => ({
  useAgentStore: Object.assign(() => undefined, {
    getState: () => ({ openFilePreview: vi.fn() }),
  }),
}))

beforeEach(() => {
  openFilePathPreview.mockReset()
  callFsCommand.mockReset()
})

describe('FilePathChip', () => {
  test('命中唯一路径时直接打开预览,不弹 picker', async () => {
    openFilePathPreview.mockResolvedValue({ ok: 'exact', abs: '/abs/a.ts' })
    render(<FilePathChip path="src/a.ts" />)
    fireEvent.click(screen.getByTestId('file-path-chip'))
    await waitFor(() => expect(openFilePathPreview).toHaveBeenCalledWith('src/a.ts'))
    expect(screen.queryByTestId('file-path-picker')).not.toBeInTheDocument()
  })

  test('命中多个候选时弹出 picker,列出全部候选', async () => {
    openFilePathPreview.mockResolvedValue({
      ok: 'multiple',
      candidates: [
        { abs: '/p1/a.ts', rel: 'p1/a.ts' },
        { abs: '/p2/a.ts', rel: 'p2/a.ts' },
      ],
    })
    render(<FilePathChip path="a.ts" />)
    fireEvent.click(screen.getByTestId('file-path-chip'))
    expect(await screen.findByTestId('file-path-picker')).toBeInTheDocument()
    expect(screen.getAllByTestId('file-path-picker-item')).toHaveLength(2)
  })

  test('解析失败时 message.error,不弹 picker', async () => {
    const errSpy = vi.spyOn(message, 'error').mockImplementation(() => undefined as never)
    openFilePathPreview.mockResolvedValue({ ok: false, code: 'ENOENT', error: '文件不存在' })
    render(<FilePathChip path="nope.ts" />)
    fireEvent.click(screen.getByTestId('file-path-chip'))
    await waitFor(() => expect(errSpy).toHaveBeenCalledWith('文件不存在'))
    expect(screen.queryByTestId('file-path-picker')).not.toBeInTheDocument()
    errSpy.mockRestore()
  })

  test('右键菜单含预览 / 在文件管理器中显示 / 在终端中打开 / 复制路径', async () => {
    render(<FilePathChip path="src/a.ts" />)
    fireEvent.contextMenu(screen.getByTestId('file-path-chip'))
    expect(await screen.findByText('预览')).toBeInTheDocument()
    expect(screen.getByText('在文件管理器中显示')).toBeInTheDocument()
    expect(screen.getByText('在终端中打开')).toBeInTheDocument()
    expect(screen.getByText('复制路径')).toBeInTheDocument()
  })

  test('右键「在文件管理器中显示」走 callFsCommand(reveal)', async () => {
    callFsCommand.mockResolvedValue({ ok: true, abs: '/abs/a.ts' })
    render(<FilePathChip path="src/a.ts" />)
    fireEvent.contextMenu(screen.getByTestId('file-path-chip'))
    fireEvent.click(await screen.findByText('在文件管理器中显示'))
    await waitFor(() => expect(callFsCommand).toHaveBeenCalledWith('reveal', 'src/a.ts'))
  })
})