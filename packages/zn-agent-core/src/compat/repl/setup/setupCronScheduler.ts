// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): L1 hook adapter — setupScheduledTasks.
 * Imperative wrapper over vendor useScheduledTasks internals
 * (createCronScheduler + enqueuePendingNotification).
 */

import { createCronScheduler, type CronScheduler } from '../../../opencc-src/utils/cronScheduler.js'
import { enqueuePendingNotification } from '../../../opencc-src/utils/messageQueueManager.js'
// zai patch (2026-09-07, plan P1-2.1, worktree-dsh, fix-area: vendor-enqueue-imports):
// import 替换 vendor enqueue 为 zai layer wrapper (cron 触发入队通知 LLM)
import { zaiEnqueuePendingNotification } from '../../messageQueueAdapter.js'
import { isKairosCronEnabled } from '../../../opencc-src/tools/ScheduleCronTool/prompt.js'

type SetupScheduledTasksOpts = {
  /**
   * zai patch (2026-09-12, plan cron-fire-to-prompt): sessionId 在 v1 路径
   * (createReplSession 调) 是必填的 (per-session 实例, onFire 知道 session
   * 上下文); v2 路径 (createOpenccRuntimeImpl 调) 是 per-server 单例, 没有
   * 固定 sessionId, onFire 时改读 globalThis.__zaiCurrentSessionId (zai-server
   * setCurrentSessionId 写入)。这里改成可选 —— v2 调用方传空字符串或不传即可,
   * 不会让 session 路由出错。
   */
  sessionId?: string
  getAppState: () => unknown
  isLoading: () => boolean
  assistantMode?: boolean
  onFireTask?: (task: any) => void
  onMissed?: (tasks: any[]) => void
}

// zai patch (2026-10-04):改为导出。`server/createOpenccRuntime-impl.ts:75`
// 用 `import { type SetupScheduledTasks }` 取它做 `_cronHandle` 的类型注解,
//但本文件一直没 export —— 该引用被 @ts-nocheck 掩盖成 TS2724
//「no exported member named 'SetupScheduledTasks'」。纯类型层,编译后擦除。
export type SetupScheduledTasks = {
  teardown(): void
  subscribe(cb: (prompt: string) => void): () => void
}

export function setupScheduledTasks(opts: SetupScheduledTasksOpts): SetupScheduledTasks {
  const subs = new Set<(prompt: string) => void>()
  let scheduler: CronScheduler | null = null

  if (isKairosCronEnabled()) {
    // zai patch (2026-09-13, cron-fire-routing): fire 路由提取成函数。
    // 优先级:task.sessionId(CronCreate 记录的创建 session)> opts.sessionId
    // (v1 per-session 实例)> globalThis.__zaiCurrentSessionId(最后活跃)。
    // 旧实现在 v2 路径(opts.sessionId='')永远走 globalThis fallback ——
    // 微信会话创建的"3 分钟后提醒"在 Web session 活跃时 fire,prompt 被
    // 路由到最后活跃的 session,微信永远收不到。
    // 用 `||` 而非 `??`: v2 调用方传 sessionId: '' 时也该 fallback (空串
    // 不是有效 sessionId, 不能用作 inbox 路由 key)。
    const routeFire = async (prompt: string, taskSessionId?: string) => {
      let sid: string =
        taskSessionId ||
        opts.sessionId ||
        (globalThis as { __zaiCurrentSessionId?: string }).__zaiCurrentSessionId ||
        ''

      // zai patch: 上面三级全空时 sid 为空,第 1 步的 enqueue 抛错被
      // catch 吞掉,而 scheduler 照常写 lastFiredAt —— 净效果是
      // 「定时任务到点没反应」。durable 任务必然踩中:cronTasks.ts 的
      // writeCronTasks 把 sessionId 当 runtime-only strip 掉,进程重启后
      // 也没有活跃 session 可回落 __zaiCurrentSessionId。
      // 这里问 zai-server 要一个落点(本实例 cwd 下最近更新的会话)。
      if (!sid) {
        const resolveCronSession = (
          globalThis as {
            __zaiResolveCronSession?: () => string | null | Promise<string | null>
          }
        ).__zaiResolveCronSession
        if (typeof resolveCronSession === 'function') {
          try {
            sid = (await resolveCronSession()) ?? ''
          } catch (err) {
            console.warn('[cron] session resolver failed:', err)
          }
        }
      }

      // 1) vendor commandQueue fallback —— 尝试注入 sessionId 后入队。
      //    sid 仍为空(没有活跃 session 且 __zaiResolveCronSession 未装
      //    —— vendor 单测 / 裸 CLI),zaiEnqueuePendingNotification 抛错
      //    被此处 catch 吞掉,fire 退化为 no-op 而非污染全局 session 路由。
      try {
        zaiEnqueuePendingNotification({
          value: prompt,
          mode: 'prompt',
          priority: 'later',
          isMeta: true,
          ...(sid ? { sessionId: sid } : {}),
        })
      } catch (err) {
        console.warn('[cron] zaiEnqueuePendingNotification failed:', err)
      }

      // Fix 2: SessionInbox followup —— 让 idle session 真的被 wake, LLM 看到 prompt。
      // (idle → nextTurn + wake; busy → nextStep), 让 zai-server 真正拿到
      // prompt + SSE 推前端。这个 seam 由 zai-server 在 createApp 时 install
      // (见 agentRuntime.ts 的 __zaiSessionInboxFollowup); 未安装时静默 no-op
      // (vendor 单测 / 离线构造场景), 不影响 fallback。
      if (sid) {
        const inboxFollowup = (
          globalThis as {
            __zaiSessionInboxFollowup?: (
              sessionId: string,
              msg: {
                id: string
                source: { kind: string; form: string }
                content: string
                createdAt: number
              },
            ) => void
          }
        ).__zaiSessionInboxFollowup
        if (typeof inboxFollowup === 'function') {
          try {
            inboxFollowup(sid, {
              id: `cron_fire-${Date.now()}`,
              source: { kind: 'system', form: 'notice' },
              content: prompt,
              createdAt: Date.now(),
            })
          } catch (err) {
            console.warn('[cron] inbox followup failed:', err)
          }
        }
      }

      for (const cb of subs) {
        // subscriber 抛错不该让 fire 整体变成 unhandledRejection。
        try {
          cb(prompt)
        } catch (err) {
          console.warn('[cron] subscriber threw:', err)
        }
      }
    }

    scheduler = createCronScheduler({
      // zai patch (2026-09-13, cron-fire-routing): 用 onFireTask 拿完整 task,
      // 路由优先 task.sessionId(创建 session)。opts.onFireTask 由调用方
      // (daemon 等)提供时仍优先透传,保持 vendor 语义。
      onFireTask: opts.onFireTask ?? (task => void routeFire(task.prompt, task.sessionId)),
      onFire: prompt => {
        // 只剩 missed-task 通知路径(onMissed 未提供时 vendor 走这里)。
        // 通知没有"创建 session"语义,按旧优先级路由。
        void routeFire(prompt)
      },
      onMissed: opts.onMissed,
      isLoading: opts.isLoading,
      assistantMode: opts.assistantMode ?? false,
      isKilled: () => !isKairosCronEnabled(),
    })
    scheduler.start()
  }

  return {
    teardown() {
      if (scheduler) {
        scheduler.stop()
        scheduler = null
      }
      subs.clear()
    },
    subscribe(cb) {
      subs.add(cb)
      return () => { subs.delete(cb) }
    },
  }
}
