// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  structuredGrepRenderer,
  structuredGlobRenderer,
} from '../../../src/web/src/components/toolRenderers/search.js'

/**
 * Phase 4 P2: harness `@deepseek-ai/dsh-tool-fs-search` 的结构化
 * presentationMeta 渲染测试 — 新版按 fileDisplay / DiffBlock 模式.
 *
 * 设计变化（与 Phase 4 P1 旧实现对比）:
 *   - 从 renderOutput 切到 renderFull: 与 Edit/Write/FileDisplay 同模式,
 *     ToolCallBlock 跳过默认折叠面板, 整块挂载 (MessageBubble.tsx:509).
 *   - 状态点: 与 DiffBlock 头部 dot 同款 (#3fb950 done / #ff6600 start).
 *   - antd Card: 每个文件一张 Card, 仿 fileDisplay.FileCard.
 *   - 行号 gutter: 仿 DiffBlock.DiffRowLine, 44px 右对齐 + 行内容.
 *   - 行为按钮: 预览 (openFilePreview) + 打开目录 (POST /api/fs/reveal),
 *     与 FileCard 同套.
 *   - 关键词高亮: pattern 命中的子串用 <mark> 包, GitHub 风格浅黄底.
 */

const renderFullGrep = (msg: unknown) =>
  renderToStaticMarkup(
    React.createElement('div', null, structuredGrepRenderer.renderFull?.(msg as never)),
  )

const renderFullGlob = (msg: unknown) =>
  renderToStaticMarkup(
    React.createElement('div', null, structuredGlobRenderer.renderFull?.(msg as never)),
  )

