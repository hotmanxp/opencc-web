// @vitest-environment happy-dom
/**
 * Phase 4 P2 ego 验收 — 结构化 renderer 端到端验证 (新版 renderFull).
 *
 * 把 dsh-bridge grep 工具真实输出的 meta 输入 zai-web structuredGrepRenderer,
 * 确认 React 渲染出的 HTML 包含:
 *   - 状态点 (done dot #3fb950)
 *   - antd Card 列表 + 文件名 + 命中数 Tag + 预览/打开目录按钮
 *   - 行号 gutter (右侧对齐 span) + 行内容 + pattern 高亮 <mark>
 *   - 截断 footer (showing X of Y — Z more omitted)
 *
 * 上游 grep-direct-test.mjs 在 dsh-bridge 进程内跑真 ripgrep 得到 meta,
 * 这里把那个 meta 喂给 renderer, 验证 UI 渲染管线完整正确.
 */
import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  structuredGrepRenderer,
  structuredGlobRenderer,
} from '../../../src/web/src/components/toolRenderers/search.js'

const renderGrepFull = (msg: unknown) =>
  renderToStaticMarkup(
    React.createElement(
      'div',
      null,
      structuredGrepRenderer.renderFull?.(msg as never),
    ),
  )

const renderGlobFull = (msg: unknown) =>
  renderToStaticMarkup(
    React.createElement(
      'div',
      null,
      structuredGlobRenderer.renderFull?.(msg as never),
    ),
  )

