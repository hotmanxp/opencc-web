import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, 'verify-web-aria-labels.mjs')

function runAudit(target) {
  try {
    const out = execFileSync('node', [SCRIPT, target], {
      cwd: resolve(__dirname, '..'),
      encoding: 'utf8',
    })
    return { code: 0, stdout: out }
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout?.toString() ?? '' }
  }
}

describe('verify-web-aria-labels', () => {
  it('fixture-pass.tsx 全豁免 → 退出码 0', () => {
    const r = runAudit('fixtures/aria-label/fixture-pass.tsx')
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/scanned/)
  })

  it('fixture-fail.tsx 含违规 → 退出码 1 + 行号输出', () => {
    const r = runAudit('fixtures/aria-label/fixture-fail.tsx')
    expect(r.code).toBe(1)
    expect(r.stdout).toMatch(/fixture-fail\.tsx:\d+ <Button>/)
    expect(r.stdout).toMatch(/fixture-fail\.tsx:\d+ <input>/)
    expect(r.stdout).toMatch(/fixture-fail\.tsx:\d+ <Switch>/)
    expect(r.stdout).toMatch(/fixture-fail\.tsx:\d+ <Select>/)
  })

  it('fixture-mixed.tsx 仅报违规行', () => {
    const r = runAudit('fixtures/aria-label/fixture-mixed.tsx')
    expect(r.code).toBe(1)
    const lines = r.stdout.split('\n').filter((l) => l.startsWith('✗'))
    expect(lines.length).toBe(1)
    expect(lines[0]).toMatch(/<Button>/)
  })

  it('fixture-form-item.tsx Form.Item 包裹 input/select/textarea → exit 0 (regression guard for 豁免 4)', () => {
    // Spec 豁免条件 ②: <Form.Item label="..."> 包裹的 input/select/textarea
    // 必须被识别为合规。修复前 Form 不在白名单,豁免 4 分支不可达,
    // 全部 Form.Item 被误报 — 故此条测试作为 regression guard 必加。
    const r = runAudit('fixtures/aria-label/fixture-form-item.tsx')
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/scanned/)
  })
})