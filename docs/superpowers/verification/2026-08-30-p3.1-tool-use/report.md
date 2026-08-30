# P3.1 tool-use e2e — repl 链路 vendor 工具调用验证

**日期**: 2026-08-30 19:23
**目的**: 在 `ZAI_CORE_RUNTIME=repl` 下,从 `/agent` 真实浏览器操作,验证 LLM 能经 ReplRuntime → vendor `query()` → vendor 工具(Bash / Read)→ 真实 shell / fs 结果回灌 UI,完成工具调用 round-trip;同时验证 P3 路径两处修复(`/help` 不 crash、ESC 可中断)。

**环境**:

- `feat/regression-tests` HEAD:`7cc0aafc` (fix review round 1,`dffa125d` 之上)
- 浏览器:ego-browser(ego lite 0.4.7.3)Chromium,IPv6 bind `http://[::1]:8103/agent`(IPv6-only,sandbox bind workaround)
- zai dev:后台启动中(PID 31424,已运行 12+ 分钟),`tsx ... src/cli/index.ts dev -- --port 8103 --api-port 7716`
  - 启动日志确认:`[initAgentRuntime] repl runtime 就绪(shared OpenccRuntime wired)`
  - Vite 8103 / Express 7716(IPv6 vite bind `[::1]:8103`,IPv4 express bind `127.0.0.1:7716`)
  - 此 dev 实例未设 `ZAI_DEBUG=1`(与 p3.1-t1 报告不同),server stdout 仅有 vite client 警告,无 server-side SSE 日志;本验证以 DOM 端 snapshotText/bodyText 作为主证据
- 模型:`MiniMax-M2.7-highspeed`(session 内 model 切换后);p3.1-t1 用 `MiniMax-M3`
- session id:sess-1788088508100-b19t4gxs(Test 1/2)、sess-1788088810632-3joc3zom(Test 3)、后续会话(Test 4)

## Test 1: Bash tool

- Result: **PASS**
- Evidence:
  - tool_use block visible:`1 个工具调用 · Bash` 折叠条 → 展开后看到 `Bash` chip + `已完成` 状态 + 描述 `List first 3 items in /tmp`
  - 命令:`ls /tmp | head -3`
  - 更多参数:`{ "description": "List first 3 items in /tmp" }`
  - 工具结果:`8c8d2f84.diff\nagent-on-top.png\nagent-tui-launch.log`(真实 `/tmp` 内容)
  - final assistant message:`8c8d2f84.diff agent-on-top.png agent-tui-launch.log`(verbatim echo)
  - any error:无,UI 状态返回 `就绪`,无 `runtime.error`
- Screenshot:captureScreenshot 调用 CDP `Page.captureScreenshot` 超时未产出(ego lite 0.4.7.3 偶发);以 DOM snapshotText + bodyText 文本证据替代
- 备注:从 LLM thinking "The user wants me to run a simple bash command and report the result verbatim." 可见 LLM 主动选用 Bash 工具,工具调用 → vendor execution → 回灌 UI 链路完整闭环。

## Test 2: FileRead tool

- Result: **PASS**(附:LLM 自主 fallback 到 Bash 因 macOS 无 `/etc/hostname`,体现真实工具链)
- Evidence:
  - tool_use 1 — Read 工具:
    - 文件:`/etc/hostname`
    - 结果:`File does not exist. Note: your current working directory is /Users/ethan/code/opencc-web/packages/zai.`(真实 vendor Read 错误回传)
    - 状态:`已完成`
  - tool_use 2 — Bash 工具(LLM 自动 fallback):
    - 命令:`hostname`
    - 更多参数:`{ "description": "Get system hostname" }`
    - 结果:`liangchaodeMac-mini.local`
    - 状态:`已完成`
  - final assistant message:`/etc/hostname 在 macOS 上不存在。用 hostname 命令查到结果:liangchaodeMac-mini.local`
  - any error:无(Read 工具返回"文件不存在"是 vendor 正常错误,LLM 优雅处理;非 UI runtime error)
