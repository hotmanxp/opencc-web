import { describe, test, expect } from 'bun:test'
import { renderGeneratePrompt } from '../prompts/generate.js'

describe('renderGeneratePrompt', () => {
  test('renders the full prompt with context', async () => {
    const text = await renderGeneratePrompt({
      cwd: '/p',
      root: '/p/.agent_working_dir/handoff',
      today: '2026-06-07',
      messageCount: 12,
      taskList: [
        {
          id: '1',
          type: 'local_bash',
          status: 'completed',
          description: 'Setup foo',
        },
        {
          id: '2',
          type: 'local_bash',
          status: 'pending',
          description: 'Run bar',
        },
      ],
    })
    expect(text).toContain(
      '# Task: Generate a handoff document for the current session',
    )
    expect(text).toContain('cwd: `/p`')
    expect(text).toContain('messageCount: `12`')
    expect(text).toContain('[completed] #1 local_bash Setup foo')
    expect(text).toContain('[pending] #2 local_bash Run bar')
    expect(text).toContain(
      '<project>/.agent_working_dir/handoff/<task>-2026-06-07.md',
    )
    expect(text).toContain('## Document structure')
    expect(text).toContain('1. **# Task title**')
    expect(text).toContain('8. **## Next Steps**')
    expect(text).toContain('9. **## Skills Used**')
  })

  test('renders empty TaskList when none exist', async () => {
    const text = await renderGeneratePrompt({
      cwd: '/p',
      root: '/p/.agent_working_dir/handoff',
      today: '2026-06-07',
      messageCount: 4,
      taskList: [],
    })
    expect(text).toContain('current TaskList:')
    expect(text).toContain('(empty)')
  })

  test('Skills Used section tells LLM to decide which to include', async () => {
    const text = await renderGeneratePrompt({
      cwd: '/p',
      root: '/p/.agent_working_dir/handoff',
      today: '2026-06-07',
      messageCount: 4,
      taskList: [],
    })
    expect(text).toContain('## Skills Used')
    expect(text).toContain('review the conversation')
    expect(text).toContain('Skip this section entirely')
  })

  test('final user-facing message section requires path confirmation', async () => {
    const text = await renderGeneratePrompt({
      cwd: '/p',
      root: '/p/.agent_working_dir/handoff',
      today: '2026-06-07',
      messageCount: 4,
      taskList: [],
    })
    expect(text).toContain('## Final user-facing message (REQUIRED)')
    expect(text).toContain('✅ Handoff document written:')
    expect(text).toContain('<relative-path>')
    // Strong language: must not be skipped
    expect(text).toMatch(/Do\s+\*\*not\*\*\s+skip this step/)
  })
})
