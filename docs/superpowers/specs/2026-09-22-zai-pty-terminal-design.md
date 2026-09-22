# Spec — zai 分屏 Bash 面板：改成 dsh 式持久 PTY 终端（xterm.js + 多 tab）

- 日期：2026-09-22
- 状态：已实现
- 参考实现：`deepseek-harness`（下称 dsh）`packages/api/terminal-controller` + `packages/client/ui-sidebar-terminal`
- 相关代码：`packages/zai/src/server/services/terminal/*`、`packages/zai/src/server/routes/terminal.ts`、`packages/zai/src/shared/terminal.ts`、`packages/zai/src/web/src/hooks/useTerminalTabs.ts`、`packages/zai/src/web/src/components/splitPane/{BashTab,TerminalView,terminalTheme}.tsx|ts`、`packages/zai/src/web/src/lib/terminalApi.ts`

## 0. TL;DR

分屏 Bash 面板从「输入框 + 输出流」的伪终端换成**持久 PTY 会话 + xterm.js 真终端 + 多终端 tab**：

- 每条命令不再 `spawn(sh -c <cmd>)`，而是**一个长期存活的交互式 shell**（node-pty），因此 `export` / `alias` / shell 函数 / 后台作业 / `cd` **全部跨命令保持**；
- 真 TTY ⇒ vim / htop 这类全屏程序、行编辑、Tab 补全、Ctrl-C 语义、窗口尺寸联动都能用；
- 多 tab：每个 tab 是一个独立 shell，服务端按 `sessionId` 持有，刷新后按 `GET /api/terminal/list` 重连到**同一批活着的进程**。

## 1. 动机

改造前（`packages/zai/src/server/services/repl/ReplSession.ts:148`）：

```ts
child = spawn(shell.cmd, [...shell.prefixArgs, command], { cwd: targetCwd, env: filterEnv() })
```

命令与命令之间没有任何会话状态。`cd` 只能靠前端把 `cwd` 当请求参数回传（`ExecRequest.cwd`）——本质是"无状态执行的补丁"；zn-agent-core 侧还有 `bashCwdWrap` 用 `pwd -P >| tmpfile` 尾钩子把 cwd 存回 `CwdStore`，也是同一类补丁。输出走 `FORCE_COLOR=1` 硬造 ANSI，没有 TTY 语义。

需求（用户原话）：**参考 dsh 的 bash 实现，把当前项目同步改造成相同实现**，核心诉求是 **状态与 CWD 的保持**。

## 2. 架构

```
BashTab（tab strip：chip + ✕ + ＋ / shell 菜单）
  └─ TerminalView（xterm.js + FitAddon）        ← 只有可见 tab 持有 SSE
        ↕ fetch /api/terminal/*   +   GET /api/terminal/:id/events (SSE)
TerminalService（每 sessionId 一组 owner：terminals + closedIds）
  └─ PtySession（node-pty）
        ├─ @xterm/headless  累积屏幕状态（用于重连快照）
        └─ @xterm/addon-serialize  产出 snapshot 帧
```

### 2.1 服务端

| 文件 | 职责 |
|---|---|
| `src/shared/terminal.ts` | 前后端共享类型 + `TERMINAL_LIMITS` 常量 + 请求 zod schema |
| `src/server/services/terminal/shells.ts` | 默认 shell 解析与候选发现（`which` + 可执行校验 + realpath 去重） |
| `src/server/services/terminal/PtySession.ts` | 一个 PTY 会话：spawn / write / resize / rename / close / follower 广播 + 懒加载原生模块 |
| `src/server/services/terminal/TerminalFollower.ts` | 单 follower 的有界输出队列（慢消费者显式断开，绝不阻塞 PTY） |
| `src/server/services/terminal/TerminalService.ts` | 每会话注册中心：create（幂等）/ list / write / resize / rename / close / disposeSession / disposeAll |
| `src/server/routes/terminal.ts` | REST + SSE 路由，挂在 `app.use('/api', terminalRouter)` |

上限与 dsh 对齐（`TERMINAL_LIMITS`）：`maxTerminals 8`、`maxCols 500`、`maxRows 200`、`maxInputBytes 64 KiB`、`maxBufferedBytes 2 MiB`、`scrollback 1000`、`disposeGraceMs 1000`。

