# vendor mods —— 与上游 2.1.296 的偏差清单

> 这份文档回答一个问题:**`docs/mods-upstream-contract.md` 描述的是上游行为,
> 那么 `packages/zn-agent-core/src/opencc-src/mods/` 里到底是什么?**
>
> 同步时间:2026-10-13。上游 `opencc@main-opencc` 截至 `59b2b27d`
> (前两批的 14 个 + 第三批 5 个)。
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
| 非 mods 文件 | `types/hooks.ts`(`ModChainEntry` 加 `tier`/`matcher`/`event`)、`utils/toolSchemaCache.ts`(tool.describe 的 schema 失效) |

同步方式:以 `c855981d`(= vendor 上次的同步点,已用 blob 逐文件核对确认)为
base 做**三方合并**,24 处冲突逐个裁决。这样 vendor 的本地适配不会被上游
的整片重写冲掉,也不会漏掉上游新增的能力。

### 第三批(2026-10-13,上游 `e7d696d8` ~ `59b2b27d` 五个 commit)

这五个不是新特性,是**上游拿一个真实发布的 mod 驱动出来的 bug 修复** ——
那个 mod 装上了却什么都不做,而派发层把每次异常都归因后继续走,从外面看
就是「已加载」。

| 上游 commit | 改了什么 | vendor 落点 |
|---|---|---|
| `e7d696d8` | `clock.after`/`every` 交回 `Timer` 句柄;定时器按 mod 登记,卸载时清 | `nouns.ts` `hooks.ts` |
| `5ba8abeb` | handler 支持上游形态 `($: EngineInterface, e, next)`;`next` 带 `event`/`origin` | `registry.ts` `engine.ts` `protocol.ts` `dispatch.ts` `types/hooks.ts` |
| `59b2b27d` | `$.plugin` 名词;`session.measure` 从同步派发改成串行队列异步派发 | `engine.ts` `cost-tracker.ts` |
| `e47bd606` | `optIn` 内置 mod 在插件列表那一行的启用态判定 | `builtin.ts` `pluginView.ts` `pluginListAssembly.ts`(见下) |
| `44c657f1` | 一个拿真 mod 跑的验证脚本 | 未搬(vendor 不含 `scripts/`) |

**为什么 `session.measure` 的同步→异步是必须的**:上游 `await` 这个事件,
它的结果表写着 `"session.measure": void 0` —— 也就是 handler 返回什么都不
影响宿主。同步派发买不到任何东西,却要付一个代价:`dispatchModEngineSync`
不能 await,一个**正确的** async handler 返回的 promise 被丢在地上、记成一次
失败,而 `addToTotalSessionCost` 每轮响应调一次、熔断阈值 5 连败 —— 一个
工作得很好的 mod 被卸载,状态行一路正常直到那一刻。改成队列派发后,`changed`
的差分仍在同步段算(不能自己跟自己赛跑),只有派发入队。

**`e47bd606` 的 zai 对应物比上游更硬**。上游那个 bug 是两个谓词读**同一个**
存储、只是对缺键的默认值相反(行按 `!== false` 算,加载器按 `=== true`)。
zai 侧原本是**读写根本不在一个文件**:`setModEnabled` 写 `~/.zai.json` 的
user config,`isModExplicitlyEnabled` 读的是 `getSettings_DEPRECATED()`
(settings.json 级联),于是 `optIn` 内置 mod 的门禁永远读到 undefined ——
用户在 UI 上打开它,它也加载不了。两处都已修:

- `isModExplicitlyEnabled` 改读 `getUserConfigJson()`,与 `isModEnabled`
  和写入端同源;
- `KnownMod` 加 `optIn` 字段一路带到 `ModPluginInfo`,`toDto` 据此对
  optIn 的读 `=== true`、其余照旧。

