// @vitest-environment happy-dom
//
// markdown 代码块的**主题感知**(2026-09-24):底色/描边必须走 index.css 的
// --code-bg / --code-border(纯 CSS 变量,切主题零重渲),语法 token 配色按
// <html data-theme> 在 oneDark / oneLight 之间切。
//
// 背景:用户反馈亮色主题下 README 数据流图的代码块是深色底(#282c34)。深底
// 是 oneDark 写死的,浅底页面/浅色气泡上很突兀;而只把底色换成浅灰、仍用
// oneDark 的浅色 token 会「浅底 + 浅色字」糊成一片 —— 所以配色这一处必须
// 走 JS,底色反过来必须走 CSS,两者都不能省。
//
// 单测只覆盖「选中了哪个主题对象 / 类名是否走 token」这一层;真实配色效果
// 需要浏览器验收(CSS 变量级联 happy-dom 不计算)。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import React from 'react'

// 记录每次 SyntaxHighlighter 渲染收到的 props。vi.hoisted 保证数组在
// vi.mock 工厂(提升到 import 之前)执行时已存在。
const seen = vi.hoisted(() => [] as Array<{ style: unknown; customStyle: unknown }>)

vi.mock('./syntaxHighlighter.js', () => ({
  SyntaxHighlighter: ({ style, customStyle, children }: any) => {
    seen.push({ style, customStyle })
    return (
      <pre data-testid="syntax-highlighter">
        <code>{children}</code>
      </pre>
    )
  },
  oneDark: { __theme: 'dark' },
  oneLight: { __theme: 'light' },
}))

import { MarkdownText } from './MarkdownText.js'

const FENCED = '```ts\nconst a = 1\n```'
const BARE_FENCED = '```\n输入框 → Express 路由\n```'

function setTheme(mode: 'dark' | 'light'): void {
  document.documentElement.dataset.theme = mode
}

function resetTheme(): void {
  delete document.documentElement.dataset.theme
}

afterEach(() => {
  seen.length = 0
  resetTheme()
})

describe('MarkdownText 代码块主题感知', () => {
  it('无语言标注的围栏块底色走 --code-bg / --code-border token', () => {
    const { container } = render(<MarkdownText text={BARE_FENCED} />)
    const pre = container.querySelector('pre')
    expect(pre).toBeTruthy()
    expect(pre?.className).toContain('bg-[var(--code-bg)]')
    expect(pre?.className).toContain('border-[var(--code-border)]')
    // 关键回归:不能再把深色底写死成行内样式(happy-dom 不解析 CSS 变量,
    // 只剩类名可断言 —— 硬编码会以行内 style 形式出现,这里守住这一点)
    expect(pre?.getAttribute('style')).toBeNull()
    expect(pre?.className).not.toContain('#282c34')
  })

  it('挂载时 data-theme=light → 用 oneLight（浅底必须配浅色 token）', async () => {
    setTheme('light')
    render(<MarkdownText text={FENCED} />)
    await waitFor(() => expect(seen.length).toBeGreaterThan(0))
    expect(seen.at(-1)?.style).toEqual({ __theme: 'light' })
    // 高亮块与占位块同底色:同样是 CSS 变量,不是 oneLight 自带的 #fafafa
    expect(seen.at(-1)?.customStyle).toMatchObject({
      background: 'var(--code-bg)',
      border: '1px solid var(--code-border)',
    })
  })

  it('挂载时 data-theme=dark → 用 oneDark,底色仍是同一套 CSS 变量', async () => {
    setTheme('dark')
    render(<MarkdownText text={FENCED} />)
    await waitFor(() => expect(seen.length).toBeGreaterThan(0))
    expect(seen.at(-1)?.style).toEqual({ __theme: 'dark' })
    // 两个主题共用同一份底色/描边变量 —— 换主题不该跳版
    expect(seen.at(-1)?.customStyle).toMatchObject({
      background: 'var(--code-bg)',
      border: '1px solid var(--code-border)',
    })
  })

  it('主题切换后已渲染的代码块换配色（MutationObserver 生效）', async () => {
    setTheme('dark')
    render(<MarkdownText text={FENCED} />)
    await waitFor(() => expect(seen.at(-1)?.style).toEqual({ __theme: 'dark' }))

    act(() => setTheme('light'))
    await waitFor(() => expect(seen.at(-1)?.style).toEqual({ __theme: 'light' }))

    act(() => setTheme('dark'))
    await waitFor(() => expect(seen.at(-1)?.style).toEqual({ __theme: 'dark' }))
  })

  it('行内 code 不受主题影响（仍是行内分支，无 <pre>）', () => {
    setTheme('light')
    const { container } = render(<MarkdownText text="用 `useMemo` 包一下" />)
    expect(container.querySelector('pre')).toBeNull()
    expect(container.querySelector('p code')?.textContent).toBe('useMemo')
  })
})