### 2.2 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/terminal/environment?cwd=` | 能力与上限（含 `available` = node-pty 是否可加载） |
| GET | `/api/terminal/shells` | 已安装 shell（默认 shell 排第一） |
| GET | `/api/terminal/list?sessionId=` | 该会话保留的终端（含已退出的） |
| POST | `/api/terminal/create` | `{sessionId, id, cols, rows, shellPath?, cwd?}` → info（同 id 幂等） |
| GET | `/api/terminal/:id/events?sessionId=` | SSE：首帧 `snapshot`，随后 `output` / `state`（+ 断开通知 `error`） |
| POST | `/api/terminal/:id/write?sessionId=` | `{data}` |
| POST | `/api/terminal/:id/resize?sessionId=` | `{cols, rows}` |
| POST | `/api/terminal/:id/rename?sessionId=` | `{title}` |
| POST | `/api/terminal/:id/close?sessionId=` | 杀进程并关闭身份（幂等） |

错误码：`400` 参数非法 / 输入超长 / shell 不存在，`404` 未知终端，`409` id 已关闭 / 超上限，`503` node-pty 不可用（带 `hint`）。

### 2.3 前端

| 文件 | 职责 |
|---|---|
| `src/web/src/lib/terminalApi.ts` | REST client（`TerminalApiError` 带 `status` / `hint`）+ SSE URL |
| `src/web/src/hooks/useTerminalTabs.ts` | tab 集合（服务端为唯一真相）/ 选中 id 持久化 / create / close / rename / applyInfo |
| `src/web/src/components/splitPane/TerminalView.tsx` | xterm + FitAddon + SSE 消费 + 合帧写屏 + 尺寸夹取上报 |
| `src/web/src/components/splitPane/terminalTheme.ts` | 从 zai CSS 变量 + `data-theme` 派生 xterm `ITheme` |
| `src/web/src/components/splitPane/BashTab.tsx` | strip（chip / ✕ / ＋ / 双击改名）+ 状态与空态分支 |

## 3. 关键设计决策

1. **不移植 dsh 的就绪探测 / sanitizer / send 生命周期**。dsh 的 `terminal-bash` 需要判断"命令跑完了吗"（exact stdin-wait / prompt marker / inferred_idle 三档 + `TerminalSanitizer` + OSC 133 标记），那是给**模型侧工具**（send → 等就绪 → 读有界输出）用的。浏览器终端把 PTY 原始字节直通给 xterm，不需要这套。
2. **读用户自己的 rc**（POSIX 起 `zsh -i`），**不**接管 PS1。dsh 用 `bash --noprofile --norc -i` + 自装 `PS1`/`PROMPT_COMMAND` 正是为了上面的就绪探测；浏览器终端要的是用户熟悉的环境（oh-my-zsh 主题、别名、补全、nvm/pyenv/PATH）。用户已确认。
3. **PTY 透传完整 env**，不做 `ReplSession.filterEnv()` 那种白名单。白名单是为"不把 API key 递给不可信命令"；交互式 shell 本来就该拿到完整登录环境（否则 nvm/pyenv/PATH 全是残的），与 dsh 一致。用户已确认。
4. **只有可见 tab 持有 SSE**。HTTP/1.1 同源并发连接有限（agent 流 + bash-tasks 流已占数条），8 个 tab 各开一条会打爆预算。切 tab 关旧开新，新连接首帧就是整屏 `snapshot`，画面立即恢复（dsh 的 pattern 也是切回可见才 fit + 恢复）。
5. **服务端是 tab 集合的唯一真相**。不做 dsh 的 `TerminalBindings`（localStorage contentId → WebTerminalId）、`TerminalCloseRequests`（崩溃重试队列）与 `TerminalRecovery`（进入会话时恢复未认领终端）：刷新后 `GET /list` 重新播 tab 并重连同一批 PTY 即可，localStorage 只记"当前看的是哪一个"。
6. **无 attachment 独占写控制**。dsh 区分 controller（可写）与 follower（只读）以支持多窗口；zai 是 localhost 单窗口，多个 follower 都可写、resize 后写覆盖即可。
7. **慢 follower 断开而非阻塞**。单个 follower 的待发队列超 2 MiB 就断开该连接并推一条 `error` 帧（客户端重连换新快照），绝不让慢客户端把 shell 卡在写 stdout 上。
8. **卸载不杀进程**。收起分屏 / 切 tab / 刷新浏览器都保留 shell；只有 `close`（关 tab）才 SIGTERM → 宽限 1s → SIGKILL。与 dsh 的 "collapse 不杀、reload 重连同一进程" 一致。
9. **进程回收三处接线**：关 tab（`/close`）、删会话（`DELETE /api/agent/sessions/:id` → `disposeSession`）、进程退出（`runtimeLifecycle.closeServer` → `disposeAll`）。没有这三处会留一堆没人认领的 zsh。

## 4. Non-goals（明确不做）

