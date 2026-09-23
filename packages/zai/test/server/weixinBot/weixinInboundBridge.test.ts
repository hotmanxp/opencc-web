/**
 * weixinInboundBridge 测试 —— P0 注入 / D2 车道语义 / P1 配对 / P2 重放 / P3 媒体。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CwdStore } from '@zn-ai/zn-agent-core'
import { SessionInbox } from '../../../src/server/services/sessionInbox.js'
import { WeixinSessionMap } from '../../../src/server/services/weixinBot/WeixinSessionMap.js'
import { WeixinPairingStore } from '../../../src/server/services/weixinBot/WeixinPairingStore.js'
import { WeixinPendingStore } from '../../../src/server/services/weixinBot/WeixinPendingStore.js'
import { WeixinInboundBridge } from '../../../src/server/services/weixinBot/weixinInboundBridge.js'
import { registerBuiltinWeixinCommands } from '../../../src/server/services/weixinBot/weixinCommands.js'
import { resetWeixinMemoryForTests } from '../../../src/server/services/weixinBot/weixinMemory.js'
import type { InternalWeixinMessage } from '../../../src/server/services/weixinBot/WeixinAdapter.js'
import type { DmPolicy } from '../../../src/server/services/weixinBot/accessPolicy.js'

interface Harness {
  bridge: WeixinInboundBridge
  inbox: SessionInbox
  sessionMap: WeixinSessionMap
  pairing: WeixinPairingStore
  pending: WeixinPendingStore
  sent: Array<{ chatId: string; text: string }>
  followup: ReturnType<typeof vi.fn>
  cwd: string
  /** 模拟"实例重启后换到新工作目录":getCwd() 读的是这份可变槽。 */
  setCwd: (next: string) => void
}

function makeHarness(dmPolicy: DmPolicy, allowFrom: string[] = []): Harness {
  const cwd = mkdtempSync(join(tmpdir(), 'zai-wx-proj-'))
  let currentCwd = cwd
  const sessionMap = new WeixinSessionMap()
  const pairing = new WeixinPairingStore()
  const pending = new WeixinPendingStore()
  harnesses.push({ sessionMap, pairing, pending })
  const inbox = new SessionInbox()
  const followup = vi.spyOn(inbox, 'followup')
  const sent: Array<{ chatId: string; text: string }> = []
  const bridge = new WeixinInboundBridge({
    sessionMap,
    pairing,
    pending,
    inboxFor: () => inbox,
    getCwd: () => currentCwd,
    now: () => Date.now(),
    log: () => { /* quiet */ },
  })
  bridge.configure({
    accountId: 'acct',
    dmPolicy,
    groupPolicy: 'disabled',
    allowFrom,
    sendToChat: (chatId, text) => { sent.push({ chatId, text }) },
  })
  return {
    bridge, inbox, sessionMap, pairing, pending, sent, followup, cwd,
    setCwd: (next) => { currentCwd = next },
  }
}

let msgSeq = 0
function dm(text: string, over: Partial<InternalWeixinMessage> = {}): InternalWeixinMessage {
  msgSeq += 1
  return {
    accountId: 'acct',
    chatId: 'user_a',
    chatType: 'dm',
    senderId: 'user_a',
    text,
    mediaPaths: [],
    mediaTypes: [],
    messageId: `m-${msgSeq}`,
    contextToken: 'CT',
    raw: null,
    ...over,
  }
}

interface Flushables {
  sessionMap: WeixinSessionMap
  pairing: WeixinPairingStore
  pending: WeixinPendingStore
}

const harnesses: Flushables[] = []

