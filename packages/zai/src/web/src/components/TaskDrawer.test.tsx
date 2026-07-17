// @vitest-environment happy-dom
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { buildTimeline, formatToolCallLine, formatToolInput, MarkdownText, PromptBlock } from './TaskDrawer.js'

describe('formatToolInput', () => {
  test('Read 使用 @ 前缀显示文件路径', () => {
    expect(formatToolInput('Read', { file_path: '/Users/demo/package.json' })).toBe(
      '@/Users/demo/package.json',
    )
  })

  test('路径、命令和查询输入都压缩为单行', () => {
    expect(formatToolInput('Bash', { command: 'pwd\nls' })).toBe('command=pwd ls')
    expect(formatToolInput('Grep', { query: 'tool\noutput' })).toBe('query=tool output')
    expect(formatToolInput('Custom', { value: 'a\nb' })).toBe('{"value":"a b"}')
  })
})

describe('formatToolCallLine', () => {
  test('完成的 Read 工具显示输入和 Done，不显示结果', () => {
    expect(
      formatToolCallLine({
        name: 'Read',
        input: { file_path: '/Users/demo/package.json' },
        status: 'done',
      }),
    ).toBe('Read: @/Users/demo/package.json (Done)')
  })
})

describe('buildTimeline', () => {
  test('工具完成事件只更新状态，不保存 output', () => {
    const timeline = buildTimeline([
      {
        seq: 1,
        type: 'tool_use:start',
        ts: 100,
        data: {
          toolUseId: 'tool-1',
          name: 'Read',
          input: { file_path: '/Users/demo/package.json' },
        },
      },
      {
        seq: 2,
        type: 'tool_use:done',
        ts: 200,
        data: { toolUseId: 'tool-1', output: 'secret file contents' },
      },
    ])

    expect(timeline).toHaveLength(1)
    expect(timeline[0]).toMatchObject({
      kind: 'tool',
      entry: {
        toolUseId: 'tool-1',
        name: 'Read',
        input: { file_path: '/Users/demo/package.json' },
        status: 'done',
      },
    })
    expect(JSON.stringify(timeline)).not.toContain('secret file contents')
  })

  test('工具失败事件只更新状态，不保存 error', () => {
    const timeline = buildTimeline([
      {
        seq: 1,
        type: 'tool_use:start',
        ts: 100,
        data: { toolUseId: 'tool-2', name: 'Read', input: { file_path: '/tmp/a' } },
      },
      {
        seq: 2,
        type: 'tool_use:error',
        ts: 200,
        data: { toolUseId: 'tool-2', error: { message: 'secret error' } },
      },
    ])

    expect(timeline[0]).toMatchObject({ kind: 'tool', entry: { status: 'error' } })
    expect(JSON.stringify(timeline)).not.toContain('secret error')
  })
})

describe('MarkdownText (kind="text" 渲染器)', () => {
  test('围栏代码块渲染为 <pre>，行内 code 渲染为 <code>', () => {
    const text = '```python\nprint(1)\n``` 和行内 `x`'
    const { container } = render(<MarkdownText text={text} />)
    expect(container.querySelector('pre')).toBeTruthy()
    expect(container.querySelector('code')).toBeTruthy()
  })

  test('列表渲染为 <ul><li>', () => {
    const { container } = render(<MarkdownText text={'- a\n- b'} />)
    expect(container.querySelector('ul')).toBeTruthy()
    expect(container.querySelectorAll('li').length).toBe(2)
  })

  test('链接 target=_blank, href 正确', () => {
    const { container } = render(<MarkdownText text="[click](https://x.com)" />)
    const a = container.querySelector('a')
    expect(a?.getAttribute('href')).toBe('https://x.com')
    expect(a?.getAttribute('target')).toBe('_blank')
    expect(a?.getAttribute('rel')).toContain('noopener')
  })

  test('表格渲染为 <table><thead><tbody>', () => {
    const text = '| h1 | h2 |\n| --- | --- |\n| a | b |'
    const { container } = render(<MarkdownText text={text} />)
    expect(container.querySelector('table')).toBeTruthy()
    expect(container.querySelector('thead')).toBeTruthy()
    expect(container.querySelector('tbody')).toBeTruthy()
  })

  test('引用渲染为 <blockquote>', () => {
    const { container } = render(<MarkdownText text="> 注" />)
    expect(container.querySelector('blockquote')).toBeTruthy()
  })

  test('输入含 <script> 不会渲染为真实 <script> 节点', () => {
    const { container } = render(<MarkdownText text="<script>alert(1)</script>" />)
    expect(container.querySelector('script')).toBeNull()
    // 文本内容应保留(转义后出现在容器里),用户能看到但不执行
    expect(container.textContent).toContain('alert(1)')
  })

  test('MarkdownText 输出带外层 div, lineHeight: 1.6 与 Agent.tsx 等价', () => {
    const { container } = render(<MarkdownText text="hello" />)
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper.tagName).toBe('DIV')
    expect(wrapper.style.lineHeight).toBe('1.6')
  })
})

describe('PromptBlock', () => {
  test('渲染 Prompt: label 与文本内容', () => {
    const { container } = render(<PromptBlock text="hello" />)
    expect(container.textContent).toContain('Prompt:')
    expect(container.textContent).toContain('hello')
  })

  test('短文本 (≤ 2 行 / 120 字符) 不显示展开按钮', () => {
    const { container } = render(<PromptBlock text="short prompt" />)
    // 容器里只有 label + 文本, 没有 "展开" / "收起" 按钮
    expect(container.textContent).not.toContain('展开')
    expect(container.textContent).not.toContain('收起')
  })

  test('长文本默认显示 "展开" 按钮, 点击后切到 "收起"', () => {
    // 5 行 / 每行 30 字符 >> 2 行, 必触发 line-clamp
    const longText = Array.from({ length: 5 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n')
    const { container } = render(<PromptBlock text={longText} />)
    // 默认状态: 有 "展开", 没有 "收起"
    expect(container.textContent).toContain('展开')
    expect(container.textContent).not.toContain('收起')

    const toggle = container.querySelector('button') as HTMLButtonElement
    fireEvent.click(toggle)
    // 展开后: "收起" 出现, "展开" 消失
    expect(container.textContent).toContain('收起')
    expect(container.textContent).not.toContain('展开')
  })

  test('点击 "收起" 回到默认折叠态', () => {
    const longText = Array.from({ length: 5 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n')
    const { container } = render(<PromptBlock text={longText} />)
    const toggle = container.querySelector('button') as HTMLButtonElement
    fireEvent.click(toggle) // 展开
    fireEvent.click(toggle) // 收起
    expect(container.textContent).toContain('展开')
    expect(container.textContent).not.toContain('收起')
  })
})