- dsh 的就绪三档（stdin_read / prompt marker / inferred_idle）、`TerminalSanitizer`、OSC 133 标记、send 生命周期、headless xterm 的输入回环。
- `retain` 窗口引用计数、`unattendedTimeoutMs` 空闲回收（`activityPollIntervalMs` 进程探活）、`TerminalCloseRequests` 崩溃重试队列、read-only/writable 双花名册。
- OSC 4/104/10/110/111/112 调色板透传与光标格 WCAG 对比度校正（主题只跟随 zai 的 CSS 变量 / `data-theme`）。
- **agent 侧 vendor `BashTool`（`zn-agent-core`）与 `bashCwdWrap` 不动**：agent 的每次 bash 调用仍是独立进程 + cwd 尾钩子。这也是本次**不需要 `build:core`** 的原因。
- 移动端 `/m` 的快捷 Bash（`MobileQuickDrawer`）继续走 `/api/bash-repl`。
- 命令历史 / top10 建议 / 命令 blocklist（仍属于 REPL 链路）。
- 全屏程序的原生窗口尺寸联动：超过 `maxRows` 按上限夹取，不做"缩小字号适配"。

## 5. 依赖与构建

| 包 | 位置 | 用途 |
|---|---|---|
| `node-pty@^1.2.0-beta.15` | dependencies | PTY 分配（tarball 自带 `prebuilds/<platform>-<arch>`，无需本地编译） |
| `@xterm/headless@^6.0.0` | dependencies | 服务端屏幕状态累积（快照用） |
| `@xterm/addon-serialize@^0.14.0` | dependencies | 屏幕序列化（`snapshot` 帧） |
| `@xterm/xterm@^6.0.0` | devDependencies | 浏览器终端渲染（vite 打进 bundle） |
| `@xterm/addon-fit@^0.11.0` | devDependencies | 容器尺寸 → 行列数 |

- pnpm 默认拦 install 脚本，`node-pty` 必须加进 `pnpm-workspace.yaml` 的 `allowBuilds` 与根 `package.json` 的 `pnpm.onlyBuiltDependencies`，否则装出的是 load 不了的 `pty.node`。
- 服务端不做 env 白名单、不接管 prompt ⇒ 用户自定义 `.zshrc` 里的输出会正常出现在终端里（预期）。
- dsh 的 `patches/node-pty@1.2.0-beta.15.patch` **不需要**：那是它们打包 exe 时自定义 spawn-helper 路径用的。

## 6. 测试策略

| 文件 | 覆盖 |
|---|---|
| `src/server/services/terminal/PtySession.test.ts` | 真 PTY：snapshot 先行、**状态与 CWD 跨命令保持**、resize/rename 广播、close 真杀进程（pid 消失）、幂等 close、超长输入被拒、自然退出后 follow 不悬挂 |
| `src/server/services/terminal/TerminalService.test.ts` | create 幂等、closedIds、maxTerminals、未知 shell、list 会话隔离、disposeSession |
| `src/server/routes/terminal.test.ts` | REST 全量 + 裸 http 读 SSE（首帧 snapshot → 收到 output）、断开不杀终端、503 映射、409/404/400 |
| `src/web/src/hooks/useTerminalTabs.test.ts` | 加载/自动新建/错误与 hint/会话隔离/create/close/rename 乐观回滚/applyInfo/retry |
| `src/web/src/components/splitPane/TerminalView.test.tsx` | 帧 → xterm 调用、键盘 → `/write`、尺寸夹取 → `/resize`、不可见不开流、卸载不 `/close`、断线重连 |
| `src/web/src/components/splitPane/BashTab.test.tsx` | strip 交互（切换 / ＋ / ✕ / 双击改名）、状态标签、不可用与错误态 |

**真浏览器验收（ego-browser）**：见 plan 的验收清单（用户自己的提示符、`export`/`cd` 保持、多 tab 独立、vim 全屏、关 tab 杀进程、拖分屏 reflow）。happy-dom 不渲染真实 CSS/字体，xterm 的像素级表现必须在真实浏览器里看。

## 7. 已知风险与后续

- **node-pty 是原生模块**：跨平台由 tarball 内 prebuild 覆盖（darwin/linux/win32 × arm64/x64）。极端平台需本地编译链；`/api/terminal/environment` 的 `available=false` + `hint` 是给这种情况的诚实降级（面板显示原因，不做 REPL 兜底）。
- **回滚时**：`git revert` 后 `pnpm install` 需重装（原生模块），并注意 `pnpm-workspace.yaml` 的 `allowBuilds` 会一起回滚。
- **后续可做**：OSC 调色板透传、非活动 tab 的实时输出（需改 WebSocket 多路复用，`ws` 已在 devDependencies）、移动端迁移到同一套终端、agent 侧 `BashTool` 复用 PtySession（那会引入 `build:core` 需求）。