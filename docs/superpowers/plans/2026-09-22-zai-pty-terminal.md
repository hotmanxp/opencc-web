# Plan — zai 分屏 Bash 面板换成 dsh 式持久 PTY 终端

- 日期：2026-09-22
- 状态：已完成（除真实浏览器验收待用户确认）
- Spec：`docs/superpowers/specs/2026-09-22-zai-pty-terminal-design.md`

## 范围（与用户逐项确认过）

| 决策点 | 结论 |
|---|---|
| 改哪一层 | **只改用户侧终端**（分屏 Bash 面板）。agent 侧 vendor `BashTool` 不动 |
| 进程模型 | **node-pty**（与 dsh 一致），非"child_process + 提示符哨兵" |
| 前端形态 | **xterm.js 真终端 + 多 tab**（截图那种 chip + ＋），替换原 REPL UI |
| shell 启动 | `zsh -i`，**读用户自己的 rc**（不接管 PS1） |
| PTY env | **透传完整环境**，不做白名单 |

## 任务与状态

| # | 任务 | 状态 |
|---|---|---|
| 0 | 安装并验证 `node-pty` + `@xterm/*`；`allowBuilds` / `onlyBuiltDependencies` 放行 node-pty 的 install 脚本 | ✅ |
| 1 | `src/shared/terminal.ts`（类型 + 上限 + zod schema） | ✅ |
| 2 | `services/terminal/shells.ts`（默认 shell 解析 + 候选发现） | ✅ |
| 3 | `services/terminal/PtySession.ts` + `TerminalFollower.ts` | ✅ |
| 4 | `services/terminal/TerminalService.ts`（每会话注册中心） | ✅ |
| 5 | `routes/terminal.ts` + 三处接线（`index.ts` 挂载 / `runtimeLifecycle` disposeAll / `agent.ts` 删会话 disposeSession） | ✅ |
| 6 | 服务端单测（PtySession / TerminalService / routes） | ✅ 28 用例 |
| 7 | 前端 `terminalApi.ts` / `useTerminalTabs.ts` / `TerminalView.tsx` / `terminalTheme.ts` / `BashTab.tsx` 重写 | ✅ |
| 8 | 前端单测 + REPL 回归 | ✅ 30 用例 |
| 9 | 真实浏览器验收 | ⏳ 待用户确认 |

## 验收证据（已完成部分）

### 单元 / 集成测试

```bash
pnpm --filter @zn-ai/zai test src/web/src/components/splitPane/ src/web/src/hooks/ \
                              src/server/services/terminal/ src/server/routes/terminal.test.ts
# → 31 files / 300 passed | 1 skipped
pnpm --filter @zn-ai/zai test src/web/src/components/splitPane/SplitPane.test.tsx \
                              src/web/src/hooks/useBashRepl.test.ts \
                              src/server/routes/bashRepl.test.ts \
                              src/web/src/components/MobileQuickDrawer.test.tsx
# → REPL 链路回归通过（REPL 未被改动）
pnpm --filter @zn-ai/zai exec tsc -b --noEmit          # 服务端/共享类型 clean
pnpm run build:web                                     # vite 打包 xterm + css 成功
```

`PtySession.test.ts` 的核心断言即本次需求验收点：真起 PTY，`export ZAI_PTY_VAR=server-test-42` 与 `cd /tmp` 之后，`echo "VAR=$ZAI_PTY_VAR PWD=$(pwd)"` 同时读到 `VAR=server-test-42` 与 `PWD=/tmp`。

### 真实服务端端到端（tsx 运行时 + 真 HTTP + 真 API）

```bash
pnpm --filter @zn-ai/zai dev -- --port 8121 --api-port 7722   # 8121/7722 为空闲端口
curl :7722/api/terminal/environment   # → available: true
curl -X POST :7722/api/terminal/create -d '{"sessionId":"smoke","id":"t-smoke","cols":90,"rows":24,"cwd":"/tmp"}'
# → {"shell":{"path":"/bin/zsh","name":"zsh","args":["-i"]}, "state":"running", ...}
curl -N :7722/api/terminal/t-smoke/events?sessionId=smoke   # 首帧 snapshot，随后 output
# 写 export ZAI_SMOKE=ok-42 / cd /tmp / echo RESULT=$ZAI_SMOKE PWD=$PWD
# → SSE 输出含 "RESULT=ok-42 PWD=/tmp"；提示符为用户自己的 "liangxuechao572@KXQPX47HLJ /tmp %"
curl -X POST :7722/api/terminal/t-smoke/close             # → 该 zsh 进程 pid 消失（pgrep 验证）
curl :7722/api/terminal/list?sessionId=smoke              # → []
curl -X POST :7722/api/terminal/create (同 id)            # → 409
kill -INT <server>                                        # 服务退出后 pgrep "zsh -i" 无残留
```

## 待办：真实浏览器验收（ego-browser）

按 AGENTS.md，执行前先问用户；**不要 kill 920x 端口**（那是正式服务）。用空闲端口起独立实例：

```bash
lsof -i :8121 -i :7722   # 先确认空闲
pnpm --filter @zn-ai/zai dev -- --port 8121 --api-port 7722
```

清单：

1. `/agent` → 分屏 `Bash` tab：看到**用户自己的** zsh 提示符（不是 `dsh>` 那种）。
2. `export FOO=bar` → `echo $FOO` = `bar`（状态保持）。
3. `cd /tmp` → `pwd` = `/tmp`（CWD 保持）。
4. `＋` 开第二个 tab：两个 shell 互相独立（各自的 `$FOO` / pwd 不串）。
5. `vim`（或 `htop`）能全屏渲染 —— 真 TTY 的硬证据。
6. 关掉一个 tab：`pgrep -fl "zsh -i"` 数量减一（shell 真的被杀）。
7. 拖动分屏宽度：xterm 按新尺寸 reflow（`getComputedStyle` / rect 像素证据）。
8. 刷新页面：tab 重新出现并重连到**同一个** pid 的 shell（进程未重启）。

## 回滚

```bash
git revert <commit> && pnpm install   # 原生模块需按回退后的 package.json 重装
```