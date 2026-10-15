/**
 * 产物级守护:stateChangeBus 在**打包产物**里必须单例。
 *
 * ## 为什么需要它(单测锁不住)
 *
 * 常规单测跑的是 `src/`,vite-node 逐模块加载,天然每个模块一份 —— 单例
 * 在测试里**必然成立**,因此任何针对它的断言都是同义反复。
 *
 * 真实风险在产物侧:`zn-agent-core` 用 esbuild 打包成单文件
 * (`dist/opencc-core.mjs`)。一旦将来出现第二个 bundle、或 zai 侧多出一条
 * 加载路径(esbuild 把 bus 内联成 bundle 私有实例),core 内 emit 的事件
 * 就到不了 zai 的 stateBridge 订阅者 → **事件静默丢失,信号发不出去**。
 *
 * 这正是 compat/runtime/agentTaskBridge.ts:13-19 的 ★ 警告描述的形态。
 * 该警告针对 `opencc-src/server` 子系统(走 `globalThis.__zaiEventBus` 桥);
 * 本守护覆盖的是**主入口**这条路径 —— 即 `compat/compact/compactProgress.ts`
 * emit 压缩过程信号所依赖的那条。
 *
 * ## 怎么验(读代码推断不算,必须跑产物)
 *
 * 用 `node` 子进程 `import()` 真实的 `dist/opencc-core.mjs`:
 *   - vitest 的 vite-node 解析语义与 Node 不同,在测试体内 import 产物
 *     并不可靠(可能被 alias/ts 转换影响);
 *   - 子进程是最接近 zai 生产运行时的加载方式。
 *
 * 子进程内的探针:
 *   1. 从**主入口**拿 `stateChangeBus`;
 *   2. 用**只有 compat 内部会走的** `createCompactProgressEmitter` 发信号;
 *   3. 若二者同实例,主入口的 listener 收到事件;收不到 = 分裂。
 *
 * 探针在 `packages/zai/` 目录下执行 —— 那才是 zai 运行时解析
 * `@zn-ai/zn-agent-core`(workspace 软链 + exports → dist)的真实上下文。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const CORE_ROOT = join(__dirname, '..', '..')
const DIST = join(CORE_ROOT, 'dist')
const BUNDLE = join(DIST, 'opencc-core.mjs')
const ZAI_ROOT = join(CORE_ROOT, '..', 'zai')

/**
 * 探针脚本。放在 zai 目录下用 node 跑,复现生产解析路径。
 *
 * 注意 emitter 必须**单个** —— 早前版本建了两个独立 emitter 并期待
 * start/end 各收一帧,但第二个从未 start 过,其 compact_end 被去重逻辑
 * 正确早退,导致探针误报 "SAME_INSTANCE=false"。那不是分裂,是探针写错。
 */
const PROBE = `
import { stateChangeBus, createCompactProgressEmitter } from '@zn-ai/zn-agent-core';

const seen = [];
stateChangeBus.on('compact.changed', (e) => seen.push(e));

const em = createCompactProgressEmitter('smoke-probe');
em.onCompactProgress({ type: 'compact_start' });
em.onCompactProgress({ type: 'compact_end' });

process.stdout.write(JSON.stringify({
  sameInstance: seen.length === 2,
  frames: seen,
}));
`

interface ProbeResult {
  sameInstance: boolean
  frames: Array<{ sessionId: string; compacting: boolean }>
}

describe('产物级: stateChangeBus 在打包产物里单例', () => {
  let result: ProbeResult

  beforeAll(() => {
    if (!existsSync(BUNDLE)) {
      throw new Error(
        `产物不存在: ${BUNDLE}。先跑 \`pnpm run build:core\` —— ` +
          `本守护跑的是产物,不是源码,没有 dist 时无法验证。`,
      )
    }
    let out: string
    try {
      out = execFileSync(process.execPath, ['-e', PROBE], {
        cwd: ZAI_ROOT,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      // ⚠️ 这里**必须**抛出而非吞掉。探针子进程崩溃时 vitest 会把该 describe
      // 的用例标成 "skipped" 而非 failed —— 守护在产物损坏(正是它要拦的
      // 回归形态)时会静默通过,比没有守护更危险。
      // 实测: 把 bundle 的 emit 改坏后, execFileSync 抛错, 三个用例全部
      // 报 "3 skipped" 且退出码 0, CI 照样绿。
      const detail = err as { stderr?: Buffer | string; message?: string }
      throw new Error(
        `探针子进程失败 —— 产物可能无法加载, 或 stateChangeBus 真的分裂了。\n` +
          `不要把这降级成 skip: skip 意味着"没验", 而守护的价值正在于拦住回归。\n` +
          `stderr: ${String(detail.stderr ?? '')}\n` +
          `message: ${detail.message ?? ''}`,
      )
    }
    try {
      result = JSON.parse(out) as ProbeResult
    } catch {
      throw new Error(`探针输出不是合法 JSON (产物可能被改坏): ${out.slice(0, 300)}`)
    }
  })

  it('compat 内的 emitter 与主入口的 bus 是同一实例 (未分裂)', () => {
    // 分裂的表现: core 内 emit 的 compact.changed 到不了订阅者,
    // SSE 上 runtime.compacting 帧数为 0 —— 静默丢事件,无任何报错。
    expect(result.frames.length).toBe(2)
    expect(result.sameInstance).toBe(true)
  })

  it('收到的是完整的 start→end 翻转序列', () => {
    expect(result.frames).toEqual([
      { sessionId: 'smoke-probe', compacting: true },
      { sessionId: 'smoke-probe', compacting: false },
    ])
  })

  it('dist 下不存在第二个 bundle (单文件打包约定)', () => {
    // 多一个 .mjs 就意味着可能有两份 bus 实例 —— 这正是要拦的回归形态。
    const bundles = readdirSync(DIST).filter((f) => f.endsWith('.mjs'))
    expect(bundles).toEqual(['opencc-core.mjs'])
  })
})