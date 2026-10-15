# opencc Mods 同步到 vendor + mainAgent 改写可行性评估

> **日期**：2026-10-06
> **来源仓**：`/Users/ethan/code/opencc` 分支 `main-opencc`，HEAD `39eef3cc feat(mods): opt local-jsx commands into headless sessions`
> **同步目标**：`packages/zn-agent-core/src/opencc-src/`（下称 vendor）
> **状态**：同步已完成并通过全部闸门；**§6「mainAgent 开 mods 槽」已落地**（原"不建议改写"结论已被这次实现取代，见 §6.0 的结论修正）；**§7「TUI 能力面移除」已落地**（zai 是 Web UI，`ui.pane` / `ui.render` 整块删除）

---

## 一、opencc 侧的 mod 是什么

`src/mods/`，7 个非测试文件 1,676 行 + 2 个内置 mod。是 opencc **自研**的「用户写 JS 扩展自身」机制（不是上游 Claude Code 的 Mods —— 上游那套跑在 Bun SFX + per-plugin Worker 上，opencc 产物是 Node ≥22 的 `.mjs`，结构上无法复制）。

| 文件 | 行数 | 职责 |
|---|---|---|
| `manifest.ts` | 40 | `opencc-mod.json` 的 zod schema（name/version/description/entry） |
| `validate.ts` | 209 | 加载器安全围栏：入口扩展名、realpath 越界、体积上限、import 白名单 |
| `registry.ts` | 166 | 生命周期状态 + 熔断计数 + 工具池变更信号 |
| `engine.ts` | 636 | `ctx` 构造（能力面）+ notice/status/pane 三通道 + mod 工具/命令构建 |
| `dispatch.ts` | 256 | `next()` 链 + 两档 tier + 流式进度 |
| `hooks.ts` | 255 | 发现/加载/卸载/reload + 熔断接线 |
| `builtin.ts` | 103 | 第一方 mod 的 in-memory 通道（对标上游 `registerScan`） |

### 能力面（`ctx`）

```ts
interface ModContext {
  on(event, matcher?, handler)      // 7 个事件：PreToolUse/PostToolUse/
                                    // UserPromptSubmit/SessionStart/SessionEnd/Stop/Notification
  registerCommand(spec)             // 'local' | 'local-jsx' 两种形态
  registerTool(spec)                // MCPTool 形状，名字前缀 mods_<mod>_<tool>
  ui: { notice; log; status; pane; closePane; notify }
  fs?: { read; write; list; exists } // 仅 settings.mods.authorized 名单内可见，cwd + mod 根双围栏
}
```

### 两个关键设计

1. **两档 tier**：`HookCallback.modChain` 标记把 mod composite 从扁平并行批次提出，mod 链作**外层**跑，terminal `next()` 执行核心子集 → handler 对核心管线有真 before/after 语义。无 mod 时该路径完全不进入。
2. **同进程无隔离**（上游用 Worker/vm realm）：靠逐 handler `try/catch` + 归因 + **熔断**（连续 5 次失败自动卸载）兜底。这是明知的残余风险，opencc 文档里标为 R8。

---

## 二、同步了什么（vendor 侧）

### 已落地

**新增 `src/opencc-src/mods/`** —— 7 个核心文件逐字同步（去掉测试与两个 TUI 内置 mod）。

**7 处宿主接缝**：

| 文件 | 改动 | 同步自 |
|---|---|---|
| `bootstrap/state.ts` | +`unregisterHookMatchers()` | 同名新函数 |
| `types/hooks.ts` | +`HookCallback.modChain` / +`ModChainEntry` | 同名新类型 |
| `utils/hooks.ts` | `executeHooks` 两档 tier 包裹 | mods-p1 同一处 diff |
| `utils/settings/types.ts` | +`mods.authorized` schema | 逐字 |
| `utils/skills/skillChangeDetector.ts` | +`notifyCommandsChanged()` | 逐字 |
| `tools.ts` | `assembleToolPool` 并入 mod 工具 | 同一处 diff |
| `commands.ts` | `getCommands` 尾部 `appendModCommands()` | 同一处 diff |

**启动接线**（关键，opencc 没有的一步）：`server/createHeadlessContext-impl.ts` step 10b 显式 `await loadMods()`。

