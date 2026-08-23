// @vitest-environment happy-dom
/**
 * Phase 4 P2: 模拟 zai UI 真实渲染链路 — 验证当 AgentMessage 携带正确的
 * toolName 时,我们的 structuredGrepRenderer / structuredGlobRenderer 被
 * 正确选中并渲染.
 *
 * 这个 test 模拟 zai-side store + 完整 transcript → AgentMessage 链路,
 * 然后调 getRenderer(toolName) → renderFull(msg) 验证:
 *   - 工具名 "grep" → structuredGrepRenderer
 *   - 工具名 "glob" → structuredGlobRenderer
 *   - 工具名 "Grep" (旧 opencc) → grepRenderer (向后兼容)
 *   - 工具名 "Ripgrep" (旧 dsh-bridge) → grepRenderer (向后兼容)
 *
 * 注意: 这个 test 不验证 zai transcript 投影 bug (tool_use name 缺失).
 * 该 bug 是上游 zai 的独立 issue, 在本仓库的 useAgentStore / zai-server/
 * transcript.ts 链路中. 修了之后, store 透传的 msg.name 会是 "grep",
 * 届时此 test 验证的链路就会在 UI 上真实跑通.
 */
import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { getRenderer } from '../../../src/web/src/components/toolRenderers/registry.js'
import {
  structuredGrepRenderer,
  structuredGlobRenderer,
} from '../../../src/web/src/components/toolRenderers/search.js'
import { grepRenderer } from '../../../src/web/src/components/toolRenderers/grep.js'
import { globRenderer } from '../../../src/web/src/components/toolRenderers/glob.js'

/**
 * 模拟 zai UI ToolCallBlock 调用 renderer 的完整路径:
 *   const renderer = getRenderer(msg.name)
 *   if (renderer.renderFull) {
 *     return <>{renderer.renderFull(msg)}</>
 *   }
 *
 * 返回完整 HTML 让 vitest 断言.
 */
function simulateToolCallBlockRender(msg: Record<string, unknown>): string {
  const rawName = ((msg.name as string | undefined) ?? '').trim()
  const renderer = getRenderer(rawName)
  if (renderer.renderFull) {
    return renderToStaticMarkup(React.createElement('div', null, renderer.renderFull(msg as never)))
  }
  // fallback 路径: input + output 渲染 (旧 grepRenderer 等用此路径)
  const html = []
  if (renderer.renderInput && msg.input) {
    html.push(renderToStaticMarkup(React.createElement('div', null, renderer.renderInput(msg.input as Record<string, unknown>))))
  }
  if (renderer.renderOutput && msg.output !== undefined) {
    // 严格 2 参: 与所有 11 个旧 renderer (bash / read / edit / grep / glob 等)
    // 签名一致. 不传 msg, 因为 renderOutput 不需要 AgentMessage 上下文.
    html.push(renderToStaticMarkup(React.createElement('div', null, renderer.renderOutput(msg.output, false))))
  }
  return html.join('')
}

const realGrepMeta = {
  shape: 'matches' as const,
  files: [
    { path: 'src/alpha.test.ts', matches: [
      { lineNumber: 4, line: "describe('alpha', () => {" },
    ]},
    { path: 'src/beta.test.ts', matches: [
      { lineNumber: 4, line: "describe('beta', () => {" },
    ]},
  ],
  truncated: false,
  total: 2,
}

describe('UI routing — tool name → renderer', () => {
  describe('harness tool-fs-search (小写 grep/glob, Phase 4 P1 引入)', () => {
    it('grep → structuredGrepRenderer (renderFull 接管)', () => {
      expect(getRenderer('grep')).toBe(structuredGrepRenderer)
      expect(getRenderer('grep').renderFull).toBeDefined()
    })

    it('glob → structuredGlobRenderer (renderFull 接管)', () => {
      expect(getRenderer('glob')).toBe(structuredGlobRenderer)
      expect(getRenderer('glob').renderFull).toBeDefined()
    })

    it('完整 UI 渲染 grep call → 输出 antd Card 列表 + 摘要 + 行内容', () => {
      const html = simulateToolCallBlockRender({
        type: 'tool_use:done',
        name: 'grep',
        toolUseId: 't1',
        input: { pattern: 'describe', path: '/repo/src' },
        output: 'unused',
        meta: realGrepMeta,
      })
      // 摘要
      expect(html).toContain('Found 2 matches in 2 files')
      // antd Card
      expect(html).toContain('grep-match-card')
      // 行号 + 行内容
      expect(html).toContain('>4</span>')
      expect(html).toContain('describe')
      // 高亮
      expect(html).toContain('<mark')
      // 行为按钮
      expect(html).toContain('预览')
      expect(html).toContain('打开目录')
    })
  })

  describe('向后兼容 — 旧工具名', () => {
    it('Grep (opencc-cli) → grepRenderer (文本路径)', () => {
      expect(getRenderer('Grep')).toBe(grepRenderer)
    })

    it('Glob (opencc-cli) → globRenderer (文本路径)', () => {
      expect(getRenderer('Glob')).toBe(globRenderer)
    })

    it('Ripgrep (旧 dsh-bridge 手写) → grepRenderer (文本路径)', () => {
      expect(getRenderer('Ripgrep')).toBe(grepRenderer)
    })
  })

  describe('防御 — meta 缺失时降级到 renderOutput 文本路径', () => {
    it('grep + 无 meta → 走 fallback 文本 (与 grepRenderer 一致)', () => {
      const html = simulateToolCallBlockRender({
        type: 'tool_use:done',
        name: 'grep',
        toolUseId: 't2',
        input: { pattern: 'foo', path: '/repo' },
        output: 'src/a.ts:10:foo',
      })
      expect(html).toContain('Grep')
      expect(html).toContain('foo')
      expect(html).toContain('src/a.ts:10:foo')
    })
  })
})