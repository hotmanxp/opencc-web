import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, test } from 'bun:test'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages'
import type { PromptCommand } from '../../types/command.js'
import { workflowFileToCommand } from './workflowCommand.js'

async function getPromptText(
  cmd: PromptCommand,
  args: string,
): Promise<string> {
  const blocks = (await cmd.getPromptForCommand(
    args,
    {} as PromptCommand['getPromptForCommand'] extends (
      a: string,
      c: infer C,
    ) => unknown
      ? C
      : never,
  )) as ContentBlockParam[]
  return blocks
    .map((b): string => (b.type === 'text' ? b.text : ''))
    .join('\n')
}

describe('workflowFileToCommand', () => {
  test('derives name from filename without .js extension', () => {
    const cmd = workflowFileToCommand(
      '/home/user/.claude/workflows/deep-research.js',
      'user',
    )
    expect(cmd.name).toBe('deep-research')
  })

  test('description mentions the source (project)', () => {
    const cmd = workflowFileToCommand(
      '/repo/.claude/workflows/code-review.js',
      'project',
    )
    expect(cmd.description).toContain('project')
    expect(cmd.description).toContain('code-review')
  })

  test('description mentions the source (user)', () => {
    const cmd = workflowFileToCommand(
      '/home/user/.claude/workflows/auto-format.js',
      'user',
    )
    expect(cmd.description).toContain('user')
    expect(cmd.description).toContain('auto-format')
  })

  test('command is not hidden', () => {
    const cmd = workflowFileToCommand('/some/path/foo.js', 'project')
    expect(cmd.isHidden).toBe(false)
  })

  test('returns a prompt-type command', () => {
    const cmd = workflowFileToCommand('/some/path/bar.js', 'user')
    expect(cmd.type).toBe('prompt')
  })

  // The prompt's job:
  //   1. Show the user's natural-language description separately
  //      (informational — NOT the args).
  //   2. Tell the LLM that `args` MUST be a CLI-format string
  //      (`--key=value --flag`), and the runtime parser drops
  //      positional/non-flag text.
  //   3. Tell the LLM to read the workflow script to figure out
  //      which `--key` flags it accepts.
  //   4. Render the callShape with a CLI-format FORMAT example,
  //      not the raw user input — so the LLM pattern-matches on
  //      the right shape instead of copy-pasting raw prose
  //      (which the parser would silently drop → args = {}).
  test('separates user description from CLI args, shows CLI-format example in callShape', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-cmd-'))
    const scriptPath = join(dir, 'detect-project-version.js')
    writeFileSync(
      scriptPath,
      'export const meta = { name: "x" }\nreturn "ok"',
    )

    const cmd = workflowFileToCommand(scriptPath, 'user') as PromptCommand
    // Test with the exact form the user has been using: Chinese 对
    // prefix + unexpanded ~ + free-form path. The prompt must show
    // it as the user's description (not silently normalize/expand).
    const text = await getPromptText(
      cmd,
      '对~/code/hermes-agent',
    )

    // Header.
    expect(text).toContain('Run the "detect-project-version" workflow.')
    // Script path is surfaced (so LLM can Read it).
    expect(text).toContain(scriptPath)

    // User description is shown VERBATIM as informational — NOT
    // pre-processed, NOT stripped, NOT expanded.
    expect(text).toContain("User's description (natural language")
    expect(text).toContain('对~/code/hermes-agent')
    // It is clearly NOT the args.
    expect(text).toContain('NOT the args')

    // The callShape uses a CLI-format FORMAT example, NOT the
    // raw user input. This is the bug-fix assertion: previously
    // the callShape put `args: "对~/code/hermes-agent"` which
    // would cause the LLM to copy-paste raw prose, and the
    // runtime parser would drop it.
    expect(text).toContain('Invoke: Workflow(')
    expect(text).toContain('workflowName: "detect-project-version"')
    expect(text).not.toContain('args: "对~/code/hermes-agent"')
    expect(text).toContain('--key=value')
    // description is a placeholder for the LLM to fill.
    expect(text).toContain('description:')

    // The prompt explicitly explains the CLI-format contract
    // without leaking OpenCC internal file paths (the contract is
    // already in the WorkflowTool tool schema description).
    expect(text).toContain('CLI format')
    expect(text).not.toContain('cliArgs.ts')
    // STEP 1 (REQUIRED — DO THIS FIRST) forces the LLM to read the
    // script before constructing args. Without reading the script
    // the LLM cannot know which `--key` flags the workflow accepts.
    expect(text).toContain('STEP 1 (REQUIRED')
    expect(text).toContain('DO THIS FIRST')
    expect(text).toContain('Read the workflow script at')
    expect(text).toContain('BEFORE constructing')
    // STEP 2 then guides CLI-format construction.
    expect(text).toContain('STEP 2:')
    expect(text).toContain('--key=value')
  })

  test('callShape is identical whether user provided a description or not (script decides args need)', async () => {
    // Whether the workflow script needs args depends on the SCRIPT,
    // not on whether the user typed something after `/<name> `.
    // The prompt must show the same callShape in both cases so the
    // LLM learns to decide args from the script, not from `r`.
    const dir = mkdtempSync(join(tmpdir(), 'wf-cmd-empty-'))
    const scriptPath = join(dir, 'demo.js')
    writeFileSync(
      scriptPath,
      'export const meta = { name: "demo" }\nreturn "ok"',
    )

    const cmd = workflowFileToCommand(scriptPath, 'user') as PromptCommand
    const text = await getPromptText(cmd, '')

    // The "no description" hint is informational — it tells the LLM
    // the user gave no explicit intent. But the callShape must NOT
    // change to `args: ""` just because the user was silent: the
    // LLM still has to look at the script to decide.
    expect(text).toContain('(no description provided')
    expect(text).toContain('--<key>=<value>')
    // callShape stays the same — no `args: ""` shortcut.
    expect(text).not.toContain('args: ""')
  })
})
