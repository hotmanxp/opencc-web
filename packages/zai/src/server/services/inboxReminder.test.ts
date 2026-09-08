import { describe, it, expect, beforeEach } from 'vitest'
import { getSessionInbox, disposeSessionInbox, type InboxMessage } from './sessionInbox.js'
import {
  drainInboxReminder,
  renderInboxReminder,
  parseTaskNotification,
  renderParsedTaskNotification,
  type ParsedTaskNotification,
} from './inboxReminder.js'

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

  it('renders task-factory / notice as `- task-factory notice: <truncated content>`', () => {
    // 2026-09-06: task-factory bullets are truncated plain-text — content
    // currently emits <task-command>...</task-command> as a prompt-rebuild
    // signal (not LLM-facing structure), so we don't parse+rebuild it.
    const out = renderInboxReminder([
      msg({
        id: 'tf-1',
        content: '<task-command>rebuild dist</task-command>',
        source: { kind: 'task-factory', form: 'notice' },
      }),
    ])
    expect(out).toContain('- task-factory notice:')
    expect(out).toContain('rebuild dist')
    // task-factory still passes the body through (parser does not consume it)
    expect(out).toContain('<task-command>')
  })

  it('renders subagent / notice as a pure-ASCII structured bullet (no <task-notification>)', () => {
    // 2026-09-06: parse + rebuild. Inner <task-notification> XML is
    // extracted into structured fields, never re-emitted inside the
    // outer <system-reminder> block. Bullet is pure ASCII and follows
    // vendor `mailbox.ts:renderInboxMessage` spirit (backticked taskId,
    // metadata in parens, status + summary).
    const out = renderInboxReminder([
      msg({
        id: 'bg-1',
        content: [
          '<task-notification>',
          '<task-id>bg-123</task-id>',
          '<agent-type>verifier</agent-type>',
          '<description>lint check</description>',
          '<status>completed</status>',
          '<summary>Sub-agent "lint" completed</summary>',
          '</task-notification>',
        ].join('\n'),
        source: { kind: 'subagent', form: 'notice', agentType: 'verifier' },
      }),
    ])
    // No XML structure inside the bullet — the LLM sees pure ASCII.
    expect(out).not.toContain('<task-notification>')
    expect(out).not.toContain('</task-notification>')
    expect(out).not.toContain('<task-id>')
    // Structured fields appear as plain text:
    expect(out).toContain('`bg-123`')
    expect(out).toContain('verifier')
    expect(out).toContain('lint check')
    expect(out).toContain('completed')
    expect(out).toContain('Sub-agent "lint" completed')
    // Whole bullet body: pure ASCII — no `<` or `>` anywhere outside
    // the outer <system-reminder> wrapper.
    const body = out!.replace(/<\/?system-reminder>/g, '')
    expect(body).not.toMatch(/[<>]/)
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

  it('renders user / steer as a dedicated <user-steer> block (A+C fix)', () => {
    const out = renderInboxReminder([
      msg({
        id: 'steer-1',
        content: 'please check the new test',
        source: { kind: 'user', form: 'steer' },
      }),
    ])
    expect(out).toContain('<user-steer>')
    expect(out).toContain('</user-steer>')
    expect(out).toContain('address this message NOW')
    expect(out).toContain('please check the new test')
    // steer must NOT be diluted inside the generic system-events block
    expect(out).not.toContain('The following system events occurred')
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

  it('emits steer blocks first, then generic reminder bullets in lane order', () => {
    const out = renderInboxReminder([
      msg({ id: 'a', content: 'A', source: { kind: 'subagent', form: 'notice' } }),
      msg({ id: 'b', content: 'B', source: { kind: 'task-factory', form: 'notice' } }),
      msg({ id: 'c', content: 'C', source: { kind: 'user', form: 'steer' } }),
    ])
    // steer (c) leads as a dedicated block
    const idxC = out!.indexOf('<user-steer>')
    const idxA = out!.indexOf('subagent notice')
    const idxB = out!.indexOf('task-factory notice')
    expect(idxC).toBeGreaterThan(-1)
    expect(idxA).toBeGreaterThan(idxC)
    expect(idxB).toBeGreaterThan(idxA)
  })

  it('falls back to truncated plain text when subagent content is not a task-notification shape', () => {
    // 2026-09-06: parse failure (missing <task-notification> wrapper)
    // routes to a truncated plain-text fallback — bounds reminder length
    // and keeps the bullet readable.
    const longText = 'x'.repeat(500)
    const out = renderInboxReminder([
      msg({
        id: 'bg-bad',
        content: longText,
        source: { kind: 'subagent', form: 'notice' },
      }),
    ])
    expect(out).toContain('- subagent notice:')
    expect(out).toContain('...')
    // 200 char cap + '...' — verify truncation actually kicks in.
    expect(out!.length).toBeLessThan(400)
  })

  it('decodes XML entities in task-notification field values', () => {
    // 2026-09-06: subagent notifier escapes values via escapeXml to keep
    // them from prematurely closing the outer structure; the parser
    // decodes them so the bullet is human-readable.
    const out = renderInboxReminder([
      msg({
        id: 'bg-entity',
        content: [
          '<task-notification>',
          '<task-id>bg-1</task-id>',
          '<status>completed</status>',
          '<summary>Sub-agent &quot;A&amp;B&quot; completed</summary>',
          '<result>&lt;ok&gt; done</result>',
          '</task-notification>',
        ].join('\n'),
        source: { kind: 'subagent', form: 'notice' },
      }),
    ])
    // summary decodes back: `&quot;` → `"`, `&amp;` → `&`
    expect(out).toContain('Sub-agent "A&B" completed')
    // The result field is NOT rendered in the bullet (it's long and
    // only used when the model calls TaskOutput), but the summary we DO
    // render must not contain any residual entity references.
    const body = out!.replace(/<\/?system-reminder>/g, '')
    expect(body).not.toMatch(/&lt;|&gt;|&amp;|&quot;|&#39;|&apos;/)
  })
})

describe('parseTaskNotification', () => {
  it('returns null when no <task-notification> wrapper is present', () => {
    expect(parseTaskNotification('just a string')).toBeNull()
    expect(parseTaskNotification('<other>x</other>')).toBeNull()
  })

  it('extracts taskId/status/summary as the canonical fields', () => {
    const parsed = parseTaskNotification(
      [
        '<task-notification>',
        '<task-id>bg-abc</task-id>',
        '<status>completed</status>',
        '<summary>done</summary>',
        '</task-notification>',
      ].join('\n'),
    )
    expect(parsed).not.toBeNull()
    expect(parsed!.taskId).toBe('bg-abc')
    expect(parsed!.status).toBe('completed')
    expect(parsed!.summary).toBe('done')
  })

  it('extracts optional description/agent-type/result fields when present', () => {
    const parsed = parseTaskNotification(
      [
        '<task-notification>',
        '<task-id>bg-1</task-id>',
        '<agent-type>verifier</agent-type>',
        '<description>lint</description>',
        '<status>completed</status>',
        '<summary>ok</summary>',
        '<result>final output</result>',
        '</task-notification>',
      ].join('\n'),
    )
    expect(parsed!.agentType).toBe('verifier')
    expect(parsed!.description).toBe('lint')
    expect(parsed!.result).toBe('final output')
  })

  it('returns null when any canonical field is missing', () => {
    // missing summary
    expect(
      parseTaskNotification(
        '<task-notification><task-id>x</task-id><status>completed</status></task-notification>',
      ),
    ).toBeNull()
    // missing task-id
    expect(
      parseTaskNotification(
        '<task-notification><status>completed</status><summary>ok</summary></task-notification>',
      ),
    ).toBeNull()
  })

  it('decodes XML entities in extracted field values', () => {
    const parsed = parseTaskNotification(
      [
        '<task-notification>',
        '<task-id>bg-1</task-id>',
        '<status>completed</status>',
        '<summary>A &amp; B &lt;ok&gt;</summary>',
        '</task-notification>',
      ].join('\n'),
    )
    expect(parsed!.summary).toBe('A & B <ok>')
  })
})

describe('renderParsedTaskNotification', () => {
  it('emits a pure-ASCII bullet with backticked taskId and metadata', () => {
    const p: ParsedTaskNotification = {
      taskId: 'bg-123',
      agentType: 'verifier',
      description: 'lint check',
      status: 'completed',
      summary: 'Sub-agent "lint" completed',
    }
    const line = renderParsedTaskNotification(p)
    expect(line).toContain('`bg-123`')
    expect(line).toContain('verifier, lint check')
    expect(line).toContain('completed')
    expect(line).toContain('Sub-agent "lint" completed')
    // Pure ASCII — no `<` or `>`.
    expect(line).not.toMatch(/[<>]/)
  })

  it('omits metadata parens when both agentType and description are absent', () => {
    const p: ParsedTaskNotification = {
      taskId: 'bg-x',
      status: 'completed',
      summary: 'ok',
    }
    const line = renderParsedTaskNotification(p)
    expect(line).toBe('- subagent `bg-x` - completed: ok')
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