> **为什么必须显式调**：opencc 把 `loadMods()` 挂在 `processSessionStartHooks` 里，而那是 `main.tsx` 的路径。zai 走 headless 运行时（`createOpenccRuntime`），**从不经过** `processSessionStartHooks` —— 不补这一句，mod 永远不会被加载。这是本次同步里唯一"opencc 源码里不存在、必须自己加"的接缝。

**公共导出**：`src/bundle-entry.ts` 导出 13 个 mods 符号（管理面 + 命令/工具池信号 + 类型），`scripts/bundle-opencc.ts` 的 `DTS_PATH_REWRITE` 加 5 条镜像（vendor 被 tsc 排除，无独立 d.ts）。

### 刻意没同步

| opencc 侧 | 原因 |
|---|---|
| `builtin/diffMod.ts` | 注册 `ctx.ui.pane` 实时面板 = ink 组件。zai 无 TUI，且终端 UI 已被 `stub-ui-sources.ts` 就地 stub 成 `return null` |
| `builtin/handoffMod.tsx` | `local-jsx` 交互式 JSX 文档选择器。zai 的 slash 命令走自己的 registry（`services/commands/slashList.ts`），不消费 vendor `getCommands()` 的 local-jsx 分支 |
| `ModPaneArea` / `ModStatusLine` / REPL 接线 | 纯 TUI 渲染 |
| `commands/mods/`（`/mods` 管理命令） | zai 的 slash 列表有自己的装配路径，这条命令进不去 |

**`builtin.ts` 的通道本身完整保留**（`registerBuiltinMod` / `loadBuiltinMods`），只是固定清单留空 —— 第一方功能想用 mod 形态实现时 import + register 即可，不用再动加载器。

---

## 三、验证结果

| 闸门 | 结果 |
|---|---|
| `tsc -p tsconfig.typecheck.json` | **0 error** |
| `pnpm run build:core` | 通过（首轮 `DTS_PATH_REWRITE` 缺 5 条已补） |
| `verify-server-types-self-contained` | OK |
| core 单测全量 | **1180 passed / 1 skipped**，163 文件 |
| bundle 真实导入 | `import('./dist/opencc-core.mjs')` 成功，13/13 mods 符号在位 |
| mods 目录解析 | `getModsDirectory()` → `/Users/ethan/.zai/mods` ✅ |

**端到端功能实测**（真写一个磁盘 mod 跑完整生命周期）：

```
loadMods()            → [{"name":"hello","ok":true}]
mod tools             → mods_hello_ping
mod commands          → hello:hello [local]
tool call             → {"data":"pong"}
command call          → {"type":"text","value":"hi from mod"}
unloadMod('hello')    → true
after unload          → tools: 0  commands: 0
```

**安全围栏实测**（三个非法 mod）：

| 攻击形态 | 结果 |
|---|---|
| `entry: "./register.ts"` | ✅ 拒绝 —— `entry must be a .js or .mjs file` |
| `import axios from 'axios'` | ✅ 拒绝 —— `bare module specifier "axios" is not allowed` |
| `export from '../../../../etc/hosts'` | ✅ 拒绝 —— 但**是 Node 抛的，不是围栏** |

第三条要说清楚：`validate.ts` 的 import 扫描**只拒裸 specifier，相对路径是放行设计**（opencc 文档明说："defense against accidental dependency, not a security boundary"）。所以 `../` 逃逸靠的是 Node 自身解析 + 同进程信任模型，不是 mod 围栏。这是**忠实同步上游的既有残余风险**，不是本次引入的缺陷 —— 但 zai 的威胁模型要重新评估一遍（见 §5）。

---

## 四、mainAgent 能否用 mod 体系改写 —— 结论：**不建议**

### 现状

`server/mainAgents.ts` + `agentRegistry.ts`，7 个内置 agent（default / office / agent-creator / task-factory / task-intake / task-intake-quick / weixin），三个插槽：

```ts
interface MainAgentConfig {
  name: string
  description: string
  systemPrompt?: (origin: string[]) => string[]           // 提示词数组前置/替换
  tools?: (origin: Tool[]) => Tool[]                      // 工具池过滤/追加
  mcp?: (origin: Record<string, ScopedMcpServerConfig>) => ...  // MCP 配置改写
}
```

外置 agent 走 `~/.zai/main-agents/*.js`，`loadUserAgents()` 扫目录 import。

### 三条硬阻塞

**① 插槽模型与 mod 能力面几乎不重叠。**

