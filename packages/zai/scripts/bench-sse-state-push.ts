#!/usr/bin/env tsx
/**
 * SSE state push 性能 benchmark。
 *
 * 用法: `cd packages/zai && npx tsx scripts/bench-sse-state-push.ts`
 *
 * 模拟 zai server 上的实际负载:
 * - 50 个 session 同时连 + 各订阅 bash task topic
 * - 5 个 bash 后台任务以总速率 ~1MB/s stdout 喷出
 * - 跑 ~1s,验证 eventBus 内存 < 50MB / SSE 帧数 ≈ 20 fps (非 1000 fps)
 *
 * 通过这条 benchmark 验证 (Phase E 验收):
 * 1. BashTracker 50ms debounce 把高频 appendOutput 折叠成低频 emit
 * 2. SSE state push (stateChangeBus → stateBridge → eventBus → SSE) 不会因
 *    高频源头击穿前端 React 渲染 (stateBridge 在 zai server 启动时一次性
 *    订阅,这是 in-process 路径)
 * 3. 50 个 session × topic 过滤仍是常量级开销 (subscriber Set 线性,
 *    filter O(1) lookup per event)
 *
 * 非 CI 集成 — 一次性 perf 验证脚本,跑完即用。保留作为未来回归参考。
 */

import { stateChangeBus, resetStateChangeBusForTests } from '@zn-ai/zai-agent-core/runtime'
import { bashBackgroundTracker, type BashTaskInfo } from '@zn-ai/zai-agent-core/bashTracker'

import { eventBus } from '../src/server/services/eventBus.js'
import { initStateBridge } from '../src/server/services/stateBridge.js'

const NUM_SESSIONS = 50
const NUM_TASKS = 5
const TOTAL_STDOUT_BYTES_TARGET = 1024 * 1024 // 1 MB
const CHUNK_SIZE = 1024 // 每次 appendOutput 写 1 KB
const RUN_MS = 1000 // 跑 ~1 s