describe('weixinInboundBridge', () => {
  beforeEach(() => {
    // 每个用例独立数据目录(session map / pairing / pending 都持久化)
    process.env.ZAI_DATA_DIR = mkdtempSync(join(tmpdir(), 'zai-wx-bridge-'))
  })

  afterEach(async () => {
    // 关键:把本次用例所有 pending 落盘 flush 掉,再结束。否则 fire-and-forget
    // 的 schedulePersist 会在下一个用例切换 ZAI_DATA_DIR 之后才执行,把旧数据
    // 写进新目录,造成跨用例串味。
    await Promise.all(
      harnesses.splice(0).flatMap((h) => [h.sessionMap.flush(), h.pairing.flush(), h.pending.flush()]),
    )
  })

  it('deliver → followup 注入,source.form=message(非 steer),displayText 透传,CwdStore 落位', async () => {
    const h = makeHarness('open')
    await h.bridge.deliver(dm('列出当前目录文件'))

    expect(h.followup).toHaveBeenCalledTimes(1)
    const [sid, inboxMsg] = h.followup.mock.calls[0] as [string, {
      source: { kind: string; form: string; platform?: string }
      content: string
      displayText?: string
    }]
    expect(sid).toMatch(/^sess-/)
    // ★ D2:必须是 message,steer 会被 skipSteer 的 promote 吞掉
    expect(inboxMsg.source.kind).toBe('user')
    expect(inboxMsg.source.form).toBe('message')
    expect(inboxMsg.source.platform).toBe('weixin')
    // ★ D3:Web UI 可见行 = 用户原话
    expect(inboxMsg.displayText).toBe('列出当前目录文件')
    // 注入内容带发送者头
    expect(inboxMsg.content).toContain('<weixin-message')
    expect(inboxMsg.content).toContain('列出当前目录文件')
    // cwd 绑定
    expect(CwdStore.get(sid)).toBe(h.cwd)
  })

  it('会话内 cd 过的 cwd 不会被下一条入站消息打回原目录', async () => {
    const h = makeHarness('open')
    await h.bridge.deliver(dm('第一条'))
    const [sid] = h.followup.mock.calls[0] as [string, unknown]
    const elsewhere = mkdtempSync(join(tmpdir(), 'zai-wx-elsewhere-'))
    CwdStore.set(sid, elsewhere) // 模拟 Bash 的 pwd trailer 同步

    await h.bridge.deliver(dm('第二条'))
    expect(CwdStore.get(sid)).toBe(elsewhere)
  })

  it('CwdStore 残留失效目录时,入站消息把它纠正为绑定 cwd', async () => {
    const h = makeHarness('open')
    await h.bridge.deliver(dm('第一条'))
    const [sid] = h.followup.mock.calls[0] as [string, unknown]
    const dead = mkdtempSync(join(tmpdir(), 'zai-wx-dead-'))
    rmSync(dead, { recursive: true, force: true })
    CwdStore.set(sid, dead)

    await h.bridge.deliver(dm('第二条'))
    expect(CwdStore.get(sid)).toBe(h.cwd)
  })

  it('复现线上故障:绑定目录被删 + 实例重启换了目录 → 下一条消息即自愈', async () => {
    const h = makeHarness('open')
    await h.bridge.deliver(dm('第一条'))
    const [sid] = h.followup.mock.calls[0] as [string, unknown]

    // 目录被删(worktree 被清理),实例重启后 working dir 换成新目录
    rmSync(h.cwd, { recursive: true, force: true })
    const fresh = mkdtempSync(join(tmpdir(), 'zai-wx-fresh-'))
    h.setCwd(fresh)

    await h.bridge.deliver(dm('重启后的第二条'))
    // CwdStore 不再卡在死目录(修复前:Bash 永久报 no longer a valid directory)
    expect(CwdStore.get(sid)).toBe(fresh)
    // 绑定的 cwd 也自愈并落盘(会话 id 不变,对话历史不断)
    const b = await h.sessionMap.lookupBySessionId(sid)
    expect(b!.cwd).toBe(fresh)
    expect(b!.sessionId).toBe(sid)
  })

  it('replayPending:已有有效 cwd 时不被打回', async () => {
    const h = makeHarness('open')
    const binding = await h.sessionMap.resolveOrCreate(
      { accountId: 'acct', chatType: 'dm', chatId: 'user_a', senderId: 'user_a' },
      h.cwd,
    )
    const elsewhere = mkdtempSync(join(tmpdir(), 'zai-wx-elsewhere-'))
    CwdStore.set(binding.sessionId, elsewhere)
    await h.pending.save({
      messageId: 'crash-cwd',
      accountId: 'acct',
      chatType: 'dm',
      chatId: 'user_a',
      senderId: 'user_a',
      text: '崩溃前的那条',
      mediaPaths: [],
      mediaTypes: [],
      contextToken: 'CT',
      receivedAt: Date.now() - 1000,
    })

    expect(await h.bridge.replayPending()).toBe(1)
    expect(CwdStore.get(binding.sessionId)).toBe(elsewhere)
  })

  it('同 messageId 重复投递 → 只注入一次(幂等)', async () => {
    const h = makeHarness('open')
    const m = dm('hello', { messageId: 'dup-1' })
    await h.bridge.deliver(m)
    await h.bridge.deliver(m)
    expect(h.followup).toHaveBeenCalledTimes(1)
  })

  it('busy 时落 nextStep(不丢),turn 结束被 promote 到 nextTurn —— 验证不会被 skipSteer 吞掉', async () => {
    const h = makeHarness('open')
    const binding = await h.sessionMap.resolveOrCreate(
      { accountId: 'acct', chatType: 'dm', chatId: 'user_a', senderId: 'user_a' },
      h.cwd,
    )
    h.inbox.setBusy(binding.sessionId)

    await h.bridge.deliver(dm('忙的时候插一句'))
    expect(h.inbox.peekNextStepCount(binding.sessionId)).toBe(1)
    expect(h.inbox.peekNextTurnCount(binding.sessionId)).toBe(0)

    // busyFlush 的兜底提升(skipSteer=true)
    const promoted = h.inbox.promoteNextStepToNextTurn(binding.sessionId, { skipSteer: true })
    expect(promoted).toBe(1)
    expect(h.inbox.peekNextTurnCount(binding.sessionId)).toBe(1)
  })

  it('对照组:steer 形态的消息会被 skipSteer 留下(说明 form 选择是决定性的)', async () => {
    const h = makeHarness('open')
    const sid = 'sess-steer-control'
    h.inbox.steer(sid, {
      id: 'steer-1',
      source: { kind: 'user', form: 'steer' },
      content: '我是 steer',
      createdAt: Date.now(),
    })
    expect(h.inbox.promoteNextStepToNextTurn(sid, { skipSteer: true })).toBe(0)
    expect(h.inbox.peekNextStepCount(sid)).toBe(1)
  })

  it('pairing:未配对 → 回配对码、不注入 agent', async () => {
    const h = makeHarness('pairing')
    await h.bridge.deliver(dm('陌生人消息'))
    expect(h.followup).not.toHaveBeenCalled()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].chatId).toBe('user_a')
    expect(h.sent[0].text).toMatch(/\d{6}/)
    expect(h.sent[0].text).toContain('未授权')
    // agent 未被触发(没有 sess- session 产生)
    expect(await h.sessionMap.size()).toBe(0)
  })

  it('pairing:批准后放行', async () => {
    const h = makeHarness('pairing')
    await h.bridge.deliver(dm('第一条'))
    expect(h.followup).not.toHaveBeenCalled()
    await h.pairing.approve('user_a')
    await h.bridge.deliver(dm('第二条'))
    expect(h.followup).toHaveBeenCalledTimes(1)
  })

  it('allowlist:不在名单也不在动态白名单 → 静默忽略(不回复、不注入)', async () => {
    const h = makeHarness('allowlist', ['someone_else'])
    await h.bridge.deliver(dm('hi'))
    expect(h.followup).not.toHaveBeenCalled()
    expect(h.sent).toHaveLength(0)
  })

  it('allowlist:动态配对白名单并入后放行(D5 并集)', async () => {
    const h = makeHarness('allowlist', [])
    await h.pairing.approve('user_a')
    await h.bridge.deliver(dm('hi'))
    expect(h.followup).toHaveBeenCalledTimes(1)
  })

  it('鉴权失败的用户不会产生待重放 pending(只有过闸的消息才落盘)', async () => {
    const h = makeHarness('pairing')
    await h.bridge.deliver(dm('陌生人'))
    expect(await h.pending.count()).toBe(0)
  })

  it('replayPending:模拟注入前崩溃 → 重启重放一次,再重放不重复', async () => {
    const h = makeHarness('open')
    // 模拟崩溃:消息已落盘但未注入
    await h.pending.save({
      messageId: 'crash-1',
      accountId: 'acct',
      chatType: 'dm',
      chatId: 'user_a',
      senderId: 'user_a',
      text: '崩溃前的那条',
      mediaPaths: [],
      mediaTypes: [],
      contextToken: 'CT',
      receivedAt: Date.now() - 1000,
    })

    const n = await h.bridge.replayPending()
    expect(n).toBe(1)
    expect(h.followup).toHaveBeenCalledTimes(1)
    expect(await h.pending.count()).toBe(0)

    // 再重放:已 processed,不重复注入
    expect(await h.bridge.replayPending()).toBe(0)
    expect(h.followup).toHaveBeenCalledTimes(1)
  })

  it('入站媒体镜像到项目可读目录并写进 prompt', async () => {
    const h = makeHarness('open')
    const src = join(mkdtempSync(join(tmpdir(), 'zai-wx-media-')), 'pic.jpg')
    writeFileSync(src, 'fake-image-bytes')
    await h.bridge.deliver(dm('看这张图', { mediaPaths: [src], mediaTypes: ['image/jpeg'] }))

    const [, inboxMsg] = h.followup.mock.calls[0] as [string, { content: string }]
    expect(inboxMsg.content).toContain(join(h.cwd, '.zai', 'weixin-media'))
    expect(inboxMsg.content).toContain('[image/jpeg]')
  })

  it('无 messageId 时用内容指纹做幂等键', async () => {
    const h = makeHarness('open')
    const m = dm('没有 id', { messageId: '' })
    await h.bridge.deliver(m)
    await h.bridge.deliver({ ...m })
    expect(h.followup).toHaveBeenCalledTimes(1)
  })

  // ─── 指令解析(/new)与轮转 ─────────────────────────────────────

  it('/new:轮转 session + 回执,不注入 agent;后续消息走新 session', async () => {
    registerBuiltinWeixinCommands()
    const h = makeHarness('open')
    await h.bridge.deliver(dm('第一条'))
    const [sidOld] = h.followup.mock.calls[0] as [string, unknown]

    await h.bridge.deliver(dm('/new'))
    // 不注入 agent,发回执
    expect(h.followup).toHaveBeenCalledTimes(1)
    expect(h.sent.some((s) => s.text.includes('已开启新会话'))).toBe(true)

    // 轮转后的消息走新 session
    await h.bridge.deliver(dm('新会话第一条'))
    expect(h.followup).toHaveBeenCalledTimes(2)
    const [sidNew] = h.followup.mock.calls[1] as [string, unknown]
    expect(sidNew).not.toBe(sidOld)
    expect(sidNew).toMatch(/^sess-/)
  })

  it('/restart:先发 ack,再触发 onRestart hook,不注入 agent', async () => {
    const onRestart = vi.fn(() => true)
    registerBuiltinWeixinCommands({ onRestart })
    const h = makeHarness('open')
    // 先发一条消息,确保有 session 绑定 —— /restart 应在该 session 上下文触发。
    await h.bridge.deliver(dm('hello'))

    await h.bridge.deliver(dm('/restart'))

    // 不注入 agent —— restart 走自己的 hook,通道马上就要断。
    expect(h.followup).toHaveBeenCalledTimes(1)
    // ack 必须发出去,让用户在通道断开前看到 bot 响应。
    expect(h.sent.some((s) => s.text.includes('正在重启微信通道'))).toBe(true)
    // onRestart 用 user_action 触发,与 SettingsDrawer 的重启按钮同一 reason。
    expect(onRestart).toHaveBeenCalledTimes(1)
    expect(onRestart).toHaveBeenCalledWith('user_action')
  })

  it('/restart now:trailing args 不影响 dispatch,仍触发 onRestart', async () => {
    const onRestart = vi.fn(() => true)
    registerBuiltinWeixinCommands({ onRestart })
    const h = makeHarness('open')

    await h.bridge.deliver(dm('/restart now'))

    expect(h.followup).toHaveBeenCalledTimes(0)
    expect(onRestart).toHaveBeenCalledWith('user_action')
  })

  it('/restart:未注入 onRestart hook 时只发 ack,不抛错', async () => {
    // 生产上 WeixinBotManager.start() 总会注入 hook;但裸注册(测试 / 早期启动)
    // 不能因为缺 hook 就崩 —— ack 已发,留 warning 即可。
    registerBuiltinWeixinCommands()
    const h = makeHarness('open')

    await h.bridge.deliver(dm('/restart'))

    expect(h.followup).toHaveBeenCalledTimes(0)
    expect(h.sent.some((s) => s.text.includes('正在重启微信通道'))).toBe(true)
  })

  it('未注册的 / 开头消息原样穿透给 agent', async () => {
    registerBuiltinWeixinCommands()
    const h = makeHarness('open')
    await h.bridge.deliver(dm('/etc/hosts 里配了什么'))
    expect(h.followup).toHaveBeenCalledTimes(1)
    const [, inboxMsg] = h.followup.mock.calls[0] as [string, { content: string }]
    expect(inboxMsg.content).toContain('/etc/hosts 里配了什么')
    expect(h.sent).toHaveLength(0)
  })

  it('TTL 轮转:resolveOrCreate 阶段自动迁入新 session 并触发记忆沉淀', async () => {
    registerBuiltinWeixinCommands()
    const h = makeHarness('open')
    h.sessionMap.setRotationPolicy({ ttlMs: 1000 })
    await h.bridge.deliver(dm('老会话消息'))
    const [sidOld] = h.followup.mock.calls[0] as [string, unknown]
    // 把绑定 createdAt 拨回超 TTL
    const binding = await h.sessionMap.lookupByConversationKey(
      (await h.sessionMap.list())[0].conversationKey,
    )
    ;(binding as unknown as { createdAt: number }).createdAt = Date.now() - 2 * 3600_000

    await h.bridge.deliver(dm('触发轮转的消息'))
    expect(h.followup).toHaveBeenCalledTimes(2)
    const [sidNew, inboxMsg] = h.followup.mock.calls[1] as [string, { content: string }]
    expect(sidNew).not.toBe(sidOld)
    // 无 transcript → 无记忆块,但消息正常注入
    expect(inboxMsg.content).toContain('触发轮转的消息')
  })
})
