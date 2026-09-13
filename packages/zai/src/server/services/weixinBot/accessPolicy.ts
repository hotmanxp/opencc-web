/**
 * 微信消息访问策略(DM / group 双维度)。
 *
 * 4 种 DM policy:
 *   - open       任何人都可 DM(默认;若 GATEWAY_ALLOW_ALL_USERS / WEIXIN_ALLOW_ALL_USERS 显式开启)
 *   - allowlist  仅 senderId 在 allowFrom ∪ dynamicDmAllowlist 内的可 DM
 *   - pairing    配对模式。**adapter 层放行全部 DM**,准入由
 *                `WeixinInboundBridge.evaluateGate` 判定:未配对 → 回配对码
 *                并阻断注入;已配对(WeixinPairingStore.allowed)→ 放行。
 *                两段式是为了让未配对用户能收到配对提示。
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
  /**
   * P1:动态白名单(WeixinPairingStore 已批准用户),与静态 `allowFrom`
   * 取并集。Web 面板批准后无需重建 adapter 即可生效。
   */
  dynamicDmAllowlist?: string[]
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
  const dynamic = input.dynamicDmAllowlist ?? []
  switch (input.dmPolicy) {
    case 'disabled':
      return { allowed: false, reason: 'dm_policy=disabled' }
    case 'allowlist':
      // 静态配置 + 动态批准的并集(D5)。
      return input.allowFrom.includes(input.senderId)
        ? { allowed: true, reason: 'dm_policy=allowlist hit' }
        : dynamic.includes(input.senderId)
          ? { allowed: true, reason: 'dm_policy=allowlist hit (paired)' }
          : { allowed: false, reason: 'dm_policy=allowlist miss' }
    case 'pairing':
      // 两段式设计:adapter 层放行所有 DM,真正的准入由
      // `WeixinInboundBridge.evaluateGate` 判定 —— 未配对用户必须能到达
      // bridge,才能收到配对码提示。若在这里直接拒收,用户永远不会知道
      // 如何配对(而且访问策略里也没有「回复他」的能力)。
      // 已配对用户走 dynamic 白名单,语义与 allowlist 一致。
      return { allowed: true, reason: dynamic.includes(input.senderId) ? 'dm_policy=pairing (paired)' : 'dm_policy=pairing (bridge enforces)' }
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
