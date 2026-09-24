// @vitest-environment happy-dom
// 注: happy-dom 不做真实 CSS 布局,这里只验证渲染行为与文字,不断言样式值。
import { describe, expect, test, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { message } from 'antd'
import { TurnArtifactsBlock } from '../../../src/web/src/components/transcript/TurnArtifactsBlock.js'
import type { ArtifactFile } from '../../../src/web/src/components/transcript/deriveTurnArtifacts.js'

const openFilePathPreview = vi.hoisted(() => vi.fn())

vi.mock('../../../src/web/src/lib/openFilePath.js', () => ({
  FILE_PREVIEW_OPEN_EVENT: 'zai:file-preview-open',
  openFilePathPreview,
  callFsCommand: vi.fn(),
}))

// 行点击路径只用到 store 的 getState().openFilePreview,渲染期不读 store。
vi.mock('../../../src/web/src/store/useAgentStore.js', () => ({
  useAgentStore: Object.assign(() => undefined, {
    getState: () => ({ openFilePreview: vi.fn() }),
  }),
}))

function file(path: string, over: Partial<ArtifactFile> = {}): ArtifactFile {
  return { path, label: '编辑', count: 1, written: false, ...over }
}

beforeEach(() => {
  openFilePathPreview.mockReset()
})

describe('TurnArtifactsBlock — 渲染', () => {
  test('块头显示文件数,行显示 basename', () => {
    render(<TurnArtifactsBlock files={[file('/abs/dir/SettingsDrawer.tsx'), file('/abs/dir/a.ts')]} />)
    expect(screen.getByTestId('turn-artifacts-block')).toBeInTheDocument()
    expect(screen.getByText('本轮产物 · 2 个文件')).toBeInTheDocument()
    expect(screen.getByText('SettingsDrawer.tsx')).toBeInTheDocument()
    expect(screen.getByText('a.ts')).toBeInTheDocument()
  })

  test('写入 / 编辑徽标分别渲染,出现次数 > 1 时显示 ×N', () => {
    render(
      <TurnArtifactsBlock
        files={[
          file('/abs/a.ts', { label: '写入', written: true }),
          file('/abs/b.ts', { label: '编辑', count: 3 }),
        ]}
      />,
    )
    expect(screen.getByText('写入')).toBeInTheDocument()
    expect(screen.getByText('编辑')).toBeInTheDocument()
    expect(screen.getByText('×3')).toBeInTheDocument()
  })

  test('count === 1 时不显示 ×N 角标', () => {
    render(<TurnArtifactsBlock files={[file('/abs/a.ts')]} />)
    expect(screen.queryByText(/^×/)).not.toBeInTheDocument()
  })
})

describe('TurnArtifactsBlock — 折叠', () => {
  const many = Array.from({ length: 9 }, (_, i) => file(`/abs/f${i}.ts`))

  test('超过 8 个文件时默认折叠,块头仍显示总数', () => {
    render(<TurnArtifactsBlock files={many} />)
    expect(screen.getByText('本轮产物 · 9 个文件')).toBeInTheDocument()
    expect(screen.queryAllByTestId('turn-artifact-row')).toHaveLength(0)
  })

  test('点击块头展开后列出全部文件', () => {
    render(<TurnArtifactsBlock files={many} />)
    fireEvent.click(screen.getByTestId('turn-artifacts-header'))
    expect(screen.getAllByTestId('turn-artifact-row')).toHaveLength(9)
  })

  test('恰好 8 个文件时默认展开', () => {
    render(<TurnArtifactsBlock files={many.slice(0, 8)} />)
    expect(screen.getAllByTestId('turn-artifact-row')).toHaveLength(8)
  })
})

describe('TurnArtifactsBlock — 预览动作', () => {
  test('点击文件行调用 openFilePathPreview(该行路径原文)', async () => {
    openFilePathPreview.mockResolvedValue({ ok: 'exact', abs: '/abs/a.ts' })
    render(<TurnArtifactsBlock files={[file('src/a.ts')]} />)
    fireEvent.click(screen.getByTestId('turn-artifact-row'))
    await waitFor(() => expect(openFilePathPreview).toHaveBeenCalledWith('src/a.ts'))
  })

  test('命中多个候选时弹出 picker', async () => {
    openFilePathPreview.mockResolvedValue({
      ok: 'multiple',
      candidates: [
        { abs: '/p1/a.ts', rel: 'p1/a.ts' },
        { abs: '/p2/a.ts', rel: 'p2/a.ts' },
      ],
    })
    render(<TurnArtifactsBlock files={[file('a.ts')]} />)
    fireEvent.click(screen.getByTestId('turn-artifact-row'))
    expect(await screen.findByTestId('file-path-picker')).toBeInTheDocument()
    expect(screen.getAllByTestId('file-path-picker-item')).toHaveLength(2)
  })

  test('解析失败时 message.error', async () => {
    const errSpy = vi.spyOn(message, 'error').mockImplementation(() => undefined as never)
    openFilePathPreview.mockResolvedValue({ ok: false, code: 'ENOENT', error: '文件不存在' })
    render(<TurnArtifactsBlock files={[file('nope.ts')]} />)
    fireEvent.click(screen.getByTestId('turn-artifact-row'))
    await waitFor(() => expect(errSpy).toHaveBeenCalledWith('文件不存在'))
    errSpy.mockRestore()
  })

  test('右键文件行弹出与 chip 一致的菜单', async () => {
    render(<TurnArtifactsBlock files={[file('src/a.ts')]} />)
    fireEvent.contextMenu(screen.getByTestId('turn-artifact-row'))
    expect(await screen.findByText('预览')).toBeInTheDocument()
    expect(screen.getByText('在文件管理器中显示')).toBeInTheDocument()
    expect(screen.getByText('在终端中打开')).toBeInTheDocument()
    expect(screen.getByText('复制路径')).toBeInTheDocument()
  })
})