describe('structuredGrepRenderer', () => {
  describe('preview', () => {
    it('截断 pattern + path 到 80 字符', () => {
      expect(structuredGrepRenderer.preview({ pattern: 'foo', path: '/repo/src' }))
        .toBe('foo in /repo/src')
    })

    it('缺 path 时只输出 pattern', () => {
      expect(structuredGrepRenderer.preview({ pattern: 'foo' })).toBe('foo')
    })
  })

  describe('renderFull — meta matches 路径', () => {
    const baseMsg = {
      type: 'tool_use:done',
      name: 'grep',
      toolUseId: 't1',
      input: { pattern: 'function', path: '/repo/src', include: '*.ts' },
      output: 'unused',
    }

    it('有 meta 时渲染 antd Card 列表 + 文件名 + 命中数 Tag', () => {
      const meta = {
        shape: 'matches',
        files: [
          { path: 'src/a.ts', matches: [
            { lineNumber: 10, line: 'function alpha' },
            { lineNumber: 25, line: 'function beta' },
          ] },
          { path: 'src/b.ts', matches: [{ lineNumber: 3, line: 'function gamma' }] },
        ],
        truncated: false,
        total: 3,
      }
      const html = renderFullGrep({ ...baseMsg, meta })
      // 头部状态点 + 工具名 + 摘要
      expect(html).toContain('Grep')
      expect(html).toContain('Found 3 matches in 2 files')
      // antd Card 列表
      expect(html).toContain('src/a.ts')
      expect(html).toContain('src/b.ts')
      // 命中数 Tag
      expect(html).toContain('2 处命中')
      expect(html).toContain('1 处命中')
      // 行内容 (高亮: function 被 <mark> 包, 与 alpha 之间有 </mark>)
      expect(html).toContain('>function<')
      expect(html).toContain(' alpha')
      expect(html).toContain('>function<')
      expect(html).toContain(' beta')
      expect(html).toContain('>function<')
      expect(html).toContain(' gamma')
      // 行号 gutter (右侧对齐 span)
      expect(html).toContain('>10<')
      expect(html).toContain('>25<')
      expect(html).toContain('>3<')
      // 行为按钮
      expect(html).toContain('预览')
      expect(html).toContain('打开目录')
    })

    it('关键词命中用 <mark> 高亮 (pattern = "function")', () => {
      const meta = {
        shape: 'matches',
        files: [
          { path: 'a.ts', matches: [{ lineNumber: 1, line: 'function foo' }] },
        ],
        truncated: false,
        total: 1,
      }
      const html = renderFullGrep({ ...baseMsg, meta })
      // <mark> 元素应包含 "function"
      expect(html).toMatch(/<mark[^>]*>function<\/mark>/)
    })

    it('非法 regex pattern 时不崩溃, 原文输出', () => {
      // pattern 是 [ (非法), highlightMatches 走 catch 返回原文
      const meta = {
        shape: 'matches',
        files: [
          { path: 'a.ts', matches: [{ lineNumber: 1, line: 'foo [bar' }] },
        ],
        truncated: false,
        total: 1,
      }
      const html = renderFullGrep({ ...baseMsg, input: { ...baseMsg.input, pattern: '[' }, meta })
      expect(html).toContain('foo [bar')
      expect(html).not.toContain('<mark>')
    })

    it('truncated=true 时显示 footer + 摘要加 (capped)', () => {
      const meta = {
        shape: 'matches',
        files: [
          { path: 'a.ts', matches: [{ lineNumber: 1, line: 'match-1' }] },
        ],
        truncated: true,
        total: 100,
      }
      const html = renderFullGrep({ ...baseMsg, meta })
      expect(html).toContain('Found 100 matches')
      expect(html).toContain('(capped)')
      expect(html).toContain('showing 1 of 100')
      expect(html).toContain('99 more omitted')
    })

    it('空 files 时显示 "No matches found"', () => {
      const meta = { shape: 'matches', files: [], truncated: false, total: 0 }
      const html = renderFullGrep({ ...baseMsg, meta })
      expect(html).toContain('No matches found')
    })

    it('单文件时 grammar: "1 file" 而非 "1 files"', () => {
      const meta = {
        shape: 'matches',
        files: [{ path: 'a.ts', matches: [{ lineNumber: 1, line: 'x' }] }],
        truncated: false,
        total: 1,
      }
      const html = renderFullGrep({ ...baseMsg, meta })
      expect(html).toContain('Found 1 matches in 1 file')
      // 不要写 "1 files"
      expect(html).not.toContain('1 files')
    })
  })

  describe('renderFull — meta 缺失/非法 fallback 路径', () => {
    const baseMsg = {
      type: 'tool_use:done',
      name: 'grep',
      toolUseId: 't1',
      input: { pattern: 'foo' },
      output: 'fallback-text',
    }

    it('meta 缺失 → 走文本 fallback + 同样展示 header + 输入', () => {
      const html = renderFullGrep(baseMsg)
      expect(html).toContain('Grep')
      expect(html).toContain('foo')
      expect(html).toContain('fallback-text')
    })

    it.each([
      ['null', null],
      ['string', 'foo'],
      ['array', [1, 2]],
      ['缺 truncated', { shape: 'matches', files: [] }],
      ['缺 total', { shape: 'matches', files: [], truncated: false }],
      ['错 shape', { shape: 'unknown', files: [], truncated: false, total: 0 }],
    ])('非法 meta (%s) 不崩溃, 走 fallback', (_label, badMeta) => {
      const html = renderFullGrep({ ...baseMsg, meta: badMeta })
      expect(html).toContain('fallback-text')
      expect(html).toContain('Grep')
    })
  })

  describe('renderFull — 状态点', () => {
    it('tool_use:done → 绿色 dot', () => {
      const msg = { type: 'tool_use:done', name: 'grep', toolUseId: 't', input: { pattern: 'x' }, output: 'out' }
      const html = renderFullGrep(msg)
      expect(html).toContain('#3fb950') // done dot
    })

    it('tool_use:start (默认) → 橙色 dot', () => {
      const msg = { type: 'tool_use:start', name: 'grep', toolUseId: 't', input: { pattern: 'x' }, output: 'out' }
      const html = renderFullGrep(msg)
      expect(html).toContain('#ff6600') // start dot
    })

    it('tool_use:error → 红色 dot', () => {
      const msg = { type: 'tool_use:error', name: 'grep', toolUseId: 't', input: { pattern: 'x' }, error: 'fail' }
      const html = renderFullGrep(msg)
      expect(html).toContain('#f85149') // error dot
    })
  })

  describe('renderOutput fallback (与 grepRenderer 一致的文本路径)', () => {
    // 签名严格保持 (output, isError) — 与 11 个旧 renderer 完全相同, 不破坏 opencc.
    // MessageBubble 在 renderFull 缺失时才走这条路径. 这里测试防御性 fallback
    // 仍然能输出纯文本, 让旧 transcript 历史不破坏.
    it('output 是字符串时输出纯文本 (与 grepRenderer 行为一致)', () => {
      const html = renderToStaticMarkup(
        React.createElement('div', null, structuredGrepRenderer.renderOutput?.('legacy-text', false)),
      )
      expect(html).toContain('legacy-text')
    })

    it('空 output 返回 null', () => {
      expect(structuredGrepRenderer.renderOutput?.('', false)).toBeNull()
    })

    it('签名只有 2 参 (不引入新参数 — 与 opencc renderer 兼容)', () => {
      // TypeScript 静态保证: renderOutput.length === 2
      expect(structuredGrepRenderer.renderOutput?.length).toBe(2)
    })
  })
})