mainAgent 的核心是**按会话身份替换 systemPrompt + 收窄工具池**。mod 的 `ctx` 里**没有**任何"替换提示词"或"按会话改配置"的原语 —— `registerTool` 是往全局工具池加工具，不是按 session 收窄；`on('SessionStart')` 拿到的是事件流，没有"把这一轮的 systemPrompt 换成 X"的入口。

反向看，mainAgent 需要的三种形状 mod 一个都不提供：没有 per-session 状态绑定（`registryAgent(sessionId, agentId)`）、没有"origin → new"的纯函数槽、没有 mcp 槽。

**② mod 的安全模型与 mainAgent 正好相反。**

| | mainAgent | mod |
|---|---|---|
| 信任 | 第一方代码 + 用户自己写的配置 | 第三方 JS，同进程无隔离 |
| 能力 | 完整系统权限（在 vendor 内直接 import） | 刻意收窄，`fs` 需白名单 |
| 失败模式 | 启动期加载失败 → 回落 default | 连续 5 次崩 → 自动熔断卸载 |

把第一方 agent 降级成 mod，是**拿掉安全边界换一层用不上的抽象**。而 mod 那套熔断/围栏/白名单对第一方代码纯属噪音。

**③ 会话隔离模型冲突。**

`createOpenccRuntime-impl.ts:189` 有一条 zai patch 明确记录：tools 槽**不能**在 runtime 全局应用，必须 per-engine 包闭包，否则"不同会话各自恢复的 agent 会互相污染工具池"。mod 的 `registerTool` 是**进程级全局**的（`getModTools()` 无 session 维度）。直接改写会把这个刚修好的 bug 原样带回来。

### 那 mod 体系在 zai 侧的正确定位

不是"替换 mainAgent"，而是**两者互补**：

```
用户写 ~/.zai/main-agents/*.js  →  换身份（systemPrompt / tools / mcp）
                                  ↘ 第一方、per-session、强约束
用户写 ~/.zai/mods/<name>/       →  扩展行为（事件拦截 / 加工具 / 加命令）
                                  ↘ 第三方、进程级、可熔断
```

一个具体收益：现在 `mainAgents-agentCreator.ts`（386 行）教模型怎么写外置 agent 文件。如果再加一个"教模型怎么写 mod"的 agent，`registerTool` 那套 MCPTool 形状说明可以被复用 —— **这才是 mod 体系对 mainAgent 的实际增益：它是 mainAgent 的一个实现细节的更好素材，不是替代品。**

### 如果仍要推进，最小可行路径

不要动 7 个内置 agent。只做**新增**，让 mod 成为外置 agent 的一种写法：

1. 新增一个内置 agent `mod-author`，systemPrompt 讲 mod 的 `ctx` 契约（现有 agent-creator 的复制-改写范式）
2. 保留 `~/.zai/main-agents/*.js` 原样（不迁移、不破坏兼容）
3. `MainAgentConfig` 加一个可选 `mod?: string` 字段 —— 指一个 mod 名，`systemPrompt` 槽从该 mod 拉取提示词片段

第 3 步是唯一需要设计的接缝，且必须在 `createEngine` 的 per-session 闭包里解析（不能走 `getModTools()` 那条全局路）。收益不大，成本不低。

> **本节已被 §6 取代**：第 3 步已实现，且实现方式与当初设想的不同 —— 不是"指一个 mod 名拉提示词"，而是加了一个**完整的 `mods` 白名单槽**。见下。

---

## 五、遗留风险

| ID | 风险 | 说明 |
|---|---|---|
| M1 | **同进程无隔离** | mod 与 vendor 共享进程与 `STATE` 单例。逐 handler try/catch + 熔断只护 handler 抛错，**护不住 mod 改 `STATE` 或 process 全局**。opencc 是 CLI（崩了就退出），zai 是长驻服务（崩了影响所有会话）—— **同一份代码在 zai 的风险等级更高**，建议 `~/.zai/mods` 默认不存在，需要时按需开 |
| M2 | 相对路径 import 放行 | `validate.ts` 只拒裸 specifier（见 §3 实测第三条）。若要收紧，需在 vendor 侧加 realpath 围栏 —— 但这会与 opencc 产生分叉，破坏 per-file 同步 |
| M3 | 熔断阈值硬编码 5 | `registry.ts` 的 `MOD_BREAKER_THRESHOLD`，无 settings 开关。误伤时只能改代码 |
| M4 | zai 侧无 `/mods` 管理面 | opencc 有 `/mods`（列表/reload/unload），同步时按 §2 刻意跳过。管理能力目前只能走 `bundle-entry` 导出的 `reloadMods()` / `unloadMod()`，需 zai-server 自己做 HTTP 封装 |
| M5 | 围栏是防手滑不是防攻击 | mod 可用 `process` / `globalThis`（同进程）。文档已明说，但 zai 引入第三方 mod 前应重新确认可接受 |

