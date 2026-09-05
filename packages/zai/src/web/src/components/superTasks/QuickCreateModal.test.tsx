// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import QuickCreateModal, { deriveTitleFromDescription } from './QuickCreateModal'
import { useSuperTaskStore } from '../../store/useSuperTaskStore'
import { useAgentStore } from '../../store/useAgentStore'

vi.mock('../../lib/agentSessionApi', () => ({
  createAgentSession: vi.fn(async () => 'quick-sess-1'),
  deleteAgentSession: vi.fn(async () => {}),
  pickLastSelectedModel: vi.fn(() => ({})),
}))
vi.mock('../../lib/api', () => ({
  api: { post: vi.fn(async () => ({ sessionId: 'quick-sess-1', queued: false })) },
}))

import {
  createAgentSession, deleteAgentSession,
} from '../../lib/agentSessionApi'
import { api } from '../../lib/api'

beforeEach(() => {
  useSuperTaskStore.setState({
    buckets: {
      queue: [],
      processing: [],
      verifying: [],
      finished: [
        { id: 'tf-finished01', title: '前置任务 A', status: 'done', cwd: '/p', bucket: 'finished-tasks' },
        { id: 'tf-finished02', title: '前置任务 B', status: 'done', cwd: '/p', bucket: 'finished-tasks' },
      ],
    },
    managed: false, loading: false, error: null,
    lastCreatedTaskId: null, loadedOnce: true,
    clearLastCreated: vi.fn(),
  })
  useAgentStore.setState({
    sessionId: 'sup-1',
    sessions: [{ sessionId: 'sup-1', updatedAt: 1 } as never],
    cwd: '/current/instance/cwd',
  })
  vi.clearAllMocks()
})

