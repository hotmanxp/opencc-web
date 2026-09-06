/**
 * tf-edl5iwd5 — executor prompt hardening regression.
 *
 * The supervisor system prompt is a string-array literal in
 * `mainAgents-taskFactory.ts` that gets bundled verbatim into
 * `dist/opencc-core.mjs` by `pnpm run build:core`. This test reads the source
 * file and string-asserts that the three required prompt blocks (LOCATE →
 * MODIFY → VERIFY template, retry-context.md write instruction, and the
 * `=== RETRY CONTEXT ===` injection marker) are all present, AND that the
 * quick-mode ego-browser ban is present. Pure string assertion — no LLM, no
 * prompt assembly runtime.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SOURCE_PATH = resolve(
  HERE,
  '..',
  '..',
  '..',
  'src',
  'opencc-src',
  'server',
  'mainAgents-taskFactory.ts',
)

const source = readFileSync(SOURCE_PATH, 'utf8')

describe('task-factory supervisor prompt (tf-edl5iwd5 hardening)', () => {
  it('contains the === LOCATE → MODIFY → VERIFY === three-step template marker', () => {
    // AC1: hard three-step header, plus the closing marker and STEP n anchor lines.
    expect(source).toContain('=== LOCATE → MODIFY → VERIFY ===')
    expect(source).toContain('=== END THREE-STEP TEMPLATE ===')
    expect(source).toMatch(/STEP 1 \(Locate\)/)
    expect(source).toMatch(/STEP 2 \(Modify\)/)
    expect(source).toMatch(/STEP 3 \(Verify\)/)
  })

  it('contains the === RETRY CONTEXT === injection block (AC2)', () => {
    expect(source).toContain('=== RETRY CONTEXT ===')
    expect(source).toContain('=== RETRY CONTEXT (Round N → Round N+1) ===')
    expect(source).toContain('=== END RETRY CONTEXT ===')
  })

  it('contains the retry-context.md write instruction (AC2)', () => {
    // The exact path the supervisor must write before re-CliAgent.
    expect(source).toContain('<task_dir>/retry-context.md')
    expect(source).toContain('Write `<task_dir>/retry-context.md`')
    // The four required section headings in order.
    expect(source).toContain('## Round N 失败摘要')
    expect(source).toContain('## 上一轮已尝试改动')
    expect(source).toContain('## 上一轮 stdout 关键片段')
    expect(source).toContain('## 下一轮禁止重复的动作清单')
    // git show --stat must be invoked for each previous commit.
    expect(source).toContain('git show --stat')
  })

  it('contains the quick-mode ego-browser ban (AC3)', () => {
    expect(source).toContain('quick mode: NEVER invoke /ego-browser')
  })

  it('contains the dev-server screenshot ban (AC3)', () => {
    expect(source).toContain('do NOT launch `pnpm dev` to take screenshots')
  })

  it('declares verification.md as the ONLY retry feedback source (AC3)', () => {
    // <task_dir>/docs/verification.md must be flagged as the only signal
    // for retry rounds so the executor does not chase its own stdout.
    expect(source).toMatch(/<task_dir>\/docs\/verification\.md is the ONLY[\s\S]*feedback source/i)
  })

  it('does not regress pre-existing supervisor instructions', () => {
    // Sanity check that the original bullets are still present (AC6: only
    // ADD / ENHANCE, never delete).
    expect(source).toContain('You are the supervisor Agent of the "Task Factory".')
    expect(source).toContain('SuperTasksCreate')
    expect(source).toContain('SuperTasksMove')
    expect(source).toContain('FAIL, round < 3')
    expect(source).toContain('FAIL, round == 3')
  })
})
