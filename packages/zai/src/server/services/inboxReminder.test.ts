import { describe, it, expect, beforeEach } from 'vitest'
import { getSessionInbox, disposeSessionInbox, type InboxMessage } from './sessionInbox.js'
import { drainInboxReminder, renderInboxReminder } from './inboxReminder.js'

function msg(overrides: Partial<InboxMessage> & Pick<InboxMessage, 'id' | 'content'>): InboxMessage {
  return {
    id: overrides.id,
    content: overrides.content,
    source: overrides.source ?? { kind: 'test', form: 'notice' },
    createdAt: overrides.createdAt ?? 1,
  }
}

describe('renderInboxReminder', () => {
  it('returns null for an empty array', () => {
    expect(renderInboxReminder([])).toBeNull()
  })

  it('wraps bullets in a <system-reminder> block with the standard header', () => {
    const out = renderInboxReminder([msg({ id: 'a', content: 'hello' })])
    expect(out).not.toBeNull()
    expect(out).toContain('<system-reminder>')
    expect(out).toContain('</system-reminder>')
    expect(out).toContain('The following system events occurred since your last turn.')
  })

  it('renders task-factory / notice as `- task-factory notice: <content>`', () => {
    const out = renderInboxReminder([
      msg({
        id: 'tf-1',
        content: '<task-command>rebuild dist</task-command>',
        source: { kind: 'task-factory', form: 'notice' },
      }),
    ])
    expect(out).toContain('- task-factory notice:')
    expect(out).toContain('<task-command>')
  })

  it('renders subagent / notice with agentType label when present', () => {
    const out = renderInboxReminder([
      msg({
        id: 'bg-1',
        content: '<task-notification>completed</task-notification>',
        source: { kind: 'subagent', form: 'notice', agentType: 'verifier' },
      }),
    ])
    expect(out).toContain('- subagent notice (agentType=verifier):')
    expect(out).toContain('<task-notification>')
  })

  it('renders subagent / notice without agentType as plain label', () => {
    const out = renderInboxReminder([
      msg({
        id: 'bg-2',
        content: 'x',
        source: { kind: 'subagent', form: 'notice' },
      }),
    ])
    expect(out).toContain('- subagent notice:')
    expect(out).not.toContain('agentType=')
  })

  it('renders user / steer as follow-up from user', () => {
    const out = renderInboxReminder([
      msg({
        id: 'steer-1',
        content: 'please check the new test',
        source: { kind: 'user', form: 'steer' },
      }),
    ])
    expect(out).toContain('- follow-up from user:')
    expect(out).toContain('please check the new test')
  })

  it('falls back to `kind / form` label for unknown sources', () => {
    const out = renderInboxReminder([
      msg({
        id: 'x',
        content: 'whatever',
        source: { kind: 'mystery', form: 'puzzle' },
      }),
    ])
    expect(out).toContain('- mystery / puzzle:')
  })

  it('emits bullets in lane order, joined by newlines', () => {
    const out = renderInboxReminder([
      msg({ id: 'a', content: 'A', source: { kind: 'subagent', form: 'notice' } }),
      msg({ id: 'b', content: 'B', source: { kind: 'task-factory', form: 'notice' } }),
      msg({ id: 'c', content: 'C', source: { kind: 'user', form: 'steer' } }),
    ])
    const idxA = out!.indexOf('subagent notice')
    const idxB = out!.indexOf('task-factory notice')
    const idxC = out!.indexOf('follow-up from user')
    expect(idxA).toBeGreaterThan(-1)
    expect(idxB).toBeGreaterThan(idxA)
    expect(idxC).toBeGreaterThan(idxB)
  })

  it('passes XML content through verbatim (no escaping) so the LLM can parse it', () => {
    // task-factory and subagent sources emit XML blocks (e.g. <task-command>);
    // escaping would mangle their intent. The renderer is deliberately a
    // pass-through; callers are responsible for their own content shape.
    const out = renderInboxReminder([
      msg({
        id: 'r',
        content: '<script>&"hi"</script>',
        source: { kind: 'user', form: 'steer' },
      }),
    ])
    expect(out).toContain('<script>&"hi"</script>')
    expect(out).not.toContain('&lt;')
  })
})

describe('drainInboxReminder', () => {
  beforeEach(() => {
    // Drop any leftover per-session inbox so each test starts fresh.
    disposeSessionInbox('s1')
  })

  it('returns null when the nextStep lane is empty', () => {
    expect(drainInboxReminder('s1')).toBeNull()
  })

  it('returns a reminder when nextStep has messages, then null on second call', () => {
    getSessionInbox('s1').inject('s1', msg({ id: 'a', content: 'first' }))
    const first = drainInboxReminder('s1')
    expect(first).not.toBeNull()
    expect(first).toContain('first')
    const second = drainInboxReminder('s1')
    expect(second).toBeNull()
  })

  it('drains ALL pending nextStep messages in a single call', () => {
    const inbox = getSessionInbox('s1')
    inbox.inject('s1', msg({ id: 'a', content: 'A' }))
    inbox.inject('s1', msg({ id: 'b', content: 'B' }))
    const out = drainInboxReminder('s1')
    expect(out).not.toBeNull()
    expect(out!.match(/^- /gm)).toHaveLength(2)
    expect(drainInboxReminder('s1')).toBeNull()
  })

  it('isolates per-session state — other sessions see empty lane', () => {
    const s1 = getSessionInbox('s1')
    const s2 = getSessionInbox('s2')
    s1.inject('s1', msg({ id: 'a', content: 'only-s1' }))
    const s1Reminder = drainInboxReminder('s1')
    expect(s1Reminder).toContain('only-s1')
    // s2's lane is independent — must NOT include s1's message.
    expect(drainInboxReminder('s2')).toBeNull()
    // cleanup so other tests / next runs don't see s2 leftover
    disposeSessionInbox('s2')
  })
})