> 这一条正是 §4 那句「改之前先确认插件 UI 实际写的是哪个键」的又一个实例:
> **读写的存储必须先验过往返**。`~/.zai.json` 里 `demo-mod@mods` /
> `modctl@builtin` 两个真实键就是证据 —— 它们只存在于 user config。

### 第四批(2026-10-13,派发点补漏)

前三批搬的是 `mods/` 目录本体。第四批是一次**事后审计**发现的补漏:
`mods/` 内的导出符号面已经与上游对齐,但**非 mods 文件里的派发点**漏了四处,
结果是这四个事件在 `MOD_ENGINE_EVENTS` / `MOD_OP_EVENTS` 里声明为可用、
实际零派发 —— 正是本文件 §二警告的第三种状态「注册成功但永不触发」。

| 事件 | 漏在哪 | 症状 |
|---|---|---|
| `turn.start` | `query.ts` —— 该文件**一个 mods import 都没有**,整份 mods 接线全缺 | mod 最常用的时机 hook 永不触发;`$.turn.abort` 也拿不到控制器 |
| `prompt.mention` | `utils/attachments.ts` | mod 无法 DENY 一个 `@` 提及路径 |
| `tool.describe` | `services/api/claude.ts` 缺 `resolveToolDescriptions` 调用点 | `mods/toolDescribe.ts` 本身已同步,但改写工具描述**永远不生效** |
| `session.usage` / `session.messages` | `query.ts` 缺每轮刷新门禁 | 事件本身由 `nouns.ts` 派发(可用),但 mod 读到的是**上一轮**数据 |

补 `tool.describe` 时还牵出一处更深的漏同步:`utils/api.ts` 的
`toolToAPISchema` 签名缺 `description?: string` —— 上游把它作为**入参**传入
(`options.description ?? await tool.prompt(...)`),因为 `tool.description` 对内置
工具是 undefined,模型实际看到的文本必须就是 mod 改写后的那份。只补 `claude.ts`
不改 `api.ts` 会静默无效。

**审计方法**(比 §二 那条更省事,推荐作为下轮同步的固定动作):

```bash
# 上游含 mods 派发标记的文件(排除 src/mods/ 与测试)
grep -rln "dispatchMod\|hasModHandlersFor\|runModChain" src/ \
  --include='*.ts' --include='*.tsx' | grep -v '^src/mods/' | grep -v test
# 逐文件比对两边「含标记的代码行集合」,取只在上游出现的行
```

⚠️ **pattern 必须精确**。用 `Mod` / `getMod\w*` 之类宽泛的词会命中
`Model` / `Modal` / `Mode`,`query.ts` 会被算成「有 49 处 mods 代码」而实际
一个都没有 —— 正是这次差点漏判的原因。只用
`dispatchMod\w*|hasModHandlersFor|runModChain|MOD_RENDER_EVENT|subscribeModPanes`。

**排除掉走 `HOST_EVENT_BRIDGE` 的**:`dispatch.ts` 的桥接表只有
`tool.call` / `session.start` / `session.end` / `turn.complete` 四个,
它们没有字面量调用点;其余事件必须靠调用点,调用点缺失即死事件。

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
- ⚠️ **`patch` 失败是静默的** —— hunk 上下文对不上时它只报 rejects,不报错,
  于是 `query.ts` 整份文件一个 hunk 都没搬成,看起来却像「搬过了」。
  搬完必须用 §一 第四批那条审计命令逐文件复核,**不要靠「我 patch 过」**。
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
应当进 `UNAVAILABLE_EVENTS`。**这份清单已被 `test/unit/mods-deadEvents.test.ts`
取代** —— 那条测试每个 run 都重算一遍,并给每条钉上理由。

2026-10-13 实测后仍无派发点的(13 条):

```
prompt.suggest  prompt.edit  prompt.compose
ui.open  ui.close  ui.panes  ui.invalidate  ui.selection
ui.resolve  ui.scroll  ui.focus  ui.copy  ui.notify
```