- Screenshot:同 Test 1 超时未产出
- 备注:本次触发了 **2 个 vendor 工具调用** 且 vendor Read 的错误信息完整透传到 UI,LLM 也正确用 Bash 补救。这是 vendor tool-use round-trip 的强证据。

## Test 3: Slash command (`/help`)— P3 T1 fix

- Result: **PASS**
- Evidence:
  - 用户消息:`/help`(新 session,无 autocomplete 残留;首次重试时遇到 `/ai-first-engineering /help` 自动补全前缀问题,但本 session 已清空,二次提交时无污染)
  - assistant response:**无**(无 assistant 文本块,无工具调用)
  - UI 状态:提交后立即 `就绪`,无 `runtime.error`,无 crash
  - any error:无
  - 额外观察:无可见 toast / notification element(`[class*=notif|toast|message]` 0 命中);用户消息留在 chat 但不进入 LLM turn,这符合 P3 T1 "未知 slash command 不让 runtime panic,turn 干净结束" 的修复预期
- 备注:首次测试 `/help` 撞到 input autocomplete 选中了 `/ai-first-engineering` skill 自动补全,导致 LLM 实际收到 `/ai-first-engineering /help` 并解释了该 skill 内容。重新开 session 后,`Escape` 关闭 autocomplete 状态下 `/help` 单独提交,行为符合 spec。

## Test 4: ESC interrupt — P3 T2 fix

- Result: **PASS**
- Evidence(2 次 ESC 验证,均成功):
  - **验证 A**:提示 `count all .ts files under /Users recursively and tell me the total`
    - 提交前状态 `busy=true / hasEsc=true`(状态条 `对话中… (0s) · esc 中断`)
    - focus 在 TEXTAREA,直接 `pressKey('Escape')`
    - 1.3s 后 UI 回到 `就绪`,仅用户消息残留,无 assistant 响应,无 `runtime.error`
  - **验证 B**:提示 `list all files under /private recursively`
    - 提交 2s 后用 CDP `Input.dispatchKeyEvent` raw keyDown/keyUp 模拟物理 ESC
    - 1.1s 后 UI 回到 `就绪`,行为一致
  - any error:两次均无
- 备注:UI 状态条 `esc 中断` 提示稳定出现,印证 ESC 快捷键被运行时监听并由 P3 路径的 ESC 处理逻辑触发 session 中断;interrupt 路径未引入 panic 或 runtime error。

## Summary

- Tests run: 4
- Passed: 4
- Failed: 0
- Skipped: 0
- Conclusion: **`ZAI_CORE_RUNTIME=repl` 下,ReplRuntime → shared OpenccRuntime → vendor `query()` → vendor 工具(Bash / Read)→ 真实执行 → 结果回灌 UI 的完整链路在真实浏览器中可工作。LLM 能选工具、读 /etc/hostname 失败后自动 fallback Bash 调 hostname 命令,工具描述 / 命令 / 参数 / 结果四要素全部正确渲染在 `/agent` UI。P3 两处修复(`/help` 不 crash、ESC 可中断)在 `/agent` UI 上行为符合预期。**

### 补充观察(非测试)

- captureScreenshot 在 0.4.7.3 ego lite 上持续 CDP 超时(本会话与本次未尝试 fix 的 SKILL install 不在范围内);本验证以 `snapshotText()` 语义树 + `js(...).bodyText` 文本证据替代,已包含 tool_use / tool_result / final message / 状态指示器四类关键证据。
- input autocomplete 在 `/` 开头的命令上可能误选 skill 名称(`/ai-first-engineering`),导致 `/help` 被拼成 `/ai-first-engineering /help`。这是 UI 行为,不影响 P3 修复本身;生产路径用户输完命令按空格或等待补全消失即可。
- 2 次 Test 4 ESC 后,UI 干净回到 `就绪`,无 zombie 状态;但 P3 spec 未规定 interrupt 后 user message 是否撤回 — 当前实现是 **保留 user message 但不进入 LLM turn**,本验证认为合理。