describe('structuredGlobRenderer', () => {
  describe('preview', () => {
    it('截断 pattern + path 到 80 字符', () => {
      expect(structuredGlobRenderer.preview({ pattern: '**/*.ts', path: '/repo' }))
        .toBe('**/*.ts in /repo')
    })
  })

  describe('renderFull — meta paths 路径', () => {
    const baseMsg = {
      type: 'tool_use:done',
      name: 'glob',
      toolUseId: 't1',
      input: { pattern: '**/*.test.ts', path: '/repo/src' },
      output: 'unused',
    }

    it('有 meta 时渲染路径 Card 列表 + 预览/打开目录按钮', () => {
      const meta = {
        shape: 'paths',
        paths: ['src/a.test.ts', 'src/b.test.ts'],
        truncated: false,
        total: 2,
      }
      const html = renderFullGlob({ ...baseMsg, meta })
      // 头部 + 摘要
      expect(html).toContain('Glob')
      expect(html).toContain('Found 2 files')
      // 路径
      expect(html).toContain('src/a.test.ts')
      expect(html).toContain('src/b.test.ts')
      // 行为按钮 (与 grep 同套)
      expect(html).toContain('预览')
      expect(html).toContain('打开目录')
    })

    it('truncated=true 时 footer + 摘要加 (capped)', () => {
      const meta = {
        shape: 'paths',
        paths: ['a.ts', 'b.ts'],
        truncated: true,
        total: 50,
      }
      const html = renderFullGlob({ ...baseMsg, meta })
      expect(html).toContain('Found 50 files')
      expect(html).toContain('(capped)')
      expect(html).toContain('showing 2 of 50')
      expect(html).toContain('48 more omitted')
    })

    it('空 paths 时显示 "No files found"', () => {
      const meta = { shape: 'paths', paths: [], truncated: false, total: 0 }
      const html = renderFullGlob({ ...baseMsg, meta })
      expect(html).toContain('No files found')
    })

    it('单文件时 grammar: "1 file"', () => {
      const meta = {
        shape: 'paths',
        paths: ['only.ts'],
        truncated: false,
        total: 1,
      }
      const html = renderFullGlob({ ...baseMsg, meta })
      expect(html).toContain('Found 1 file')
      expect(html).not.toContain('Found 1 files')
    })

    it('输入 include 字段不渲染 (glob 没有 include, 防御性跳过)', () => {
      const meta = { shape: 'paths', paths: ['a.ts'], truncated: false, total: 1 }
      const html = renderFullGlob({
        ...baseMsg,
        input: { pattern: '**/*.ts', include: '*.ts' },
        meta,
      })
      // FieldLabel include 不应出现 (grep 才有 include)
      expect(html).not.toContain('>include<')
    })
  })

  describe('renderFull — fallback 路径', () => {
    const baseMsg = {
      type: 'tool_use:done',
      name: 'glob',
      toolUseId: 't1',
      input: { pattern: '**/*.ts' },
      output: 'fallback-text',
    }

    it('meta 缺失 → 文本 fallback', () => {
      const html = renderFullGlob(baseMsg)
      expect(html).toContain('Glob')
      expect(html).toContain('fallback-text')
    })

    it.each([
      ['null', null],
      ['非 SearchMeta', { shape: 'unknown', files: [], truncated: false, total: 0 }],
      ['paths 不是数组', { shape: 'paths', paths: 'not-array', truncated: false, total: 0 }],
    ])('非法 meta (%s) 走 fallback', (_label, badMeta) => {
      const html = renderFullGlob({ ...baseMsg, meta: badMeta })
      expect(html).toContain('fallback-text')
    })
  })
})