分成三类:`prompt.*` 三条是 TUI 或 prompt-cache 边界;`ui.open`/`close`/`panes`/
`invalidate`/`selection` 五条随 pane 系统整体删除;`ui.resolve`/`scroll`/`focus`/
`copy` 与 `ui.notify` 依赖 `mods/ui/` 元素树或终端通知面。

⚠️ 旧版本这里列的 17 条里有 **4 条是错的**,它们其实早就接上了 ——
`prompt.read`、`prompt.fill`、`process.spawn` 派发在 `mods/nouns.ts`,
`prompt.mention` 是第四批补上的。错因值得记住:**grep 事件名时要求
`dispatchMod` 与事件名同一行会漏判**,`mods/nouns.ts` 里那几处全是跨行写法:

```js
spawn: async args =>
  dispatchModStream<ModProcessSpawnChunk, ModProcessSpawnResult>(
    'process.spawn',        // ← 上一行是 dispatchMod*,这一行才是事件名
```

同理,判定脚本若不剥注释,名字出现在散文里会被当成派发点。


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
- **`turn.complete` 不带 `turnId`**(2026-10-13 实测,上游同款)。`query.ts` 搬来的
  `turn.start` 会 mint 一个 `modTurnId` 并 `openModTurn` 登记,上游注释也写着
  「the id it mints is what `turn.complete` carries」—— 但 `turn.complete` 走
  `HOST_EVENT_BRIDGE` 的 `Stop` 宿主 hook,载荷来自那个 hook,实测只有
  `stop_reason` / `reason`,**没有 `turnId`**(对照 `mods/builtin/modctl.ts:212`
  就只读这两个字段)。后果:mod 拿 `turn.start` 的 `turnId` 无法与
  `turn.complete` 对齐,只能靠自己的时序记账。`$.turn.abort` 那侧是通的
  (`openModTurn` 登记了控制器)。这是上游自身的注释与实现脱节,不是 zai 漏搬;
  要修得改上游或另立一个 `turn.end` 事件,不要在 vendor 侧私自给
  `turn.complete` 塞字段 —— 那会让 zai 的事件载荷与上游不一致。

## 六、验证到什么程度

- `pnpm --filter @zn-ai/zn-agent-core test` 全绿(1345 项 / 183 文件,含
  mods 端到端接线用例与死事件审计)。
- `npm run typecheck`(vendor + contract-tests + consumer + server d.ts
  self-contained)四段全绿。
- `npm run build` 全绿,且 `node -e "import('./dist/opencc-core.mjs')"`
  实测能加载(225 个导出)—— 新增顶层 import 是本仓库 bundle 循环依赖的
  已知触发方式,构建绿不等于能加载,必须单独验。
- `test/unit/mods-eventDispatch.integration.test.ts` 走**真实磁盘加载 →
  真实派发**链路,并做过反向探针:改错载荷断言、把门禁两种方向各改一次、
  让 mod 不订阅 —— 四种改法都会变红。绿灯不是恒真的。
- **第三批的每一项都单独做过反向探针**(2026-10-13):把 `withEngineInterface`
  的 arity 判断短路成恒真、`clock.after` 退回返回 void、
  `isModExplicitlyEnabled` 的默认值退回 `!== false`、`toDto` 退回 `?? true`
  —— 四处改坏分别让对应测试文件变红(1 / 2 / 2 / 2 项)。绿灯对应着的是真实
  行为,不是恒真断言。

### 第四批新增的两条防线(2026-10-13)

