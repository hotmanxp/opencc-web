# vendor mods —— 与上游 2.1.296 的偏差清单

> 这份文档回答一个问题:**`docs/mods-upstream-contract.md` 描述的是上游行为,
> 那么 `packages/zn-agent-core/src/opencc-src/mods/` 里到底是什么?**
>
> 同步时间:2026-10-12。上游 `opencc@main-opencc` 截至 `bf8adab2`
> (2026-10-11~12 的 14 个 mods commit)。
>
> **不要**把下面「有意分叉」里的任何一条当成 bug 顺手改回上游 —— 每条都写了
> 为什么。改成上游形状之前先读理由。

---

## 一、这次同步做了什么

上游那 14 个 commit 不是 14 个独立特性,而是**一次重构 + 一批接线**:
`d9792cbe`(第一个)把 `protocol.ts` / `nouns.ts` 从 `dispatch.ts` / `engine.ts`
里抽了出来,并重写了这两个文件(+934 / +554 行)。vendor 之前停在这次重构
**之前一代**,所以这不是「补 8 个文件」,而是搬一次架构变更。

| 类别 | 内容 |
|---|---|
| 新增文件 | `protocol.ts` `nouns.ts` `toolDescribe.ts` `sessionUsage.ts` `turnStep.ts` `turnStepStream.ts` `instructionFiles.ts` `builtin/modProbe.ts` |
| 重写文件 | `dispatch.ts` `engine.ts` `registry.ts` `pluginView.ts` `builtin.ts` |
| 非 mods 文件 | `types/hooks.ts`(`ModChainEntry` 加 `tier`/`matcher`)、`utils/toolSchemaCache.ts`(tool.describe 的 schema 失效) |

同步方式:以 `c855981d`(= vendor 上次的同步点,已用 blob 逐文件核对确认)为
base 做**三方合并**,24 处冲突逐个裁决。这样 vendor 的本地适配不会被上游
的整片重写冲掉,也不会漏掉上游新增的能力。

## 二、事件面

上游声明 **109 个点号事件**(`MOD_ENGINE_EVENTS` + `MOD_OP_EVENTS`),
`protocol.ts` 是唯一真相源。

### 已接 / 已拒

- **`UNAVAILABLE_EVENTS`**:按名拒掉,订阅即抛带原因的错。
  上游 6 个(`audio.play` `audio.speak` `ui.blit` `ui.message` `ui.fault`
  `prompt.autocomplete`)+ 上游 2026-10-12 补的 12 个(`ui.press` `ui.select`
  `ui.input` `session.receive` `session.attach` `session.detach`
  `session.authorize` `plugin.register` `engine.create` `agent.register`
  `mcp.call` `mcp.connect`)+ **zai 加的 1 个**(`ui.render`,见下)。
  上游那 12 个把 `docs/mods-upstream-gaps.md` §二 的「15 个真待接」清掉了 12 个
  ——剩下 3 个已接线(`session.measure` / `session.compact` / `agent.offer`)。
- 其余事件在 `MOD_EVENTS` 里声明。**「声明了」不等于「有 dispatch 点」**。
  静态分析才是判据,`/mod-probe` 分不清「没接线」和「本次没调用」。

### zai 额外拒掉:`ui.render`

上游把 `ui.render` 留在可用表里,因为它的渲染点是 React/Ink 的
`PromptInput`。**zai 的 UI 是 Web UI,没有这条渲染路径**,同源的
`hasModRenderHandlers` / `getModRenderChain` / `runModRenderChainSync`
与 `mods/renderTap.ts` 已整体删除(见 `engine.ts` 文件头)。

不拒它就会落进**「注册成功但永不触发」**那第三种状态 —— 比报错更坏:
mod 以为改写生效了,实际什么都没发生。故按 `protocol.ts` 自己定的规矩
(「要么真能 dispatch,要么按名字拒掉」)明确拒掉。

### 旧 hook 名已移除

`PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `SessionStart` /
`SessionEnd` / `Stop` / `Notification` **不再是 mod 事件**。
它们是宿主 hook 词汇,在上游属于 classic 通道。`ctx.on('PreToolUse', …)`
现在抛 `unsupported event`,错误信息里点名 `tool.call` 是它的对应。

### 事件派发点的同步口径

派发点分布在**非 mods 文件**里(`query.ts` `toolExecution.ts`
`processUserInput.ts` `attribution.ts` `forkedAgent.ts` `messages.ts`
`api.ts` `sessionStart.ts` `systemPromptSections.ts` `prompts.ts`
`commands.ts` `AgentTool.tsx` `compact.ts` `autoCompact.ts` `cost-tracker.ts` …)。

这些文件在 vendor 的基线**比 `c855981d` 还老**,所以:

- 三方合并不适用 —— git 会把 vendor 的「没有」读成「有意删除」并保留,
  结果是零改动(实测 14 个文件全是 no-op)。
- 实际做法:**只搬含 mods 关键字的 hunk**,逐文件 `patch` 上去。含
  `mods/dispatch` / `dispatchMod*` / `hasModHandlersFor` / `MOD_EVENTS` 等标记。
- 副作用:某些**配套的非 mods hunk** 因此没被带过来,需要在原地补。已补的:
  - `attribution.ts`:上游把原函数改名 `computeAttributionTexts` 并降为模块私有,
    上面再加一层导出的 `getAttributionTexts` 走派发。改名 hunk 不含 mods 关键字,
    不补就与新加的那层重名。
  - `AgentTool.tsx`:`model` 由 `const` 改 `let`(`agent.spawn` 的结果要改写它)。
  - `commands.ts`:mods dispatch 的 import 那一 hunk 被 reject,手工补上。

**TUI 派发点未搬**:`ink/ink.tsx`(`setTerminalWriter` 给 `$.ui.notify`)、
`screens/REPL.tsx`(`prompt.read` / `prompt.fill`)、`hooks/useTextInput.ts`
(`prompt.edit`)、`services/PromptSuggestion/promptSuggestion.ts`(`prompt.suggest`)、
`components/agents/generateAgent.ts` —— 全是 React/Ink 面,理由见 §三.1。

`prompt.compose` 也未接:`constants/prompts.ts` 上游那 134 行会把 static/dynamic
两组 section 建成 `{id, text, scope}` 再交给 `composePromptSections` +
`placeComposeBoundary`,而后者会动 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 的位置
——也就是动 prompt cache 边界。vendor 侧暂取回 `.text` 保持 `string[]` 返回,
**该事件已列入待拒清单**(见 §五)。

### 待拒清单(声明了但 vendor 侧无派发点)

这些事件在 `MOD_EVENTS` 里,但 zai 侧没有 dispatch 点。按协议自己的规矩它们
应当进 `UNAVAILABLE_EVENTS`;本轮**没有**自动加,因为逐条确认「确实没接」
需要一次完整的事件审计(方法见下),猜着加会把已接线的事件误拒:

```
prompt.read  prompt.fill  prompt.suggest  prompt.edit
prompt.mention  prompt.compose
ui.open  ui.close  ui.panes  ui.invalidate  ui.selection
ui.resolve  ui.scroll  ui.focus  ui.copy  ui.notify
process.spawn
```

**审计方法**(别用 grep 事件名的笨办法 —— `HOST_EVENT_BRIDGE` 的键是带引号的
属性,不匹配 `dispatchMod*(` 的裸调用式样,会误判):

1. 先扣掉 `UNAVAILABLE_EVENTS` 里已拒的;
2. 再扣掉 `dispatch.ts` 的 `HOST_EVENT_BRIDGE`(`tool.call` / `session.start` /
   `session.end` / `turn.complete` 走宿主 hook 桥接,没有字面量调用点);
3. 剩下才是真死事件;
4. **判定脚本必须剥掉注释再匹配** —— 名字出现在散文里不等于有 dispatch 点。

上游的 `mods/declaredButDead.test.ts` 就是这个审计的固化版,值得照搬一份
到 `test/unit/`(它现在跑不到,因为 vitest exclude 了 `src/opencc-src/**`)。

---

## 三、有意分叉(不要改回上游)

### 1. TUI 能力面整体删除

上游 `engine.ts` / `registry.ts` / `dispatch.ts` 里有两大块纯终端 UI:
pane 注册表(`$.ui.open` / `close` / `panes` + `ModPaneSpec` + 状态机)与
`ui.render` 事件链。zai 侧整体删除 —— 唯一消费方是 ink 组件
`ModPaneArea` / `ModStatusLine`,而 zai 的 UI 是 Web UI。

**判据是「数据 vs 渲染」,不是「有用没用」**:保留了 `ui.notice` /
`ui.toast` / `ui.status` —— 它们是 mod → 宿主的单向数据推送,不绑定任何
渲染技术(notice 已桥到 Web UI 的通知队列)。

未搬的内置 mod:`diff`(实时 pane)、`handoff`(local-jsx 文档选择器)、
`mermaid`(`ui.render` 渲染点变换,通道已不存在)。

### 2. per-session mod 门禁(zai 独有)

mainAgent 的 `mods` 槽可以按会话点名放行若干 mod,其余在该会话里
handler 直接跳过(仍占 `next()` 链位,核心 tier 语义不变)。
实现:`registry.setSessionModGate` / `isModVisibleForSession` /
`hasSessionModGate`,`dispatch.runModChain` 与 `engine.getModTools(sessionId)`
消费。上游无此概念。

⚠️ **一个容易踩的坑**:`runModChain` 吃的是 `ModChainEntry`
(`refreshOpChains()` 建的那种,带 `modName` + `tier`),**不是**裸的
`ModHandlerSpec` —— 后者没有 `modName`,`gate.has(undefined)` 恒假,
只要带 `sessionId` 就会把 handler 全跳过,而门禁**看起来**是生效的。

### 3. `ctx.fs` 的授权门(与上游相反,故意的)

上游**移除**了 `settings.mods.authorized` 白名单,判据是「路径围栏而非身份」
(契约 §二:边界是路径,没有 allowlist),并靠发布前的
`claude plugin validate` 静态校验兜底。

**zai 没有 validate 环节**,照搬等于对任意加载进来的 mod 开放宿主文件系统读。
故保留授权门(`isModFsAuthorized`),叠加在路径围栏之上。

将来若 zai 长出 mod 发布期校验,这里是唯一该重新审视的地方 —— 而且要
**一次决策**,不要两处标准并存(`tool.check` 严守「插件只能收紧」,
`env` 却毫无限制,这个不一致上游自己也在 `mods-upstream-gaps.md` §一记着)。

### 4. `ctx.options` 走 `loadPluginOptions` —— 与 plugins UI 同一处,**已核对**

`engine.ts` 的 `readModOptions` 调 `utils/plugins/pluginOptionsStorage.js` 的
`loadPluginOptions`,读 `settings.pluginConfigs[pluginId].options`。

初看像是个 bug:同一个文件里 `isModEnabled` 刻意改读 `getUserConfigJson()`
(`~/.zai.json`)而不是 `getSettings_DEPRECATED()`,理由写得很清楚 —— zai 的
user 作用域开关状态存在统一 user config 里,两端必须读同一个地方。

**核对结论:两者并不冲突,因为它们管的不是同一个键。**

| | 写入 | 读取 | 键 |
|---|---|---|---|
| mod 开关 | `setModEnabled` → `setUserConfigJsonValue` | `pluginView.isModEnabled` → `getUserConfigJson()` | `enabledPlugins` |
| mod `userConfig` | 插件 UI「Configure options」→ `savePluginOptions` → `updateSettingsForSource` | `engine.readModOptions` → `loadPluginOptions` | `settings.pluginConfigs` |

插件列表把 mod 投影成 `LoadedPlugin` 后,配置对话框走的是插件流水线自己的
`savePluginOptions`(见 `pluginView.ts` 里「全程没有任何 mod 专属分支」那句
注释),写的和 `loadPluginOptions` 读的是同一处 `settings.pluginConfigs`。
`getUserConfigJson` 只承担 `enabledPlugins` 那一件事。

所以这里**不需要**改成 `getUserConfigJson()`。改之前先确认插件 UI 实际写的是
哪个键 —— 这正是「写→重读往返验证」的由来。

### 5. `optIn` 内置 mod

上游新增的 `mod-probe` 是 `optIn` 的:默认关着,只在 `/plugins` 显式打开才
加载。理由是它订阅全部事件,默认加载会让每个 dispatch 点永久走慢路径。
zai 原样保留了这个默认值。

`modctl`(zai 自己的自检 mod)**刻意不注册** —— 它向每轮对话回注
`[modctl] …`,常驻噪音对每个会话都是负担。文件与单测仍在树上。

---

## 四、测试环境的两处必要修正

mods 运行时现在会 import `utils/context.ts` / `utils/model/model.ts`,
它们把整个工具注册表拉进来 —— 而 vendor 里有一批模块是**为 Bun 写的**:
顶层 `require('./X.js')`,磁盘上是 `X.ts` / `X.tsx`。Bun 能解析,Node 的 CJS
resolver 不能,而 `require` 绕不过 Vite 的 alias。

两类,处理方式不同:

**(a) 无条件的 require → 静态 import。** `tasks.ts` 的 `MonitorMcpTask`、
若干 `const X = true ? require(…) : null`(`= true` 是 vendoring 把上游
feature gate 替换成常量的产物)。它们本来就没有 gate,改成静态 import
**不改变求值时机**。

**不能**顺手动这些:`getTeamCreateTool` / `getTeamDeleteTool` /
`getSendMessageTool`(注释写明是「Lazy require to break circular
dependency」)、`getPowerShellTool`(lazy + gate)、各 `false ?` 死分支。

**(b) 有 gate 的 require:让 gate 在测试里保持关闭。**
`services/mcp/client.ts` 在模块加载期读 `isComputerUseEnabled()`,为真时
`require` 一个只有 `.tsx` 的路径。`isComputerUseEnabled()` 的 env 分量
`OPENCC_ENABLE_COMPUTER_USE` 会被 vitest worker **从开发者 shell 继承** ——
于是同一份代码在「开了 computer use 的机器」上整个测试文件加载失败,
在没开的机器上通过。

`src/compat/runtime/test-feature-gates.mjs` 在 setupFiles 里清掉这个变量。
它**只**清 env,不重定向 `OPENCC_CONFIG_DIR` —— 有几个 suite 断言的是真实
数据根下的 transcript 路径,重定向会弄坏它们。

> 顺带修了一个 HEAD 就存在的 alias 缺口:`src/...` specifier 原先只映射到
> `.ts`,而 `tools/BashTool/BashTool.tsx` 这类是 `.tsx`,会报成
> "Cannot find package"。现在移到 `forceResolvePlugin` 里,`.ts` → `.tsx`
> 依次尝试。

---

## 五、已知未收敛

- `docs/mods-upstream-gaps.md` §二 列的 15 个「声明了但没 dispatch 点」的
  事件,zai 侧同样空挂。其中 `session.*` 5 个尚未定位触发点,
  `ui.press` / `ui.input` / `ui.select` 是一整套(元素树 + 按住注册表 +
  surface + 焦点模型),`mcp.*` 需要 server 名归一化。
- `mods/ui/*`(元素表)整块未搬。将来若做 mod 面板,应在 **Web UI 侧**新建
  组件 + 订阅 `subscribeModNotices` 那类通道,而不是把 Ink 的 pane 机制搬回来。
- 协议守卫(契约 §三 的 `checkArgument` / `restoreArgument` /
  `measureArgument` / `restoreResult`)未实现 —— 上游也没有全量实现,
  是「需要守卫的事件」的表,不是 109 行的统一形状。
- `$.env` 无任何过滤:任意 mod 可读 `ANTHROPIC_API_KEY` 及任何环境变量,
  `env.set` 还能写宿主进程环境。同一份代码里 `tool.check` 严守「插件只能
  收紧」,两种安全标准并存。改信任模型应单独一个 PR(详见 gaps §一)。

## 六、验证到什么程度

- `pnpm --filter @zn-ai/zn-agent-core test` 全绿(1324 项,含本轮新增的
  mods 端到端接线用例)。
- `npm run typecheck`(vendor + contract-tests + consumer + server d.ts
  self-contained)四段全绿。
- `npm run build` 全绿,且 `node -e "import('./dist/opencc-core.mjs')"`
  实测能加载 —— 新增顶层 import 是本仓库 bundle 循环依赖的已知触发方式,
  构建绿不等于能加载,必须单独验。
- `test/unit/mods-eventDispatch.integration.test.ts` 走**真实磁盘加载 →
  真实派发**链路,并做过反向探针:改错载荷断言、把门禁两种方向各改一次、
  让 mod 不订阅 —— 四种改法都会变红。绿灯不是恒真的。
- **未做**:真实 Web UI 会话里的 smoke(需要一个能跑 turn 的模型配置)。
  上面那条集成用例覆盖的是「事件真的派发到 mod」,不等于「一整轮对话里
  每个派发点都接对了」。