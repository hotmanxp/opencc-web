import { describe, test, expect } from 'bun:test'
import {
  renderPickupPrompt,
  type HandoffEntry,
} from '../prompts/pickup.js'

function makeEntry(
  basename: string,
  mtime = '2026-06-07 14:30',
): HandoffEntry {
  return {
    basename,
    fullPath: `/p/.agent_working_dir/handoff/${basename}`,
    mtime,
  }
}

describe('renderPickupPrompt', () => {
  test('renders listing when handoffs are present, hints to surface top N', async () => {
    const text = await renderPickupPrompt({
      pickPath: null,
      pickContent: null,
      errorNote: null,
      cwd: '/p',
      root: '/p/.agent_working_dir/handoff',
      recent: [
        makeEntry('a-2026-06-07.md'),
        makeEntry('b-2026-06-06.md'),
        makeEntry('c-2026-06-05.md'),
      ],
      userOptionCount: 3,
    })
    expect(text).toContain('Recent handoff documents (newest first)')
    expect(text).toContain('a-2026-06-07.md')
    expect(text).toContain('top 3')
    expect(text).toContain('AskUserQuestion')
    expect(text).toContain('full path: `/p/.agent_working_dir/handoff/a-2026-06-07.md`')
    // The prompt now embeds an explicit AskUserQuestion JSON shape so the
    // LLM doesn't have to guess `header` / `options` / `multiSelect`.
    expect(text).toContain('"question": "Which handoff do you want to resume?"')
    expect(text).toContain('"header": "Resume"')
    expect(text).toContain('"multiSelect": false')
    expect(text).toContain('"label": "<basename>"')
    expect(text).toContain('"description": "<mtime>')
    expect(text).not.toContain('No handoff documents found')
  })

  test('does NOT include file content in the listing (just name + path)', async () => {
    const text = await renderPickupPrompt({
      pickPath: null,
      pickContent: null,
      errorNote: null,
      cwd: '/p',
      root: '/p/.agent_working_dir/handoff',
      recent: [makeEntry('a.md')],
      userOptionCount: 3,
    })
    // The handoff file body should NOT be inlined. We assert by checking
    // there's no fenced code block (the listing uses plain lines, not ```).
    expect(text).not.toContain('```markdown')
    // And the listing block doesn't include the "## Document structure"
    // header from the generate template.
    expect(text).not.toContain('Document structure (write in this order)')
  })

  test('tells LLM to surface only top N when more are present', async () => {
    const text = await renderPickupPrompt({
      pickPath: null,
      pickContent: null,
      errorNote: null,
      cwd: '/p',
      root: '/p/.agent_working_dir/handoff',
      recent: [
        makeEntry('a.md'),
        makeEntry('b.md'),
        makeEntry('c.md'),
        makeEntry('d.md'),
        makeEntry('e.md'),
      ],
      userOptionCount: 3,
    })
    // All 5 should be in the listing
    expect(text).toContain('a.md')
    expect(text).toContain('e.md')
    // But LLM should be told to show only 3 as options, and 2 are context-only
    expect(text).toContain('top 3')
    expect(text).toContain('other 2 entries')
    expect(text).toMatch(/NOT be shown as options/)
  })

  test('no "other N" message when recent.length === userOptionCount', async () => {
    const text = await renderPickupPrompt({
      pickPath: null,
      pickContent: null,
      errorNote: null,
      cwd: '/p',
      root: '/p/.agent_working_dir/handoff',
      recent: [makeEntry('a.md'), makeEntry('b.md')],
      userOptionCount: 2,
    })
    expect(text).not.toContain('other ')
    expect(text).not.toContain('NOT be shown as options')
  })

  test('single handoff uses plain-text ask (not AskUserQuestion) to avoid min-2 options', async () => {
    const text = await renderPickupPrompt({
      pickPath: null,
      pickContent: null,
      errorNote: null,
      cwd: '/p',
      root: '/p/.agent_working_dir/handoff',
      recent: [makeEntry('only.md')],
      userOptionCount: 3,
    })
    expect(text).toContain('Only one handoff found')
    expect(text).toContain('only.md')
    // Should explicitly tell the LLM NOT to use AskUserQuestion (min 2 options)
    expect(text).toMatch(/Do\s+\*\*not\*\*\s+use\s+AskUserQuestion/)
    expect(text).toMatch(/require.*at least 2/i)
  })

  test('empty recent renders the "no handoffs" block', async () => {
    const text = await renderPickupPrompt({
      pickPath: null,
      pickContent: null,
      errorNote: null,
      cwd: '/p',
      root: '/p/.agent_working_dir/handoff',
      recent: [],
      userOptionCount: 3,
    })
    expect(text).toContain('No handoff documents found')
    expect(text).toContain('/p/.agent_working_dir/handoff')
  })

  test('explicit --pick shows pre-read content + bypasses listing', async () => {
    const text = await renderPickupPrompt({
      pickPath: '/p/.agent_working_dir/handoff/foo.md',
      pickContent: '# Foo\n\nbody content',
      errorNote: null,
      cwd: '/p',
      root: '/p/.agent_working_dir/handoff',
      recent: [makeEntry('foo.md')],
      userOptionCount: 3,
    })
    expect(text).toContain('User explicitly selected')
    expect(text).toContain('foo.md')
    expect(text).toContain('# Foo')
    expect(text).toContain('body content')
  })

  test('warning + listing coexist when --pick is invalid but other files exist', async () => {
    const text = await renderPickupPrompt({
      pickPath: null,
      pickContent: null,
      errorNote: 'Specified file `nope.md` does not exist',
      cwd: '/p',
      root: '/p/.agent_working_dir/handoff',
      recent: [makeEntry('other.md')],
      userOptionCount: 3,
    })
    expect(text).toContain('Warning')
    expect(text).toContain('nope.md')
    expect(text).toContain('AskUserQuestion')
    expect(text).toContain('other.md') // also shows the other options
  })

  test('error block uses the current slash command name (regression for /handon rename)', async () => {
    const text = await renderPickupPrompt({
      pickPath: null,
      pickContent: null,
      errorNote: 'Directory `/p` is empty',
      cwd: '/p',
      root: '/p',
      recent: [],
      userOptionCount: 3,
    })
    expect(text).toContain('/handoff')
    expect(text).not.toContain('/handon')
  })

  test('resume flow includes re-activate skills step', async () => {
    const text = await renderPickupPrompt({
      pickPath: null,
      pickContent: null,
      errorNote: null,
      cwd: '/p',
      root: '/p/.agent_working_dir/handoff',
      recent: [makeEntry('foo.md', '2026-06-07 12:00')],
      userOptionCount: 3,
    })
    expect(text).toContain('Re-activate the previously useful skills')
    expect(text).toContain('Skills Used')
    expect(text).toContain('Skill** tool')
  })
})
