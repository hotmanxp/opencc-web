/**
 * 微信消息访问策略(DM / group 双维度)。
 *
 * 4 种 DM policy:
 *   - open       任何人都可 DM(默认;若 GATEWAY_ALLOW_ALL_USERS / WEIXIN_ALLOW_ALL_USERS 显式开启)
 *   - allowlist  仅 senderId 在 allowFrom 列表内的可 DM
 *   - pairing    配对模式(首次扫码后接受所有 DM,后续 require 加入 allowlist)
 *   - disabled   拒收所有 DM
 *
 * 3 种 group policy:
 *   - open       任何群消息都接收
 *   - allowlist  仅 groupId 在 groupAllowFrom 列表内的可接收
 *   - disabled   拒收所有群消息(默认;iLink Bot 身份常常拿不到群事件)
 *
 * intake 与 response 区分:入站侧先 evaluate,agent 处理后返回时再 evaluate 一次,
 * 防止 prompt injection 副作用。
 */
export type DmPolicy = 'open' | 'allowlist' | 'pairing' | 'disabled'
export type GroupPolicy = 'open' | 'allowlist' | 'disabled'

export interface AccessPolicyInput {
  chatType: 'dm' | 'group'
  senderId: string
  chatId: string
  dmPolicy: DmPolicy
  groupPolicy: GroupPolicy
  allowFrom: string[]
  groupAllowFrom: string[]
  /** optional global kill switch: 若 GATEWAY_ALLOW_ALL_USERS / WEIXIN_ALLOW_ALL_USERS 启用,open 才放行 */
  globalAllowAll?: boolean
}

export interface AccessPolicyResult {
  allowed: boolean
  reason: string
}

export function evaluateAccessPolicy(input: AccessPolicyInput): AccessPolicyResult {
  if (input.chatType === 'group') {
    return evaluateGroup(input)
  }
  return evaluateDm(input)
}

function evaluateDm(input: AccessPolicyInput): AccessPolicyResult {
  switch (input.dmPolicy) {
    case 'disabled':
      return { allowed: false, reason: 'dm_policy=disabled' }
    case 'allowlist':
      return input.allowFrom.includes(input.senderId)
        ? { allowed: true, reason: 'dm_policy=allowlist hit' }
        : { allowed: false, reason: 'dm_policy=allowlist miss' }
    case 'pairing':
      // pairing 模式:首次扫码后接受所有 DM,无需 allowFrom 校验
      return { allowed: true, reason: 'dm_policy=pairing' }
    case 'open':
      return input.globalAllowAll
        ? { allowed: true, reason: 'dm_policy=open + global_allow_all' }
        : { allowed: false, reason: 'dm_policy=open but global_allow_all not set' }
    default:
      return { allowed: false, reason: `unknown dm_policy: ${input.dmPolicy}` }
  }
}

function evaluateGroup(input: AccessPolicyInput): AccessPolicyResult {
  switch (input.groupPolicy) {
    case 'disabled':
      return { allowed: false, reason: 'group_policy=disabled' }
    case 'allowlist':
      return input.groupAllowFrom.includes(input.chatId)
        ? { allowed: true, reason: 'group_policy=allowlist hit' }
        : { allowed: false, reason: 'group_policy=allowlist miss' }
    case 'open':
      return { allowed: true, reason: 'group_policy=open' }
    default:
      return { allowed: false, reason: `unknown group_policy: ${input.groupPolicy}` }
  }
}

/**
 * 从 iLink 消息推导 (chatType, chatId)。
 *   - dm:   chatId = senderId (单聊)
 *   - group: chatId = room_id || chat_room_id || to_user_id
 */
export function guessChatType(
  msg: { room_id?: string | null; chat_room_id?: string | null; to_user_id?: string | null; from_user_id?: string; msg_type?: number | null },
  accountId: string,
): { chatType: 'dm' | 'group'; chatId: string } {
  const roomId = (msg.room_id || msg.chat_room_id || '').trim()
  const toUserId = (msg.to_user_id || '').trim()
  const isGroup = !!roomId || (!!toUserId && accountId && toUserId !== accountId && msg.msg_type === 1)
  if (isGroup) {
    return { chatType: 'group', chatId: roomId || toUserId || msg.from_user_id || '' }
  }
  return { chatType: 'dm', chatId: msg.from_user_id || '' }
}
