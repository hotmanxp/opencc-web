import { describe, it, expect } from 'vitest'
import { evaluateAccessPolicy, guessChatType } from '../../../src/server/services/weixinBot/accessPolicy.js'

describe('evaluateAccessPolicy — DM', () => {
  const base = {
    chatType: 'dm' as const,
    senderId: 'alice',
    chatId: 'alice',
    allowFrom: ['alice', 'bob'],
    groupAllowFrom: [],
  }

  it('open + globalAllowAll → allowed', () => {
    const r = evaluateAccessPolicy({ ...base, dmPolicy: 'open', groupPolicy: 'disabled', globalAllowAll: true })
    expect(r.allowed).toBe(true)
  })

  it('open without globalAllowAll → denied', () => {
    const r = evaluateAccessPolicy({ ...base, dmPolicy: 'open', groupPolicy: 'disabled' })
    expect(r.allowed).toBe(false)
    expect(r.reason).toMatch(/global_allow_all/)
  })

  it('allowlist hit → allowed', () => {
    const r = evaluateAccessPolicy({ ...base, dmPolicy: 'allowlist', groupPolicy: 'disabled' })
    expect(r.allowed).toBe(true)
  })

  it('allowlist miss → denied', () => {
    const r = evaluateAccessPolicy({
      ...base, senderId: 'eve', dmPolicy: 'allowlist', groupPolicy: 'disabled',
    })
    expect(r.allowed).toBe(false)
    expect(r.reason).toMatch(/allowlist miss/)
  })

  it('pairing → always allowed regardless allowFrom', () => {
    const r = evaluateAccessPolicy({
      ...base, senderId: 'stranger', dmPolicy: 'pairing', groupPolicy: 'disabled',
    })
    expect(r.allowed).toBe(true)
  })

  it('disabled → denied', () => {
    const r = evaluateAccessPolicy({ ...base, dmPolicy: 'disabled', groupPolicy: 'disabled' })
    expect(r.allowed).toBe(false)
  })
})

describe('evaluateAccessPolicy — group', () => {
  const groupBase = {
    chatType: 'group' as const,
    senderId: 'alice',
    chatId: 'room_42',
    allowFrom: [],
    groupAllowFrom: ['room_42', 'room_99'],
  }

  it('disabled → denied by default', () => {
    const r = evaluateAccessPolicy({ ...groupBase, dmPolicy: 'disabled', groupPolicy: 'disabled' })
    expect(r.allowed).toBe(false)
  })

  it('open → allowed', () => {
    const r = evaluateAccessPolicy({ ...groupBase, dmPolicy: 'disabled', groupPolicy: 'open' })
    expect(r.allowed).toBe(true)
  })

  it('allowlist hit (groupId in list) → allowed', () => {
    const r = evaluateAccessPolicy({ ...groupBase, dmPolicy: 'disabled', groupPolicy: 'allowlist' })
    expect(r.allowed).toBe(true)
  })

  it('allowlist miss → denied', () => {
    const r = evaluateAccessPolicy({
      ...groupBase, chatId: 'room_evil', dmPolicy: 'disabled', groupPolicy: 'allowlist',
    })
    expect(r.allowed).toBe(false)
  })
})

describe('guessChatType', () => {
  it('room_id indicates group', () => {
    const r = guessChatType({ room_id: 'room_42', from_user_id: 'alice' }, 'bot_x')
    expect(r.chatType).toBe('group')
    expect(r.chatId).toBe('room_42')
  })

  it('DM when no room_id and to_user_id is self', () => {
    const r = guessChatType({ from_user_id: 'alice', to_user_id: 'bot_x', msg_type: 1 }, 'bot_x')
    expect(r.chatType).toBe('dm')
    expect(r.chatId).toBe('alice')
  })

  it('group via to_user_id mismatch', () => {
    const r = guessChatType({ from_user_id: 'alice', to_user_id: 'group_x', msg_type: 1 }, 'bot_x')
    expect(r.chatType).toBe('group')
    expect(r.chatId).toBe('group_x')
  })
})