---

## 六、同步纪律

`src/opencc-src/mods/` 是**纯新增目录**，opencc 上游无同名文件 → 不产生 per-file 同步冲突。7 处宿主接缝的改动都加了 `zai patch (2026-10-06, mods 同步)` 标注 + 指回 opencc 源位置，便于后续 `git apply --3way` 逐处重放。

**不建议**把 `src/mods/` 列入同步名单（opencc 文档 §1.3 建议路线 B）—— 理由与 opencc 一致：自研部分每次上游变更都要手工重做。

---

## 六、mainAgent 开 `mods` 槽（已实现）

> §4 的结论是「不建议改写」。这一节记录实际做出来的东西 —— 它**修正**了 §4 的
> 三条阻塞中的第 ① 和第 ③ 条，但没有推翻「不把 mainAgent 整体改写成 mod」这个结论。
> 两者不矛盾：§4 反对的是"取代"，这里做的是"开槽共存"。

### 6.0 结论修正

§4 说「能力面不重叠」「会话隔离冲突」，这两条在**开槽**方案下不再成立：

| §4 的判断 | 开槽后 | 为什么 |
|---|---|---|
| ① 能力面不重叠 —— mod 的 `ctx` 没有"按会话收窄"的原语 | **已解决** | 宿主侧加门禁，不需要 mod 配合。mod 保持进程级注册，**可见性**由 host 按 sid 裁剪 |
| ③ 会话隔离冲突 —— `getModTools()` 是进程级全局 | **已解决** | 门禁以 `sessionId` 为键。这正是 2026-08-20 tools 槽踩过的坑，现在有单测守着（见 6.4） |
| ② 安全模型相反 | **仍成立** | 门禁是可见性控制，不是安全边界。mod 代码仍与宿主同进程 |

所以准确的结论是：**两者不是竞争关系，缺的是一个按会话裁剪 mod 可见性的接缝。补上它，mainAgent 就能用 mod 表达"这个身份要哪些扩展"。**

### 6.1 槽的定义

`MainAgentConfig` 加第四个插槽（`mainAgents.ts`）：

```ts
/** 内置 mod 白名单 —— 本会话启用哪些 mod(origin = 全部已加载 mod 名) */
mods?: MainAgentSlot<string[]>
```

语义三档，**与 opencc 原始行为零冲突**：

| 写法 | 含义 |
|---|---|
| 不设此槽 | 全部 mod 可见 = **opencc 原始行为** |
| `mods: () => []` | 本会话禁用所有 mod |
| `mods: () => ['diff']` | 只有 `diff` 可见 |

「不设 = 全部可见」这条很关键：7 个既有内置 agent 一个都没改（只有 office 主动写了 `[]`），所以默认路径零回归。

### 6.2 门禁实现

`mods/registry.ts` 新增 per-session 白名单表（`setSessionModGate` / `clearSessionModGate` /
`isModVisibleForSession` / `hasSessionModGate`），三个消费点各读一次：

| 消费点 | 改动 | 位置 |
|---|---|---|
| **工具池** | `getModTools(sessionId?)` 过滤；`assembleToolPool(perm, mcp, sessionId?)` 透传 | `mods/engine.ts`、`tools.ts` |
| **命令表** | `buildModCommands(sessionId?)` 跳过不可见 mod | `mods/engine.ts` |
| **事件 handler** | `runModChain(..., sessionId?)` 跳过不可见 mod 的 handler，仍走 `next()` | `mods/dispatch.ts` |

handler 侧的语义要说明白：被门禁挡掉的 mod **仍占 `next()` 链位**，只是不执行 —— 核心 tier
（`coreRunner`）的语义完全不变，mod 之间的相对顺序也不变。

`assembleToolPool` 顺带修了工具归属：新增 `modToolOwner` 映射（工具名 → mod 名），
过滤按归属而非解析 `mods_<mod>_<tool>` 前缀 —— 认不出归属的工具保守保留，
宁可多给一个也不误删宿主工具。

