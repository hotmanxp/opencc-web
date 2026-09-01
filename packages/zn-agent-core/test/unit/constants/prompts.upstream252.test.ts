import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join as pathJoin } from 'path'

// opencc-web's vitest config deliberately excludes src/opencc-src/**
// (the vendored opencc source) from being imported at runtime — calling
// getSystemPrompt pulls in BashTool which depends on bun:bundle globals
// (`getMaxTimeoutMs is not a function`). Match opencc-web's existing
// promptNote test style by reading the source file directly and asserting
// the required string literals are present, instead of executing the
// getSystemPrompt path.

const PROMPTS_TS = pathJoin(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'opencc-src',
  'constants',
  'prompts.ts',
)
const src = readFileSync(PROMPTS_TS, 'utf8')

describe('upstream 2.1.252 sync — gate-free dynamic sections (source string presence)', () => {
  it('registers act_dont_rederive', () => {
    expect(src).toContain("systemPromptSection('act_dont_rederive'")
    expect(src).toContain(
      'When you have enough information to act, act.',
    )
    expect(src).toContain(
      'narrate options you will not pursue',
    )
  })

  it('registers delivering_work_max', () => {
    expect(src).toContain("systemPromptSection('delivering_work_max'")
    expect(src).toContain('# Delivering work')
    expect(src).toContain(
      "Finish the whole task, not just easy parts",
    )
  })

  it('registers overcorrection', () => {
    expect(src).toContain("systemPromptSection('overcorrection'")
    expect(src).toContain('# Corrections')
    expect(src).toContain(
      "Avoid unnecessary or excessive self-correction",
    )
  })

  it('registers subagent_steer_delegation gated on Agent tool + fork mode', () => {
    expect(src).toContain("systemPromptSection('subagent_steer_delegation'")
    expect(src).toContain('enabledTools.has(AGENT_TOOL_NAME)')
    expect(src).toContain('isForkSubagentEnabled()')
    expect(src).toContain('## Delegating to subagents')
    expect(src).toContain(
      'Subagents multiply cost and time',
    )
  })

  it('registers autonomy_append gated on getIsNonInteractiveSession()', () => {
    expect(src).toContain("systemPromptSection('autonomy_append'")
    expect(src).toContain('getIsNonInteractiveSession()')
    expect(src).toContain('You are operating autonomously')
    expect(src).toContain(
      'check your last paragraph',
    )
  })
})

describe('upstream 2.1.252 sync — Intro wIt() three-state', () => {
  it('Intro uses CLAUDE_CODE_INTRO_FRAME env as third state', () => {
    expect(src).toContain('process.env.CLAUDE_CODE_INTRO_FRAME')
    expect(src).toContain(
      'working with the user toward their goals, using your own judgment along the way',
    )
  })

  it('Intro still has the default "with software engineering tasks" branch', () => {
    expect(src).toContain('with software engineering tasks.')
  })
})

describe('upstream 2.1.252 sync — Actions git-defensive clauses', () => {
  it('includes the stash-over-delete guidance', () => {
    expect(src).toContain(
      'prefer a reversible step (move it aside, rename it, or stash it)',
    )
  })

  it('includes git-status-before-discard guidance', () => {
    expect(src).toContain(
      'run \\`git status\\` before any command that could discard uncommitted work',
    )
  })

  it('includes the commit-audit clause', () => {
    expect(src).toContain(
      "review what's included (\\`git status\\` after a broad \\`git add\\`)",
    )
    expect(src).toContain(
      "double-check the file's contents before pushing",
    )
  })
})