describe('ego: Phase 4 P2 — real harness meta rendered to HTML (renderFull)', () => {
  // 这份 meta 来自 /tmp/dsh-p4-ego/grep-direct-test.mjs 的真实输出 (5 matches
  // 在 alpha.test.ts + beta.test.ts).
  const realGrepMeta = {
    shape: 'matches' as const,
    files: [
      {
        path: 'src/alpha.test.ts',
        matches: [
          { lineNumber: 4, line: "describe('alpha', () => {" },
          { lineNumber: 5, line: "  it('passes', () => {" },
        ],
      },
      {
        path: 'src/beta.test.ts',
        matches: [
          { lineNumber: 4, line: "describe('beta', () => {" },
          { lineNumber: 5, line: "  it('works', () => {" },
          { lineNumber: 8, line: "  it('works again', () => {" },
        ],
      },
    ],
    truncated: false,
    total: 5,
  }

  const realGlobMeta = {
    shape: 'paths' as const,
    paths: ['src/alpha.test.ts', 'src/beta.test.ts'],
    truncated: false,
    total: 2,
  }

  describe('grep renderer with real harness meta', () => {
    const html = renderGrepFull({
      type: 'tool_use:done',
      name: 'grep',
      toolUseId: 't1',
      input: { pattern: 'describe', path: '/Users/ethan/code/opencc-web/packages/dsh-bridge/test' },
      output: 'unused',
      meta: realGrepMeta,
    })

    it('renders state dot in done color (#3fb950)', () => {
      expect(html).toContain('#3fb950')
    })

    it('renders tool name "Grep" in header', () => {
      expect(html).toContain('Grep')
    })

    it('renders summary "Found N matches in M files"', () => {
      expect(html).toContain('Found 5 matches in 2 files')
    })

    it('renders both file paths as antd Card content', () => {
      expect(html).toContain('src/alpha.test.ts')
      expect(html).toContain('src/beta.test.ts')
      expect(html).toContain('grep-match-card')
    })

    it('renders line numbers 4 / 5 / 8 in gutter spans', () => {
      // 行号渲染在 52px 右对齐 span 中, 数字前后无 HTML 标签
      expect(html).toMatch(/>4<\/span>/)
      expect(html).toMatch(/>5<\/span>/)
      expect(html).toMatch(/>8<\/span>/)
    })

    it('renders line content with HTML-escaped apostrophes (React default escape)', () => {
      // 高亮: pattern "describe" 被 <mark> 包, 与后续内容被 </mark> 隔开
      expect(html).toContain('<mark')
      expect(html).toContain('>describe</mark>')
      expect(html).toContain('(&#x27;alpha&#x27;')
      expect(html).toContain('(&#x27;beta&#x27;')
      // "it" 行不被高亮 (pattern 是 describe), 整行连续 (含前导空格)
      expect(html).toContain('works again&#x27;')
    })

    it('renders preview + reveal action buttons', () => {
      expect(html).toContain('预览')
      expect(html).toContain('打开目录')
      expect(html).toContain('grep-open-preview')
      expect(html).toContain('grep-reveal')
    })

    it('renders match count Tag for each file', () => {
      expect(html).toContain('2 处命中')
      expect(html).toContain('3 处命中')
    })

    it('does NOT render truncated footer when truncated=false', () => {
      expect(html).not.toContain('more omitted')
      expect(html).not.toContain('showing')
    })

    it('input section shows pattern + path', () => {
      expect(html).toContain('describe')
      expect(html).toContain('/Users/ethan/code/opencc-web/packages/dsh-bridge/test')
    })
  })

  describe('grep renderer with truncated meta', () => {
    const truncatedMeta = {
      shape: 'matches' as const,
      files: [
        { path: 'src/beta.test.ts', matches: [{ lineNumber: 4, line: "describe('beta', () => {" }] },
      ],
      truncated: true,
      total: 100,
    }
    const html = renderGrepFull({
      type: 'tool_use:done',
      name: 'grep',
      toolUseId: 't2',
      input: { pattern: 'describe' },
      output: 'unused',
      meta: truncatedMeta,
    })

    it('shows footer with "showing N of M — K more omitted"', () => {
      expect(html).toContain('showing 1 of 100')
      expect(html).toContain('99 more omitted')
    })

    it('summary includes (capped) marker', () => {
      expect(html).toContain('(capped)')
    })
  })

  describe('glob renderer with real harness meta', () => {
    const html = renderGlobFull({
      type: 'tool_use:done',
      name: 'glob',
      toolUseId: 't3',
      input: { pattern: '**/*.test.ts', path: '/Users/ethan/code/opencc-web/packages/dsh-bridge/test' },
      output: 'unused',
      meta: realGlobMeta,
    })

    it('renders state dot in done color', () => {
      expect(html).toContain('#3fb950')
    })

    it('renders tool name "Glob"', () => {
      expect(html).toContain('Glob')
    })

    it('renders summary "Found N files"', () => {
      expect(html).toContain('Found 2 files')
    })

    it('renders both file paths', () => {
      expect(html).toContain('src/alpha.test.ts')
      expect(html).toContain('src/beta.test.ts')
      expect(html).toContain('glob-path-card')
    })

    it('renders preview + reveal action buttons', () => {
      expect(html).toContain('预览')
      expect(html).toContain('打开目录')
    })

    it('does NOT render truncated footer when truncated=false', () => {
      expect(html).not.toContain('more omitted')
    })

    it('input section shows pattern + path (NOT include — glob has no include)', () => {
      expect(html).toContain('**/*.test.ts')
      expect(html).toContain('/Users/ethan/code/opencc-web/packages/dsh-bridge/test')
      // glob 的 FieldLabel include 不应出现 (防御 grep 的 include 误用)
      expect(html).not.toContain('>include<')
    })
  })

  describe('fallback path: meta absent', () => {
    // meta 缺失 (旧 transcript 历史 / opencc-cli 路径): 走 fallback 文本渲染,
    // 但仍展示 header + 输入 + 文本 output.
    const html = renderGrepFull({
      type: 'tool_use:done',
      name: 'grep',
      toolUseId: 't4',
      input: { pattern: 'foo' },
      output: 'src/a.ts:10:foo\nsrc/b.ts:25:bar',
    })
    it('falls back to raw text rendering (with header + input)', () => {
      expect(html).toContain('Grep')
      expect(html).toContain('foo')
      expect(html).toContain('src/a.ts:10:foo')
      expect(html).toContain('src/b.ts:25:bar')
    })
  })

  describe('defensive: malformed meta', () => {
    it.each([
      ['null', null],
      ['string', 'foo'],
      ['array', [{ shape: 'matches' }]],
      ['wrong shape', { shape: 'unknown', files: [], truncated: false, total: 0 }],
    ])('malformed meta (%s) falls back gracefully', (_label, badMeta) => {
      const html = renderGrepFull({
        type: 'tool_use:done',
        name: 'grep',
        toolUseId: 't5',
        input: { pattern: 'foo' },
        output: 'fallback-text',
        meta: badMeta,
      })
      expect(html).toContain('fallback-text')
      expect(html).toContain('Grep')
    })
  })
})