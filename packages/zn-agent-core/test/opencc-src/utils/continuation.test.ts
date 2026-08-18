/**
 * Tests for opencc-src/utils/continuation.ts — continuation-nudge intent detection.
 *
 * Two layers:
 * 1. Ported behavioral cases from opencc upstream `src/__tests__/bugfixes.test.ts`
 *    (Fix 3 / Fix 3b) — the contract the vendored code must keep honoring.
 * 2. Regression for the real false-positive that shipped: a Chinese summary
 *    mentioning "installing" (the task's subject) matched the bare -ing
 *    full-text signal, and Chinese terminal punctuation was not recognized,
 *    so completed summaries got nudge-injected over and over
 *    ("The user keeps sending Continue with the task …").
 */
import { describe, expect, it } from 'vitest'
import { analyzeContinuationIntent } from '../../../src/opencc-src/utils/continuation.js'

describe('continuation nudge — opencc 官方行为(移植自 bugfixes.test.ts)', () => {
  it('transition intent detected (requires explicit action verb)', () => {
    expect(analyzeContinuationIntent('So now I will start task 2').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('I will now do the following').shouldNudge).toBe(true)
  })

  it('completion marker suppresses nudge', () => {
    expect(analyzeContinuationIntent('Task finished').shouldNudge).toBe(false)
    expect(analyzeContinuationIntent('The analysis is complete and no code changes are needed here').shouldNudge).toBe(false)
    expect(analyzeContinuationIntent('I changed package.json and src/query.ts and added tests').shouldNudge).toBe(false)
    expect(analyzeContinuationIntent('Updated src/query.ts and added coverage in bugfixes.test.ts').shouldNudge).toBe(false)
    expect(analyzeContinuationIntent('This should be ready after the latest test updates').shouldNudge).toBe(false)
  })

  it('mixed intent: late continuation survives earlier completion', () => {
    expect(analyzeContinuationIntent('Task 1 is done. Let me update the status.').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Task 1 finished. I will now run tests.').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Analysis complete. Now I will edit src/query.ts').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('No issues in the first file. I will now inspect the next one.').shouldNudge).toBe(true)
  })

  it('structural truncation survives earlier completion', () => {
    expect(analyzeContinuationIntent('Setup is complete. Here is the code:\n```typescript\nfunction run() {').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Task complete. Please inspect (src/query.ts').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('The analysis is done and now I am editing files and').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('I am currently updating the following files and').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Please check the results in (src/query.ts').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('The plan is as follows:').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Here is the code:\n```typescript\nfunction test() {').shouldNudge).toBe(true)
  })

  it('newly added verbs trigger continuation', () => {
    expect(analyzeContinuationIntent('Now I will process the data').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Let me download the file').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Time to compile the source').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('I need to train the model').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('So now I will evaluate the results').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent("Now I'll test the endpoint").shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Let me extract the archive').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('I will merge the changes').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Time to deploy to production').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Now I will install the package').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('I need to configure the server').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Let me refactor this component').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Time to optimize the query').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Now I will upload the artifact').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('I need to convert the format').shouldNudge).toBe(true)
  })

  it('imperative / declarative patterns trigger continuation', () => {
    expect(analyzeContinuationIntent('Need to update the config').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Need to process these files').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Need to deploy the changes').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Now create the component').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Now run the tests').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Now compile everything').shouldNudge).toBe(true)
    // "Now you …" excluded by negative lookahead
    expect(analyzeContinuationIntent('Now you can run the app').shouldNudge).toBe(false)
    expect(analyzeContinuationIntent('Next I will fix the bug').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Next we need to add tests').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Next I should deploy').shouldNudge).toBe(true)
    // Punctuated variants
    expect(analyzeContinuationIntent('Need to process the files.').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Need to deploy the changes.').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Now create the component.').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Now run the tests.').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Next I will fix the bug.').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Next we need to add tests.').shouldNudge).toBe(true)
    // Subject-led advice ("You/We need to …") must NOT trigger
    expect(analyzeContinuationIntent('You need to update the config.').shouldNudge).toBe(false)
    expect(analyzeContinuationIntent('You need to process these files.').shouldNudge).toBe(false)
    expect(analyzeContinuationIntent('You need to update the config').shouldNudge).toBe(false)
    expect(analyzeContinuationIntent('We need to deploy the changes.').shouldNudge).toBe(false)
  })

  it('present-progressive fallback triggers continuation', () => {
    expect(analyzeContinuationIntent('Task done. Now processing the next batch.').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Finished step 1. Now compiling the assets.').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Complete. Now deploying to staging.').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('All set. Now testing the endpoint.').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Done. Now installing dependencies.').shouldNudge).toBe(true)
    // Passive / non-action -ing words must NOT trigger
    expect(analyzeContinuationIntent('Now being processed by the system').shouldNudge).toBe(false)
    expect(analyzeContinuationIntent('Now waiting for user input').shouldNudge).toBe(false)
    expect(analyzeContinuationIntent('Now having some issues').shouldNudge).toBe(false)
  })

  it('completion marker correctly suppressed by nearby continuation signal', () => {
    expect(analyzeContinuationIntent('The download is complete. Now processing the files.').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('The analysis is done. Let me update the report.').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Compilation finished. Now deploying the build.').shouldNudge).toBe(true)
    // "done" at the very end without continuation signal — no nudge
    expect(analyzeContinuationIntent('All tests pass. Task done.').shouldNudge).toBe(false)
    expect(analyzeContinuationIntent('The implementation is complete.').shouldNudge).toBe(false)
  })
})

describe('continuation nudge — 中文总结误判回归(真实会话样本)', () => {
  // 源自 sess-1787034435763-mhirww4r 中 163/171/173 三条完成总结:
  // 全文(含任务主题词 "installing")触发过 continuation nudge,出现
  // "The user keeps sending 「Continue with the task …」" 死循环。
  const threeRealSummaries = [
    `已提交 \`9c296ec\`,工作区干净。

## 根因

\`app.update.complete\` 事件链路全程都是通的(服务端 emit → \`isGlobalEvent\` 登记 → SSE \`NAMED_EVENT_TYPES\` → store reducer 置 \`complete\`),问题出在 \`UpdateNotifier.tsx\` 的去重逻辑:

\`shownKeyRef\` 把 progress notification 和 final Modal 塞进同一个 key 空间。\`installing\` 阶段(0.3.16 → 0.3.17)已写入 \`shownKeyRef.current = '0.3.16->0.3.17'\`,随后 \`complete\` 阶段算出相同 key,被 \`if (shownKeyRef.current === currentKey) return\`(UpdateNotifier.tsx:63)短路——所以你能看到"正在后台升级 zai…"的顶部通知,但升级完成的 Modal 永远不弹。控制台的 \`[updater] changed 524 packages\` 恰恰证明事件被推送,只是前端吞了。

## 修复

- 最终弹窗去重改为 module 级 \`shownFinalModals\` Set,只记 complete/failed 的 key——跨 Layout/MobileAgent 双挂载、React StrictMode 双执行也能抑制;Set 清理跟随 \`app.update.checking\`(新一轮升级信号)而非用户按钮,期间同 key 重放(SSE 重连历史重发)被挡,回滚后再升同版本仍能弹
- progress notification 删掉 ref 依赖,靠 antd 同 key 幂等更新文案
- 新增 \`UpdateNotifier.test.tsx\` 6 个用例,覆盖核心回归(installing → complete 必须弹 Modal)、dismiss 后重放不再弹、checking 前导后同 key 允许重弹、双挂载只弹一次、failed 分支;全部通过,\`tsc --noEmit\` 干净

验收说明:按你要求跳过了 ego-browser 真实浏览器验证。单测已用真实 antd mock + 真实 store reducer 覆盖完整状态机;如果有空,\`zai dev\` 起来的实例(Vite HMR 已自动加载新代码)里可以等一次真实升级流程确认。`,
    `全部收尾完成,任务已结束:

**已提交**:\`9c296ec HRMSV3-ZN-WEBSITE#668 fix(zai): 修复升级完成 Modal 被 installing 去重短路不弹出\`

- 根因:UpdateNotifier 用组件内 \`shownKeyRef\` 混用两档去重,\`installing\` 先占 key、\`complete\` 判同 key 短路,升级完成 Modal 永不弹
- 修复:改用 module 级 \`shownFinalModals\` Set 只拦 final Modal,清理跟随 \`checking\` 信号;antd 同 key 幂等处理进度通知
- 测试:\`UpdateNotifier.test.tsx\` 6 用例全过(含核心回归 installing→complete 必须弹、重放/双挂/新一轮重弹),\`tsc --noEmit\` 干净
- 工作区干净,无远程仓库不需要推送;ego-browser 验证任务空间已关闭

按你的要求跳过了 ego-browser 真实浏览器验收。后续若想补一次端到端确认,等真实升级流程触发一次即可(dev 实例的 Vite HMR 已加载新代码)。`,
    `任务已完整交付,没有待办步骤:

**问题修复完成 → 已本地提交 → 工作区干净**

- 根因与修复:\`UpdateNotifier.tsx\` 的 \`shownKeyRef\` 将 installing 与 complete 的去重混用同一 key 空间,complete 阶段判同 key 短路,升级成功 Modal 永不弹出。已改为 module 级 \`shownFinalModals\` Set 独立拦截 final Modal(兼防双挂载/StrictMode 重复),进度通知靠 antd 同 key 幂等
- 回归测试:\`UpdateNotifier.test.tsx\` 6 用例全过,\`tsc --noEmit\` 干净
- 提交:\`9c296ec\`(HRMSV3-ZN-WEBSITE#668 fix(zai)),未推送(仓库无 remote)
- ego-browser 验证任务空间已清理

后续如需要(需你明确指示我才会做):运行 \`pnpm release:patch\` 发版 0.3.18,或在下次真实升级时用 ego-browser 补一次端到端弹窗验收。`,
  ]

  it('三条真实完成总结都不再触发 nudge', () => {
    for (const text of threeRealSummaries) {
      expect(analyzeContinuationIntent(text).shouldNudge, text.slice(0, 40)).toBe(false)
    }
  })
})

describe('continuation nudge — 中文完成语与收尾标点', () => {
  it('中文完成总结(句号/感叹号收尾)不触发 nudge', () => {
    expect(analyzeContinuationIntent('任务已完成,工作区干净。').shouldNudge).toBe(false)
    expect(analyzeContinuationIntent('修复完成,已提交 9c296ec!').shouldNudge).toBe(false)
    expect(analyzeContinuationIntent('已完成全部工作,没有待办步骤。').shouldNudge).toBe(false)
    expect(analyzeContinuationIntent('全部搞定,可以收工了。').shouldNudge).toBe(false)
  })

  it('中文总结 + 紧跟的英文真实继续意图仍会 nudge', () => {
    // "完成。"后有明确英文信号 —— 不能被中文完成语兜底拦掉
    expect(analyzeContinuationIntent('第一处修复完成。Now install the next package.').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('阶段一完成。Now I will process the next file.').shouldNudge).toBe(true)
  })

  it('中文总结且无英文信号:保持原有不触发行为', () => {
    // opencc 信号体系不识别中文意图词,纯中文"接下来将继续"也无法检测 —— 现状即不触发
    expect(analyzeContinuationIntent('接下来我将继续处理第二个文件。').shouldNudge).toBe(false)
  })
})