async function main(): Promise<void> {
  // 清掉 module 单例的 listeners,避免 hot-reload 串扰
  resetStateChangeBusForTests()

  // 模拟 server 启动:initStateBridge 一次性把 stateChangeBus 翻译到 eventBus
  // (stateBridge 内部硬绑定到模块级 eventBus 单例,跟生产路径一致)
  const disposeBridge = initStateBridge()

  // 直接在 stateChangeBus 上挂 emit 计数,作为 ground truth (绕开 bridge / topic filter)
  let directEmitCount = 0
  stateChangeBus.on('bash_task.changed', () => {
    directEmitCount++
  })

  // 50 个 session 各订阅 ['bash'] topic + 自己的 sid → 总共 50 个 subscriber
  // 模拟 50 个 tab/页面都连上 SSE,但只有 5 个 session 当前有 bash task 在跑
  // (sess-0..sess-4 命中,sess-5..sess-49 收不到 — sid filter 工作正常)
  const frameCounts = new Array<number>(NUM_SESSIONS).fill(0)
  const totalBytesObserved = new Array<number>(NUM_SESSIONS).fill(0)
  const unsubs: Array<() => void> = []
  for (let i = 0; i < NUM_SESSIONS; i++) {
    const sid = `sess-${i}`
    const unsub = eventBus.subscribeTopics(sid, ['bash'], (ev: any) => {
      frameCounts[i]++
      const task: BashTaskInfo | undefined = ev.task
      if (task && typeof task.stdout === 'string') {
        // stdout 是 bashBackgroundTracker 累积 buffer,每次 emit 看到最新 size
        totalBytesObserved[i] = Math.max(totalBytesObserved[i], task.stdout.length)
      }
    })
    unsubs.push(unsub)
  }

  // 5 个 task (sess-0..sess-4 各一个,跟 50 subscriber 中 5 个 sid 对齐)
  for (let i = 0; i < NUM_TASKS; i++) {
    bashBackgroundTracker.register(`bash-${i}`, {
      command: 'bench',
      description: 'bench',
      sessionId: `sess-${i}`,
      startedAt: Date.now(),
    })
  }

  // 让 Node 跑 1ms 让 bridge listeners 完全装上
  await new Promise((resolve) => setTimeout(resolve, 1))

  const startMem = process.memoryUsage().heapUsed
  const startTime = Date.now()

  // 用 setTimeout(r, 0) 跨 chunk 让出事件循环,让 bashTracker 内部的 50ms
  // debounce timer 在真实时间维度上累计触发。如果用 setImmediate / while-loop
  // 不让出,1024 个 chunk 会在 17ms 内喷完,首个 50ms timer 触发后再没有新调用,
  // 整个 1s 窗口只 emit 1 次 — 测不出 debounce 行为。
  //
  // setTimeout(r, 0) 在 Node 上有 1ms 最小间隔,实际 ~880 chunks/s,稍低于 1024
  // 目标 — 但 ~1s 内 880 × 1KB = 880 KB,接近 1 MB,够用。
  const chunkBuf = 'x'.repeat(CHUNK_SIZE)
  const totalIterations = TOTAL_STDOUT_BYTES_TARGET / CHUNK_SIZE // 1024
  let iter = 0
  const pumpStartTime = Date.now()

  while (iter < totalIterations && Date.now() - startTime < RUN_MS) {
    const taskIdx = iter % NUM_TASKS
    bashBackgroundTracker.appendOutput(`bash-${taskIdx}`, { stdout: chunkBuf })
    iter++
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const pumpElapsedMs = Date.now() - pumpStartTime

  // 等 ~150ms 让最后一批 50ms debounce timer 触发
  await new Promise((resolve) => setTimeout(resolve, RUN_MS + 150))

  // 强制 flush 余下的 debounce (以防最后一次 chunk 落在 50ms 边界)
  bashBackgroundTracker.__flushPendingForTests()
  // 再等一帧让 emit 跑完
  await new Promise((resolve) => setTimeout(resolve, 20))

  const endMem = process.memoryUsage().heapUsed
  const elapsedMs = Date.now() - startTime

  // 统计
  const totalFrames = frameCounts.reduce((a, b) => a + b, 0)
  const matchedSessions = frameCounts.filter((c) => c > 0).length
  const maxBytesPerSession = Math.max(...totalBytesObserved)
  const meanBytesPerSession =
    totalBytesObserved.reduce((a, b) => a + b, 0) / NUM_SESSIONS
  const totalBytesPumped = iter * CHUNK_SIZE

  // BashTracker 50ms debounce × 1s / task = ~20 emits per task
  // 5 tasks → ~100 emits total → 5 sid 命中 subscribers → ~100 SSE 帧
  // 用 pump-only 窗口 (不是 total elapsed,后者包括 RUN_MS 后的等 debounce 时间)
  // 计算每 task 每秒帧数 — 这就是设计期望的 ~20 fps。
  const framesPerTaskPerSec =
    NUM_TASKS > 0 && pumpElapsedMs > 0 ? (totalFrames / NUM_TASKS) / (pumpElapsedMs / 1000) : 0

  const heapDeltaMB = (endMem - startMem) / 1024 / 1024

  console.log('=== SSE state push benchmark ===')
  console.log(`sessions:                  ${NUM_SESSIONS}`)
  console.log(`tasks:                     ${NUM_TASKS}`)
  console.log(`pump duration:             ${pumpElapsedMs}ms (target ~${RUN_MS}ms)`)
  console.log(`total elapsed:             ${elapsedMs}ms (pump + flush + cleanup)`)
  console.log(`stdout pumped:             ${(totalBytesPumped / 1024).toFixed(1)} KB (target ~1024 KB)`)
  console.log(`matched sessions (sid):    ${matchedSessions} of ${NUM_SESSIONS}`)
  console.log(`direct stateChangeBus emits (ground truth): ${directEmitCount}`)
  console.log(`total SSE frames delivered: ${totalFrames}`)
  console.log(`frames per task per second (pump window): ~${framesPerTaskPerSec.toFixed(1)} (target: ~20 fps)`)
  console.log(`max stdout observed in any session:      ${(maxBytesPerSession / 1024).toFixed(1)} KB`)
  console.log(`mean stdout observed across sessions:    ${(meanBytesPerSession / 1024).toFixed(1)} KB`)
  console.log(`heap delta:                              ${heapDeltaMB.toFixed(2)} MB (target: < 50 MB)`)
  console.log()

  // 断言: 50ms debounce × 1s = 20 fps per task
  const PASS_FPS_LOW = 15
  const PASS_FPS_HIGH = 30
  const PASS_HEAP_MB = 50
  const fpsOk = framesPerTaskPerSec >= PASS_FPS_LOW && framesPerTaskPerSec <= PASS_FPS_HIGH
  const heapOk = heapDeltaMB < PASS_HEAP_MB

  console.log(`fps per task: ${framesPerTaskPerSec.toFixed(1)}  (expected ~20, pass window ${PASS_FPS_LOW}-${PASS_FPS_HIGH})`)
  console.log(`heap ok:      ${heapOk ? 'YES' : 'NO'}  (delta ${heapDeltaMB.toFixed(2)} MB < ${PASS_HEAP_MB} MB)`)

  // cleanup
  for (const u of unsubs) u()
  disposeBridge()
  bashBackgroundTracker.__resetForTests()
  resetStateChangeBusForTests()

  if (!fpsOk) {
    console.error(`\n❌ FAIL: frames per task per second ${framesPerTaskPerSec.toFixed(1)} outside ${PASS_FPS_LOW}-${PASS_FPS_HIGH}`)
    process.exit(1)
  }
  if (!heapOk) {
    console.error(`\n❌ FAIL: heap delta ${heapDeltaMB.toFixed(2)} MB exceeds ${PASS_HEAP_MB} MB`)
    process.exit(1)
  }

  console.log('\n✅ PASS: SSE state push behaves as designed — debounced, bounded, and within memory budget.')
  process.exit(0)
}

main().catch((err) => {
  console.error('[bench-sse-state-push] crashed:', err)
  process.exit(2)
})