### 6.3 与 runtime 的接线

`createOpenccRuntime-impl.ts` 的 `createEngine` 里，按 sid 建一次门禁再算工具池：

```
createEngine(sid)
  ├─ applyModGate()          // 派发 agent 的 mods 槽 → setSessionModGate(sid, ...)
  ├─ engineComputeTools()    // computeTools(sid) → assembleToolPool(..., sid)
  └─ get commands()          // buildModCommands(sid)
```

**时序不能反**：必须先建门禁再算工具池，否则第一批工具算错。

`mods` 槽按契约是**同步**的（与 `tools` 槽同约束 —— `QueryEngine.tools` 要 sync 数组）。
代码里对 Promise 返回做了 fail-fast：检测到 async 就退化成"不设门禁"（= 全部可见），
宁可放行也不 crash。这是显式的决定，不是遗漏。

### 6.4 验证

新增 `test/unit/mods-sessionGate.test.ts`，13 个 case，覆盖三个消费点 × 三档语义：

- 三个消费点各自的白名单 / 空数组 / 未设槽
- **两会话互不污染**（`sess-A` 见 alpha、`sess-B` 见 beta、未设门的 `sess-C` 见全部）
  —— 这条直接对应 2026-08-20 tools 槽的污染 bug
- 未知会话不被误伤
- handler 跳过后核心 tier 照常执行
- `clearSessionModGate` 恢复全可见

全量闸门：

| 闸门 | 结果 |
|---|---|
| `tsc -p tsconfig.typecheck.json` | **0 error** |
| `build:core` | 通过 |
| core 单测全量 | **1193 passed / 1 skipped**（1180 + 13 新增） |
| 端到端（真 bundle + 两个真磁盘 mod） | 通过 |

端到端实测输出：

```
loaded: alpha,beta
--- 未设门禁(基线) ---   tools: mods_alpha_ping,mods_beta_ping   commands: alpha:a,beta:b
--- office 身份 (mods: []) ---  tools: (none)                     commands: (none)
--- 只启用 alpha ---     tools: mods_alpha_ping                   commands: alpha:a
--- 只启用 beta ---      tools: mods_beta_ping                    commands: beta:b
```

### 6.5 已用上的实例：office

`mainAgents-office.ts` 显式写 `mods: () => []`。

这不是功能开关，是**语义澄清**：office 要的是"确定的工具集"，白名单已覆盖全部需求；
将来若加载了行为型 mod（比如自动改写 Bash 命令的守卫），不写这一行它会对 office
会话也生效，而 office 用户并不知情。显式 `[]` 把这件事从"默认"变成"声明"。

`default` / `task-factory` 刻意**不写**这一行 —— 它们是全池身份，保持零回归。

### 6.6 这个槽解掉了什么 / 没解掉什么

**解掉**：mainAgent 现在能表达"这个身份启用哪些扩展"。三类 mod 消费点（工具/命令/handler）
统一受同一份 per-session 白名单约束，不会出现"工具禁了但 handler 还在跑"的裂口。

**没解掉**：

1. **仍是可见性，不是隔离**。被禁用的 mod 代码仍在同进程（§5 M1）。要真隔离得走
   opencc 自己在 docs §3.3 分叉掉的 vm / Worker 路线，成本高一个量级。
2. **门禁不回收 mod 的进程级副作用**。mod 在 `register()` 里做的事（改 `STATE`、
   起定时器、挂全局监听）不受门禁影响 —— 门禁只在三个消费点生效。
3. **熔断计数是全局的**。某 mod 在 A 会话连续崩 5 次会被整体卸载，连带影响正在用它的
   B 会话。这条要么接受，要么把 `failureCounts` 也按会话拆开（后者会让熔断语义变弱）。
4. **`~/.zai/main-agents/*.js` 的外置 agent 也能用这个槽** —— `loadUserAgents` 走同一个
   `toAgentConfig`，所以字段自动透传，无需额外改动。

---

## 七、TUI 能力面移除（已实现）

> **前提**：zai 的 UI 是 **Web UI**（React + AntD，跑在 `packages/zai/src/web/`），
> 与 opencc 的 **Ink TUI**（`src/components/**/*.tsx`，426 个组件在 zai 侧已被
> `stub-ui-sources.ts` 就地 stub 成 `return null`）不是同一套体系。
> 把 Ink 的渲染机制搬进 zai 不会执行，只会成为死代码。