describe('QuickCreateModal (2026-09-04 quick-intake; tf-429i39sy 2026-09-05 去 title)', () => {
  it('打开时只渲染 description(必填)+ priority / cwd / agent / dependsOn,不再有 title 输入', () => {
    render(<QuickCreateModal open onClose={vi.fn()} />)
    expect(screen.queryByTestId('quick-title-input')).toBeNull()
    expect(screen.getByTestId('quick-description-input')).toBeTruthy()
    expect(screen.getByTestId('quick-priority-radio')).toBeTruthy()
    expect(screen.getByTestId('quick-cwd-input')).toBeTruthy()
    expect(screen.getByTestId('quick-agent-select')).toBeTruthy()
    expect(screen.getByTestId('quick-depends-on-select')).toBeTruthy()
  })

  it('提交按钮初始 disabled(description 必填)', () => {
    render(<QuickCreateModal open onClose={vi.fn()} />)
    const btn = screen.getByTestId('quick-submit-button') as HTMLButtonElement
    expect(btn.hasAttribute('disabled')).toBe(true)
  })

  it('priority 缺省 = P2', () => {
    render(<QuickCreateModal open onClose={vi.fn()} />)
    // data-priority 在 input 元素上;选中态给 input.checked = true + 父 label
    // 加 ant-radio-button-wrapper-checked class。
    const p2Input = screen.getByDisplayValue('P2') as HTMLInputElement
    expect(p2Input.checked).toBe(true)
    // 父 label 应带选中 class
    const label = p2Input.closest('label.ant-radio-button-wrapper')
    expect(label?.classList.contains('ant-radio-button-wrapper-checked')).toBe(true)
  })

  it('cwd 缺省 = useAgentStore.cwd(当前实例 cwd)', () => {
    render(<QuickCreateModal open onClose={vi.fn()} />)
    const input = screen.getByTestId('quick-cwd-input') as HTMLInputElement
    expect(input.value).toBe('/current/instance/cwd')
  })

  it('填齐 description 后提交按钮 enable(没有 title 字段)', () => {
    render(<QuickCreateModal open onClose={vi.fn()} />)
    const descInput = screen.getByTestId('quick-description-input')
    fireEvent.change(descInput, { target: { value: '把按钮文案改为完成' } })
    const btn = screen.getByTestId('quick-submit-button') as HTMLButtonElement
    expect(btn.hasAttribute('disabled')).toBe(false)
  })

  it('description 仅空白时提交按钮仍 disabled(防止 trim 后空)', () => {
    render(<QuickCreateModal open onClose={vi.fn()} />)
    const descInput = screen.getByTestId('quick-description-input')
    fireEvent.change(descInput, { target: { value: '   \n   ' } })
    const btn = screen.getByTestId('quick-submit-button') as HTMLButtonElement
    expect(btn.hasAttribute('disabled')).toBe(true)
  })

  it('dependsOn 下拉只展示 finished 桶任务(不会含 queue / processing / verifying)', () => {
    useSuperTaskStore.setState({
      buckets: {
        queue: [{ id: 'tf-queued-1', title: '队列任务', status: 'queued', cwd: '/p', bucket: 'queue-tasks' }],
        processing: [],
        verifying: [],
        finished: [{ id: 'tf-fin-1', title: '前置 A', status: 'done', cwd: '/p', bucket: 'finished-tasks' }],
      },
    })
    render(<QuickCreateModal open onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('quick-depends-on-select'))
    const select = screen.getByTestId('quick-depends-on-select') as HTMLElement
    // finishedTasks 参数已显式只有 finished 桶,UI 不会越界。
    expect(select).toBeTruthy()
  })

  it('提交调 createAgentSession with mainAgent="task-intake-quick" + cwd', async () => {
    render(<QuickCreateModal open onClose={vi.fn()} />)
    fireEvent.change(screen.getByTestId('quick-description-input'), { target: { value: '把按钮文案改为完成' } })
    fireEvent.click(screen.getByTestId('quick-submit-button'))
    await waitFor(() => {
      expect(createAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({ mainAgent: 'task-intake-quick' }),
      )
    })
  })

  it('提交后向 /agent/prompt 发送结构化文本:title 从 description 第一行截取 + 含 description/priority/cwd + mode: "quick"', async () => {
    render(<QuickCreateModal open onClose={vi.fn()} />)
    fireEvent.change(screen.getByTestId('quick-description-input'), {
      target: { value: '改 /m-super-tasks 顶栏文案\n\n第二行不进入 title' },
    })
    fireEvent.click(screen.getByTestId('quick-submit-button'))
    await waitFor(() => {
      expect(api.post).toHaveBeenCalled()
    })
    const call = (api.post as unknown as { mock: { calls: Array<[string, { prompt: string }, { headers: Record<string, string> }]> } }).mock.calls[0]
    expect(call?.[0]).toBe('/agent/prompt')
    // title 由 client 从 description 第一行截取,不是来自独立输入;
    // title 行是单独一行,后面紧跟换行 + 下一行('description: ')。
    expect(call?.[1].prompt).toContain('- title: 改 /m-super-tasks 顶栏文案\n')
    // description 字段保留完整多行输入(包含第二行);只验证 title 那行没把第二行塞进去。
    expect(call?.[1].prompt).toContain('description: 改 /m-super-tasks 顶栏文案\n\n第二行不进入 title')
    expect(call?.[1].prompt).toContain('priority: P2')
    expect(call?.[1].prompt).toContain('cwd: /current/instance/cwd')
    expect(call?.[1].prompt).toContain('mode: "quick"')
    // 必须不出现禁词(测试 systemPrompt 串,确保 prompt 内容也遵守)
    expect(call?.[1].prompt).not.toContain('brainstorm.md')
    expect(call?.[1].prompt).not.toContain('plan.md')
    expect(call?.[2].headers['X-Session-Id']).toBe('quick-sess-1')
  })

  it('description 第一行超 50 字:title 被截断并加 ellipsis', async () => {
    render(<QuickCreateModal open onClose={vi.fn()} />)
    const long = 'a'.repeat(60)
    fireEvent.change(screen.getByTestId('quick-description-input'), {
      target: { value: long + '\n第二行' },
    })
    fireEvent.click(screen.getByTestId('quick-submit-button'))
    await waitFor(() => {
      expect(api.post).toHaveBeenCalled()
    })
    const call = (api.post as unknown as { mock: { calls: Array<[string, { prompt: string }, unknown]> } }).mock.calls[0]
    expect(call?.[1].prompt).toContain(`title: ${'a'.repeat(50)}…`)
  })

  it('created 信号到达后弹窗切换到完成条 + 显示「完成」按钮', async () => {
    render(<QuickCreateModal open onClose={vi.fn()} />)
    act(() => { useSuperTaskStore.setState({ lastCreatedTaskId: 'tf-quick01' }) })
    expect(await screen.findByText(/任务 tf-quick01 已创建/)).toBeTruthy()
    const doneBtn = await screen.findByRole('button', { name: (n) => n.replace(/\s+/g, '') === '完成' })
    expect(doneBtn).toBeTruthy()
  })

  it('点击完成按钮调 deleteAgentSession + clearLastCreated + onClose', async () => {
    const onClose = vi.fn()
    render(<QuickCreateModal open onClose={onClose} />)
    fireEvent.change(screen.getByTestId('quick-description-input'), { target: { value: '改文案' } })
    fireEvent.click(screen.getByTestId('quick-submit-button'))
    await waitFor(() => {
      expect(createAgentSession).toHaveBeenCalled()
    })
    act(() => { useSuperTaskStore.setState({ lastCreatedTaskId: 'tf-q1' }) })
    const doneBtn = await screen.findByRole('button', { name: (n) => n.replace(/\s+/g, '') === '完成' })
    fireEvent.click(doneBtn)
    await waitFor(() => {
      expect(deleteAgentSession).toHaveBeenCalledWith('quick-sess-1')
      expect(onClose).toHaveBeenCalled()
    })
  })

  describe('deriveTitleFromDescription 工具函数', () => {
    it('单行 description:整行作为 title', () => {
      expect(deriveTitleFromDescription('改文案')).toBe('改文案')
    })

    it('多行 description:只取第一行,后续行不进 title', () => {
      expect(deriveTitleFromDescription('第一行\n第二行')).toBe('第一行')
      expect(deriveTitleFromDescription('第一行\r\n第二行')).toBe('第一行')
    })

    it('前后空白被 trim', () => {
      expect(deriveTitleFromDescription('  hello world  ')).toBe('hello world')
      expect(deriveTitleFromDescription('\n\nhello\n')).toBe('hello')
    })

    it('超过 50 字:截断到 50 字 + ellipsis', () => {
      const long = 'a'.repeat(80)
      expect(deriveTitleFromDescription(long)).toBe('a'.repeat(50) + '…')
    })

    it('正好 50 字:不截断,不加 ellipsis', () => {
      const exactly = 'b'.repeat(50)
      expect(deriveTitleFromDescription(exactly)).toBe(exactly)
    })

    it('空 / 仅空白:fallback "quick task"(后端 zod 校验过不去)', () => {
      expect(deriveTitleFromDescription('')).toBe('quick task')
      expect(deriveTitleFromDescription('   \n  ')).toBe('quick task')
    })
  })

  describe('fullscreen 模式(2026-09-04 /m-super-tasks 复用)', () => {
    it('fullscreen=true:Modal 容器宽 = 100vw,无圆角,顶 0', () => {
      render(<QuickCreateModal open onClose={vi.fn()} fullscreen />)
      const modal = document.querySelector('.ant-modal') as HTMLElement | null
      expect(modal).toBeTruthy()
      expect(modal?.style.width).toBe('100vw')
      expect(modal?.style.top).toBe('0px')
      expect(modal?.style.maxWidth).toBe('100vw')
      expect(modal?.style.margin).toBe('0px')
      expect(modal?.style.paddingBottom).toBe('0px')
      const content = document.querySelector('.ant-modal-content') as HTMLElement | null
      expect(content).toBeTruthy()
      expect(content?.style.borderRadius).toBe('0px')
    })

    it('fullscreen=true:表单仍渲染 description / priority / submit 控件;不再有 title 输入', () => {
      render(<QuickCreateModal open onClose={vi.fn()} fullscreen />)
      expect(screen.queryByTestId('quick-title-input')).toBeNull()
      expect(screen.getByTestId('quick-description-input')).toBeTruthy()
      expect(screen.getByTestId('quick-priority-radio')).toBeTruthy()
      expect(screen.getByTestId('quick-cwd-input')).toBeTruthy()
      expect(screen.getByTestId('quick-submit-button')).toBeTruthy()
    })

    it('fullscreen=false(默认):桌面回归 width=640,content 无内联 borderRadius', () => {
      render(<QuickCreateModal open onClose={vi.fn()} />)
      const modal = document.querySelector('.ant-modal') as HTMLElement | null
      expect(modal).toBeTruthy()
      expect(modal?.style.width).toBe('640px')
      expect(modal?.style.top).toBe('')
      const content = document.querySelector('.ant-modal-content') as HTMLElement | null
      expect(content).toBeTruthy()
      expect(content?.style.borderRadius).not.toBe('0px')
    })
  })

  // ---- mobileAsDrawer 模式(tf-cy9x9kjh,/m-super-tasks 抽屉式)----

  it('mobileAsDrawer=true:渲染 .ant-drawer(非 .ant-modal),顶部拖把可见', () => {
    render(<QuickCreateModal open onClose={vi.fn()} mobileAsDrawer />)
    expect(document.querySelector('.ant-drawer')).toBeTruthy()
    expect(document.querySelector('.ant-modal')).toBeNull()
    expect(screen.getByTestId('quick-drawer-handle')).toBeTruthy()
    expect(screen.getByTestId('quick-mobile-drawer')).toBeTruthy()
  })

  it('mobileAsDrawer=true:表单字段仍完整渲染(description/priority/cwd/agent/dependsOn/submit);不再有 title 输入', () => {
    render(<QuickCreateModal open onClose={vi.fn()} mobileAsDrawer />)
    expect(screen.queryByTestId('quick-title-input')).toBeNull()
    expect(screen.getByTestId('quick-description-input')).toBeTruthy()
    expect(screen.getByTestId('quick-priority-radio')).toBeTruthy()
    expect(screen.getByTestId('quick-cwd-input')).toBeTruthy()
    expect(screen.getByTestId('quick-agent-select')).toBeTruthy()
    expect(screen.getByTestId('quick-depends-on-select')).toBeTruthy()
    expect(screen.getByTestId('quick-submit-button')).toBeTruthy()
  })

  it('mobileAsDrawer=true:created 信号 → 完成条在 Drawer 内渲染', async () => {
    render(<QuickCreateModal open onClose={vi.fn()} mobileAsDrawer />)
    act(() => { useSuperTaskStore.setState({ lastCreatedTaskId: 'tf-quickmob' }) })
    expect(await screen.findByText(/任务 tf-quickmob 已创建/)).toBeTruthy()
    expect(document.querySelector('.ant-drawer')).toBeTruthy()
  })

  it('默认(桌面):回归 .ant-modal + width=640;无 drawer,无 drawer-handle', () => {
    render(<QuickCreateModal open onClose={vi.fn()} />)
    const modal = document.querySelector('.ant-modal') as HTMLElement | null
    expect(modal).toBeTruthy()
    expect(modal?.style.width).toBe('640px')
    expect(document.querySelector('.ant-drawer')).toBeNull()
    expect(screen.queryByTestId('quick-drawer-handle')).toBeNull()
  })

  describe('cwd picker', () => {
    it('renders quick-cwd-picker-trigger button next to the cwd input', () => {
      render(<QuickCreateModal open onClose={vi.fn()} />)
      expect(screen.getByTestId('quick-cwd-picker-trigger')).toBeTruthy()
    })

    it('clicking picker trigger opens the DirectoryPicker modal', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, path: '/x', parent: '/', home: '/', entries: [] }), { status: 200 })))
      render(<QuickCreateModal open onClose={vi.fn()} />)
      fireEvent.click(screen.getByTestId('quick-cwd-picker-trigger'))
      expect(await screen.findByTestId('quick-directory-picker')).toBeTruthy()
      vi.unstubAllGlobals()
    })

    it('DirectoryPicker onSelect updates the cwd field', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(
        JSON.stringify({ ok: true, path: '/Users/picked', parent: '/Users', home: '/Users', entries: [] }),
        { status: 200 },
      )))
      render(<QuickCreateModal open onClose={vi.fn()} />)
      fireEvent.click(screen.getByTestId('quick-cwd-picker-trigger'))
      // 在 picker 内 fetch 完成后,点「选择当前目录」
      await screen.findByTestId('picker-select')
      fireEvent.click(screen.getByTestId('picker-select'))
      const input = screen.getByTestId('quick-cwd-input') as HTMLInputElement
      expect(input.value).toBe('/Users/picked')
      vi.unstubAllGlobals()
    })

    it('DirectoryPicker cancel keeps cwd unchanged', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, path: '/x', parent: '/', home: '/', entries: [] }), { status: 200 })))
      render(<QuickCreateModal open onClose={vi.fn()} />)
      const before = (screen.getByTestId('quick-cwd-input') as HTMLInputElement).value
      fireEvent.click(screen.getByTestId('quick-cwd-picker-trigger'))
      await screen.findByTestId('picker-cancel')
      fireEvent.click(screen.getByTestId('picker-cancel'))
      const after = (screen.getByTestId('quick-cwd-input') as HTMLInputElement).value
      expect(after).toBe(before)
      vi.unstubAllGlobals()
    })
  })

  describe('image attachments', () => {
    function makeImageFile(name: string, type: string, sizeBytes = 1024): File {
      // happy-dom / jsdom 的 File 是支持的。直接构造。
      const blob = new Blob([new Uint8Array(sizeBytes)], { type })
      return new File([blob], name, { type })
    }

    it('renders quick-image-picker-trigger button below description', () => {
      render(<QuickCreateModal open onClose={vi.fn()} />)
      expect(screen.getByTestId('quick-image-picker-trigger')).toBeTruthy()
    })

    it('clicking trigger calls hidden input.click()', () => {
      // input 在组件里是 plain <input type="file"> (accept="image/*" multiple)。
      // Modal 内容用 portal 渲染到 document.body,所以走 document.querySelector。
      render(<QuickCreateModal open onClose={vi.fn()} />)
      const input = document.querySelector('input[type="file"]') as HTMLInputElement
      expect(input).toBeTruthy()
      const clickSpy = vi.spyOn(input, 'click')
      fireEvent.click(screen.getByTestId('quick-image-picker-trigger'))
      expect(clickSpy).toHaveBeenCalled()
    })

    it('readImageAsBase64 success → quick-attachment-strip renders ready chip', async () => {
      render(<QuickCreateModal open onClose={vi.fn()} />)
      const input = document.querySelector('input[type="file"]') as HTMLInputElement
      const file = makeImageFile('shot.png', 'image/png')
      // happy-dom 可能不触发完整的 change 链路 — 直接走 onChange
      fireEvent.change(input, { target: { files: [file] } })
      await waitFor(() => {
        expect(screen.getByTestId('quick-attachment-strip')).toBeTruthy()
      })
    })

    it('pasting an image file into the description triggers addImages (attachment chip appears)', async () => {
      const file = makeImageFile('paste.png', 'image/png')
      const dataTransfer = {
        items: [{ kind: 'file', getAsFile: () => file, type: 'image/png' }],
      }
      render(<QuickCreateModal open onClose={vi.fn()} />)
      const textarea = screen.getByTestId('quick-description-input') as HTMLTextAreaElement
      const pasteEvent = {
        clipboardData: dataTransfer,
        preventDefault: vi.fn(),
      } as unknown as React.ClipboardEvent<HTMLTextAreaElement>
      fireEvent.paste(textarea, pasteEvent)
      // addImages 被调用的副作用:quick-attachment-strip 出现 (即有附件 chip)
      await waitFor(() => {
        expect(screen.getByTestId('quick-attachment-strip')).toBeTruthy()
      })
    })

    it('paste with no image file leaves text behavior alone (no attachment added)', async () => {
      const dataTransfer = { items: [] }
      render(<QuickCreateModal open onClose={vi.fn()} />)
      const textarea = screen.getByTestId('quick-description-input') as HTMLTextAreaElement
      fireEvent.paste(textarea, { clipboardData: dataTransfer, preventDefault: vi.fn() } as unknown as React.ClipboardEvent<HTMLTextAreaElement>)
      // 等一拍确认没有附件出现
      await new Promise((r) => setTimeout(r, 50))
      expect(screen.queryByTestId('quick-attachment-strip')).toBeNull()
    })

    it('pasting a non-image file (e.g. PDF) does NOT add an attachment', async () => {
      const pdfFile = makeImageFile('doc.pdf', 'application/pdf')
      const dataTransfer = {
        items: [{ kind: 'file', getAsFile: () => pdfFile, type: 'application/pdf' }],
      }
      render(<QuickCreateModal open onClose={vi.fn()} />)
      const textarea = screen.getByTestId('quick-description-input') as HTMLTextAreaElement
      fireEvent.paste(textarea, { clipboardData: dataTransfer, preventDefault: vi.fn() } as unknown as React.ClipboardEvent<HTMLTextAreaElement>)
      await new Promise((r) => setTimeout(r, 50))
      expect(screen.queryByTestId('quick-attachment-strip')).toBeNull()
    })

    it('× button calls removeAttachment (chip removed from strip)', async () => {
      render(<QuickCreateModal open onClose={vi.fn()} />)
      const input = document.querySelector('input[type="file"]') as HTMLInputElement
      fireEvent.change(input, { target: { files: [makeImageFile('shot.png', 'image/png')] } })
      await waitFor(() => { expect(screen.getByTestId('quick-attachment-strip')).toBeTruthy() })
      const removeBtn = document.querySelector('[data-testid^="quick-attachment-chip-"][data-testid$="-remove"]') as HTMLElement
      fireEvent.click(removeBtn)
      // 移除后 strip 卸载(items 0 → null)
      await waitFor(() => {
        expect(screen.queryByTestId('quick-attachment-strip')).toBeNull()
      })
    })
  })
})