/**
 * inbox → runQueryLoop → runtime.query 回归测试
 *
 * 背景 (2026-09-20, lan-agent zai cwd=/Users/ethan/code/lan-agent 实测):
 *   SubagentNotifier 注入的 <task-notification> user 消息在 reload 后
 *   以 user 消息形态泄漏到 UI。根因不是 inboxToPendingPrompt 没标 fromInbox
 *   (那是 9-13 修过的),而是 runQueryLoop 把 prompt 喂给 runtime.query
 *   时漏了 isMeta:true —— 真正的落盘走 runtime.query → submitMessage →
 *   processUserInput → createUserMessage → recordTranscript,legacy
 *   TranscriptStore.append 是 no-op(legacyTranscriptStore.ts:462)。
 *
 *   appendUserMessageV2(cmd.displayText || cmd.fromInbox ? {isMeta:true})
 *   写的是 no-op store,起不到任何作用。
 *
 * 锁住 agent.ts:1428 的条件: cmd.displayText || cmd.fromInbox → isMeta:true
 * 透传到 runtime.query opts。如果以后有人改回去(只查 cmd.displayText),这
 * 条 test 必 fail,UI 又会泄漏 <task-notification>。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// 跟 agent.test.ts 一致的 mock 形状: capture 运行时 query 调用 opts,触发
// runtime 事件用空 generator(只关心透传的 isMeta,不验证 query 内容)。
let lastRunOpts: any = null

vi.mock('../../src/server/services/agentRuntime.js', () => ({
  getRuntime: () => ({
    query: (opts: any) => {
      lastRunOpts = opts
      return (async function* () {
        // empty stream
      })()
    },
    run: (_opts: any) => (async function* () {
      // empty stream
    })(),
    abort: async () => {},
    listSessions: async () => [],
    readSession: async () => ({ version: 1, transcriptId: 'sess-1', meta: {} as any, messages: [] }),
    readTranscript: async () => ({ version: 1, transcriptId: 'sess-1', meta: {} as any, messages: [] }),
    getSession: async () => null,
    patchSession: async () => {},
    removeSession: async () => {},
    shutdown: async () => {},
  }),
  getAskRegistry: () => ({ abortAll: () => {} }),
  getCurrentSessionId: () => 'sess-1',
  setCurrentSessionId: () => {},
  getTranscriptStore: () => ({
    list: async () => [],
    read: async () => ({
      version: 1,
      transcriptId: 'sess-1',
      meta: { cwd: '/tmp', model: 'unknown', createdAt: 0, updatedAt: 0 },
      messages: [],
    }),
    patch: async () => {},
    remove: async () => {},
    append: async () => {},
  }),
  initAgentRuntime: () => {},
  abortAgentSession: async () => {},
  registerSessionController: () => {},
  releaseSessionController: () => {},
  abortSessionController: () => false,
}))

vi.mock('@zn-ai/zn-agent-core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    EXTERNAL_PERMISSION_MODES: ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk'],
    takeDisplayFilesOutput: () => undefined,
  }
})

// 触发 agent.ts:1115-1117 的 setSessionInboxWakeHandler 注册 —— 真实生产代码
// 走 runNextInQueue 作为 wake handler。导入 router 让模块级 side-effect 跑。
import agentRouter from '../../src/server/routes/agent.js'
import {
  getSessionInbox,
  disposeSessionInbox,
} from '../../src/server/services/sessionInbox.js'
import express from 'express'
import http from 'node:http'

beforeEach(() => {
  lastRunOpts = null
})

afterEach(() => {
  disposeSessionInbox('sess-inbox-meta')
  disposeSessionInbox('sess-inbox-displaytext')
  vi.restoreAllMocks()
})

function startApp(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const app = express()
    app.use(express.json())
    app.locals.instanceContext = { cwd: '/tmp', cwdName: 'agent-inbox-meta-test' }
    app.use('/api', agentRouter)
    const server = http.createServer(app).listen(0, () => {
      const addr = server.address() as any
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
      })
    })
  })
}

/**
 * 把 <task-notification> XML push 进 inbox.nextTurn 并等待 wake handler
 * (runNextInQueue) 同步消费完。inbox.followup 走 idle 路径推 nextTurn
 * + wakeIfBudgeted(wake 默认 true),wake 触发 agent.ts:1115 注册的
 * runNextInQueue → runQueryLoop → runtime.query(opts),本测试捕获 opts。
 */
async function pumpInboxNotification(sid: string): Promise<void> {
  const inbox = getSessionInbox(sid)
  // 确保 idle 路径:不 setBusy,followup 走 nextTurn + wakeIfBudgeted
  inbox.followup(sid, {
    id: `bg-${Math.random().toString(36).slice(2)}`,
    source: { kind: 'subagent', form: 'notice' },
    content:
      '<task-notification>\n' +
      '<task-id>titfjosb9</task-id>\n' +
      '<agent-type>dsh</agent-type>\n' +
      '<status>completed</status>\n' +
      '<summary>Sub-agent "X" completed</summary>\n' +
      '</task-notification>',
    createdAt: Date.now(),
  })
  // runNextInQueue 是 fire-and-forget 的 microtask,等几帧让它跑完
  await new Promise(r => setTimeout(r, 50))
}

describe('runQueryLoop → runtime.query 透传 isMeta', () => {
  test('inbox 来源的 <task-notification> prompt → runtime.query opts 带 isMeta:true', async () => {
    const { url, close } = await startApp()
    try {
      // 触发 router 模块加载 → setSessionInboxWakeHandler(runNextInQueue) 注册
      await fetch(`${url}/api/agent/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp' }),
      }).catch(() => undefined)

      await pumpInboxNotification('sess-inbox-meta')

      expect(lastRunOpts).not.toBeNull()
      // 关键回归: inbox.followup → inboxToPendingPrompt({fromInbox:true}) →
      // runQueryLoop 喂 runtime.query 时必须 isMeta:true,否则 reload 后
      // <task-notification> 渲染成 user 气泡。
      expect(lastRunOpts.isMeta).toBe(true)
      expect(lastRunOpts.prompt).toContain('<task-notification>')
    } finally {
      close()
    }
  })

  test('普通用户输入(无 displayText / fromInbox)→ runtime.query opts 不带 isMeta', async () => {
    const { url, close } = await startApp()
    try {
      await fetch(`${url}/api/agent/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'sess-fresh',
          cwd: '/tmp',
          prompt: '普通用户消息',
        }),
      })

      await new Promise(r => setTimeout(r, 50))

      expect(lastRunOpts).not.toBeNull()
      // 普通用户消息不应被标 isMeta,否则前端也会藏掉
      expect(lastRunOpts.isMeta).toBeUndefined()
      expect(lastRunOpts.prompt).toBe('普通用户消息')
    } finally {
      close()
    }
  })
})