### 7.1 删了什么

| 机制 | opencc 侧的消费者 | 处置 |
|---|---|---|
| `ctx.ui.pane` / `closePane` / `notify`（P3 render site） | ink 组件 `ModPaneArea` + `ModStatusLine`，per-pane ErrorBoundary 隔离渲染崩溃 | **整块删除** |
| pane 注册表（`modPanes` / `getModPanesSnapshot` / `getModPanesVersion` / `subscribeModPanes` / `notifyPaneChanged` / `clearModPanes` / `__resetModPanesForTesting`） | 同上 | **整块删除**（engine.ts −159 行） |
| `ui.render` 事件（`MOD_RENDER_EVENT` / `ModRenderEvent` / `ModRenderHandler`） | `PromptInput` 渲染管线；opencc 09:05 commit `1d1f3272` 新增（cc-plugin-mermaid 对标） | **整块删除**（dispatch.ts −69 行） |
| `clearModPanes` 在 unload 路径的调用 | `mods/hooks.ts` `unloadMod` | 删除调用，`clearModStatus` 保留 |

**`ui.render` 的删除依据是实测**：`runModRenderChainSync` / `hasModRenderHandlers`
在整个 vendor 里**零调用方** —— opencc 侧由 Ink 组件在 render 期间 tap，
而那些组件在 zai 侧全是 stub。

### 7.2 保留了什么，以及判据

保留 `ui.notice` 与 `ui.status`。判据是**「数据 vs 渲染」，不是「有用没用」**：

| 通道 | 性质 | 处置 |
|---|---|---|
| `ui.notice(text)` | mod → 宿主单向字符串推送，桥到 zai 的通知队列（`bundle-entry` 导出 `subscribeModNotices`） | 保留 |
| `ui.status(text)` | mod → 宿主单向字符串推送，per-mod 一段状态文本 | 保留（给未来 Web 状态栏/侧栏） |
| `ui.pane` / `ui.render` | 需要 React/Ink 渲染管线才能执行 | 删除 |

两个保留通道**不依赖任何渲染技术**，zai 侧可以直接订阅消费；pane / render
则必须先把 Ink 渲染栈搬回来才可能工作 —— 那不是同步，是重写。

### 7.3 删除后的 fail-fast 行为

删掉的能力**显式报错，不静默无效**：

- `ctx.on('ui.render', h)` → `ctx.on(): unsupported event "ui.render".
  Supported: PreToolUse, PostToolUse, ...`（`isModSupportedEvent` 查表只剩
  7 个 hook 事件），且 handler **不会**被记进 mod（`mod.handlers` 保持空）
- `ctx.ui.pane(...)` → `TypeError: ctx.ui.pane is not a function`

这是有意的：依赖 TUI 渲染的 mod 应当**尽早暴露**，而不是加载成功后静默不生效。

### 7.4 验证

`test/unit/mods-sessionGate.test.ts` 新增 4 个 case 锁住这个决定：

- `ctx.ui` 上 `pane` / `closePane` / `notify` 均为 `undefined`，
  而 `notice` / `log` / `status` 仍是 function
- `ctx.on('ui.render')` 抛 `unsupported event`，且 `mod.handlers` 长度为 0
- 7 个 hook 事件全部仍可注册
- `ui.status` 仍能写入快照（数据通道没被误删）

全量闸门：typecheck 0 error、`build:core` 通过、core 单测 **1197 passed / 1 skipped**
（1193 + 4 新增）。

真 bundle 端到端（一个真磁盘 mod 自检 `ctx.ui` 形状）实测输出：

```
HAS pane      : undefined
HAS closePane : undefined
HAS notify    : undefined
HAS notice    : function
HAS status    : function
ui.render     : REJECTED -> ctx.on(): unsupported event "ui.render". Supported: PreToolU
bundle 导出: getModPanesSnapshot GONE / subscribeModPanes GONE
           subscribeModNotices kept / subscribeModStatus kept / getModStatusSnapshot kept
status 快照: {"tuimod":"tuimod active"}
```

### 7.5 将来要做 mod 面板怎么办

**在 Web UI 侧新建组件**，订阅 `subscribeModNotices` / `getModStatusSnapshot`
这类通道拿数据 —— 而不是把 Ink 的 pane 机制搬回来。数据通道已经留好了，
缺的只是一个 Web 侧的呈现层。
