import { describe, expect, test } from 'bun:test'
import {
  createAttachmentMessage,
  type Attachment,
} from './attachments.ts'

/**
 * The `createAttachmentMessage(attachment: Attachment)` factory returns a
 * Message-shaped object `{type: 'attachment', attachment, uuid, timestamp}`
 * even though the declared return type is `AttachmentMessage` (the
 * file-attachment shape in src/types/message.ts). This is a pre-existing
 * type lie in attachments.ts:3234. We cast through `unknown` to access the
 * real runtime shape without fixing that pre-existing bug as part of the
 * goal_status port.
 */
type GoalStatusMessage = {
  type: 'attachment'
  attachment: Attachment & { type: 'goal_status' }
  uuid: string
  timestamp: string
}

function asGoalStatus(m: unknown): GoalStatusMessage {
  return m as unknown as GoalStatusMessage
}

describe('Attachment — goal_status (transcript restore, v2)', () => {
  test('createAttachmentMessage accepts state="set" with condition only', () => {
    // what /goal X writes — the very first state-change sentinel
    const msg = asGoalStatus(
      createAttachmentMessage({
        type: 'goal_status',
        state: 'set',
        condition: 'finish tests',
        timestamp: 1700000000000,
        iterations: 0,
      }),
    )
    expect(msg.attachment.type).toBe('goal_status')
    expect(msg.attachment.state).toBe('set')
    expect(msg.attachment.condition).toBe('finish tests')
    expect(msg.attachment.iterations).toBe(0)
  })

  test('createAttachmentMessage accepts state="bump" with iterations', () => {
    // what bumpGoalIteration writes after each Stop-hook failure
    const msg = asGoalStatus(
      createAttachmentMessage({
        type: 'goal_status',
        state: 'bump',
        condition: 'finish tests',
        timestamp: 1700000000000,
        iterations: 3,
      }),
    )
    expect(msg.attachment.state).toBe('bump')
    expect(msg.attachment.iterations).toBe(3)
  })

  test('createAttachmentMessage accepts state="achieve" with tokensAtEnd', () => {
    // what markGoalAchieved writes when Stop-hook LLM returns ok:true
    const msg = asGoalStatus(
      createAttachmentMessage({
        type: 'goal_status',
        state: 'achieve',
        condition: 'finish tests',
        timestamp: 1700000000000,
        iterations: 3,
        tokens: 4200,
      }),
    )
    expect(msg.attachment.state).toBe('achieve')
    expect(msg.attachment.tokens).toBe(4200)
  })

  test('createAttachmentMessage accepts state="clear"', () => {
    // what /goal clear writes — user explicitly cleared, no resume
    const msg = asGoalStatus(
      createAttachmentMessage({
        type: 'goal_status',
        state: 'clear',
        condition: 'finish tests',
        timestamp: 1700000000000,
      }),
    )
    expect(msg.attachment.state).toBe('clear')
  })

  test('the four states are mutually exclusive in the discriminated union', () => {
    const a: Attachment = {
      type: 'goal_status',
      state: 'set',
      condition: 'A',
    }
    const b: Attachment = {
      type: 'goal_status',
      state: 'achieve',
      condition: 'A',
    }
    expect(a.state).toBe('set')
    expect(b.state).toBe('achieve')
  })
})