- **`test/unit/mods-deadEvents.test.ts`** —— 把上面「待拒清单」的重算固化成
  测试:声明可用的事件,扣掉按名拒斥与 `HOST_EVENT_BRIDGE`,剩下的必须有
  字面量派发点。它自带三向探针:已知能派发的必须扫得到(`turn.start`
  `prompt.mention` `tool.describe` `turn.step`)、白名单里的必须扫不到、
  桥接事件必须**没有**字面量调用点(否则同一事件两个入口)。
  - 反向探针实测:删掉 `query.ts` 的 `turn.start` 整块(17 行)→ 主审计与探针
    **同时变红**,报「声明为可用却没有任何派发路径: turn.start」。
  - 它写这条时自己抓出了作者的一个错误结论:`prompt.read` / `process.spawn`
    曾被误列进「上游也没接」的白名单,实际两边都有派发 —— 白名单反向校验
    (「这些事件已经能派发了,应从清单移除」)当场变红拦下。
- **集成测试补了 `turn.start` / `prompt.mention` 两个订阅与一条用例**(6→7 条)。

### 第五批(2026-10-13,审查 sync-1013 发现的 bug)

`runModChain` 的**每 hook 预算**有一条此前没人发现的缺陷,现补在
`dispatch.ts` 并由 `test/unit/mods-hookBudget.test.ts` 守住。

每 hook 10s(`MOD_HOOK_BUDGET_MS`),超时则跳过该 handler、继续跑它下面的,
并记一次失败给熔断器。超时之后**必须**让那个慢 handler 后续的 `next()`
变成 no-op —— 否则它会再去驱动 `runFrom` 共享的 `index` 游标,与「跳过它、
继续往下」那条链对撞,同一个事件的 core tier 会跑两次。

守卫本该由 `withAbort(next, unlink.signal)` 承担,而 `unlink` 的 signal 是
`linkSignals(signal, hookSignal)` 把**外层** signal 与**预算** signal 合成的。
解链却写成:

```js
try { return invokeModHandler(modName, handler, current, withAbort(next, unlink.signal)) }
finally { unlink.dispose() }
```

`invokeModHandler` 在第一个 `await` 处挂起,所以这个 `finally` 在 **t=0** 就跑了
—— handler 还没做任何事,两个 abort listener 已经摘掉。预算超时时的
`controller.abort()` 到不了 `withAbort`,守卫形同虚设。

**只在传了 `signal` 时犯**:不传时 `linkSignals` 直接返回预算自己的 controller,
守卫本来就好使。而传 signal 的正是最要紧的两条路 —— `utils/hooks.ts` 的
executeHooks 复合链(terminal 是 `coreRunner`,会把宿主的**全部 core hook**
再跑一遍)与桥接宿主 hook(`tool.call` / PreToolUse 等)。这就是它躲过测试的原因。

修复是解链挂到 handler 的 **promise** 上而非同步调用外:

```js
return invokeModHandler(modName, handler, current, withAbort(next, unlink.signal))
  .finally(() => unlink.dispose())
```

上游同样显式解链(bundle @3803457 `finally { g?.() }`)—— 区别在于上游解的是
**await 之后**的 hook。

> **教训与 `patch` 静默失败同源**:这里的错误同样只在**很窄的条件下**显形
> (必须传 `signal`),且症状是「某次 core hook 跑了两次」这种需要真实时序才
> 看得见的东西。反向探针里把 `.finally` 改回 `try/finally`,第一条用例立刻变红。

### 这两条防线抓不到什么

写下来是为了不让后人把绿灯读得太宽:

- `mods-deadEvents` 抓**整块缺失**,抓不到**调用点被改坏**。把
  `hasModHandlersFor('turn.start')` 短路成 `false`,字面量还在,测试全绿。
- 集成测试抓**派发层**,抓不到**接线点**。同样短路 `query.ts` 的门禁,那
  7 条用例同样全绿 —— `query.ts` 的主循环无法在单测里驱动。
- 两层都绿**不等于**接线正确,只等于「没发现明显问题」。
- **未做**:真实 Web UI 会话里的 smoke(需要一个能跑 turn 的模型配置)。
  上面那两条覆盖的是「事件能派发到 mod」与「派发点在源码里」,不等于
  「一整轮对话里每个派发点都接对了」。