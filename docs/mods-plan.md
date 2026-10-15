# opencc 接入 Mods 系统 —— 规划文档

> **目标**：让 opencc 支持 Claude Code 引入的 Mods 机制 —— 用户写 JavaScript 事件处理函数，直接扩展 opencc 自身的行为、工具与 UI。
>
> **版本**：v2.10 ｜ **日期**：2026-10-07 ｜ **依据**：官方 Mods 实证核验（见 [`mods-upstream-audit.md`](./mods-upstream-audit.md)）+ opencc 侧实测（附录 C）
>
> **v2.0 变更**：经上游核验与方案讨论，确立三项决策 —— ① **mod 用纯 JS，不做 TS 转译**（见 §3.2①）② **用原生 `import()` 加载，不用 `node:vm`**（见 §3.2②）③ **能力面收窄到上游同款，`fs`/`store` 延后到 P2 授权制**（见 §3.3）。同时修正了 v1.0 中若干经实测证伪的数字（见 §1.1）。
>
> **v2.1 变更**（对照当前代码逐项复核后修订）：① 修正 web vendor 路径 —— 实际为 `packages/zn-agent-core/src/compat/`，**`src/opencc-src/` 目录不存在**（§2.2、R6）② 组件数 616 → 618 ③ 注明 zod 为 phantom dependency（§3.4）④ 新增实施注记：`next()` 链采用包裹层方案、matcher 对象→string 转换、mod ctx 的 appState 接缝（§3.3）⑤ P0 前两项降级为确认性检查（§四）⑥ 补充三项增量资产：`addNotification` 通道、`removeFunctionHook` 原语、动态命令合并通道（§2.1）。复核确认命中的关键锚点（`sessionHooks.ts:93`、`hooks.ts:1800`/`2362`、`tools.ts:354`、`pluginDirectories.ts:53`、`artifactGenerator.ts:108`、两处 `HOOK_EVENTS` 27 项一致、WorkflowTool runtime 1,076 行）不变。
>
> **v2.2 变更**（P0–P2 已全部实现于 `feat/mods-p1` 分支，本文档记录实现终态）：① **两档 tier 落地为真包裹** —— mod composite（`HookCallback.modChain` 标记）被 `executeHooks` 提出扁平并行批次，mod 链作为外层 tier，terminal `next()` 真实执行核心 hooks 子集并返回聚合结果（`{continue, decision?, reason?, systemMessage?}`），handler 有真实 before/after 语义（§3.3 注记已按实现更新）② **P2 全套落地**：`ctx.fs` 授权制（settings `mods.authorized` 白名单 + cwd/mod 根双围栏）、`ui.status` 持久插槽（`ModStatusLine` 组件）、async-generator 流式 handler（yield 进度走 notice 通道）、熔断（连续 5 次 handler 失败自动卸载 + `tengu_mods_circuit_break`）、`/mods` 管理命令（列表/reload/unload）、遥测（`tengu_mods_load`）③ mod 命令经 `skillChangeDetector.notifyCommandsChanged()` 注入 REPL 命令列表（含挂载追赶）④ P3 仍未做（vm 隔离 / per-plugin Worker / 完整 render site）。
>
> **v2.3 变更**（内置 mod 通道落地 = P3 首项，上游 §4.3/§九 对标）：① **in-memory 内置通道** `src/mods/builtin.ts` —— `registerBuiltinMod(spec)` + 固定清单（上游 `wCe()`/`Ne.registerScan()`/`plugin_bundled_register` 对标），内置 mod 绕过磁盘发现与安全围栏（first-party 代码），进入同一 registry/dispatch//mods 面板（标记 `· builtin`）；同名录 disk mod 可遮蔽内置版（disk 优先）② **`diff` 内置 mod**（对标上游 `cc-plugin-diff`，其 /diff = "changed files and their hunks beside the transcript, refreshed as Claude edits"）：PostToolUse 监听 `Edit`/`Write` 工具（注意 opencc 工具名，非 FileEdit/FileWrite），读取 `tool_response.structuredPatch`（宿主已算好 hunk，mod 只读事件数据）；命令为 **`/session-diff`** 而非 `/diff` —— 主仓已有宿主 `/diff`（git diff + 每轮差异面板，`src/commands/diff`），内置 mod 命令裸名会在 dedupe 中被宿主吞掉，故命名避让；输出 unified diff 文本（`MAX_DIFF_OUTPUT_CHARS` 16KB 上限 = 上游 `MAX_DIFF_BYTES` 对标，空态 "No changes yet." 同上游）③ 内置 mod 命令**顶级裸名**（无 `<mod>:` 前缀，上游一致），disk mod 命令保持 `<mod>:` 前缀 ④ 修复 `reloadMods` 重复注册（loadMods 开头清 registry 旧实例）。
>
> **v2.4 变更**（P3 render site 切面落地，上游 §七 Client 契约的 opencc 适配）：① **`ctx.ui.pane({id,title,component,props})` / `ctx.ui.closePane(id?)`** —— mod 注册实时 pane 组件，渲染于 prompt 上方持久区域（`ModPaneArea`），`notifyPaneChanged()` 驱动重绘，组件返回 null 时不占位 ② **每槽 ErrorBoundary**：mod 组件 render 崩溃降级为 pane 内错误行，不波及宿主 TUI —— 同进程下替代上游 per-plugin Worker 的崩溃隔离 ③ diff 内置 mod 升级为实时 pane（"Session diff (mod)"，随 Edit/Write 自动刷新），`/session-diff` 文本命令保留 ④ unload 清理 pane（同 status）⑤ 内置 mod 直接传真实 TSX 组件；disk mod 组件暂无 ink 原语可用（裸模块白名单 `opencc-mods` 待拍板，P3 剩余）。TUI 实测：模型连续 Write，pane 内 `2 files changed +4 −0` 实时刷新。
>
> **v2.5 变更**（/diff 升格 —— 宿主命令移除，mod 命令转正）：① **删除宿主 `/diff`**（`src/commands/diff/`、`src/components/diff/`、`src/hooks/useDiffData.ts`、`useTurnDiffs.ts` 共 10 文件；`src/utils/gitDiff.ts` 保留 —— FileEditTool/FileWriteTool 仍在用）② **diff 内置 mod 命令 `session-diff` → `diff`**，占用顶级裸名 `/diff`（v2.3 的"命名避让"失效 —— 避让对象已不存在），与上游 cc-plugin-diff 完全对齐 ③ **DiffDialog keybinding context 及全部 `diff:*` actions 移除**（`keybindings/schema.ts`、`validate.ts`、`defaultBindings.ts`、`skills/bundled/keybindings.ts`）④ `/session-diff` 不再存在；pane 内截断提示同步改为 `/diff <path-substring>`。
>
> **v2.6 变更**（`/handoff` 升格 + mod 命令面补 `local-jsx`）：① **`ModCommandSpec` 新增 `type` / `call`** —— 此前 mod 命令只产出 `LocalCommand`（`handler` 返回值强制包成 `{type:'text'}`），既无法注入 prompt 也拿不到 `ToolUseContext`。现在 `handler`（`local`）与 `call`（`local-jsx`，签名同宿主 `LocalJSXCommandCall`）二选一，`buildModCommands()` 分支产出对应命令类型；`registerCommand` 对「两者都缺 / 都给」均 fail loud ② **删除宿主 `/handoff`**（`src/commands/handoff/` 共 7 文件），由 `handoff` 内置 mod 占用顶级裸名 `/handoff`（同 v2.5 的 /diff 路径）③ **选择界面由程序渲染**：恢复分支原本把「最近 5 份文档」写进提示词、指示模型调 `AskUserQuestion` 自行拼 JSON 选项（多一轮模型往返，且选项集不受程序控制；只有 1 份时还要专门写一段"别用 AskUserQuestion"的绕行说明）。现改为 mod 返回 `local-jsx` 组件 `<Dialog><Select/></Dialog>`，程序 `fs.readFile` 读入选中文档并经 `onDone(..., {display:'user', shouldQuery:true, metaMessages})` 注入 —— 全程零模型询问 ④ **`LocalJSXCommand` 新增 `supportsNonInteractive`** —— headless 命令表（`main.tsx`）此前只收 `prompt` / `local`，会把 mod 的 local-jsx 命令整个滤掉；handoff 声明该标志保住 `-p "/handoff"`，pickup 分支在无 `--pick` 时返回一行说明而非弹选择器 ⑤ mod 的 Ink 组件单独放 `handoffPicker.tsx` 并由 `handoffCall` **动态 import** —— 静态 import 会经组件图绕回 `mods/builtin.ts`（它 import mod 来声明固定清单）造成 TDZ 循环。
>
> **v2.7 变更**（`ui.render` 事件 + mermaid 内置 mod，上游 §九 cc-plugin-mermaid 对标）：① **新增 mod-only 同步事件 `ui.render`**（registry `MOD_RENDER_EVENT`）—— 上游 cc-plugin-mermaid 声明 `{hooks:["ui.render"]}`，opencc 对应实现为**专用同步链**（`dispatch.runModRenderChainSync`），不走 HookEvent/executeHooks 体系：事件在 React render 内触发，handler 契约为 `(e:{text}, next) => string|void` 同步纯函数，返回 Promise 记日志忽略；失败走既有熔断（registry recordModHandlerFailure）② **渲染 tap 点**：`AssistantTextMessage`（最终消息，错误检测特殊分支之后才 tap，避免破坏错误文案识别）+ `StreamingMarkdown`（流式两段各自过链 —— 完成的 mermaid fence 恒为单个 lexer token，不会跨越稳定边界）③ **LRU 缓存层**（`mods/renderTap.ts`，32 条/50KB 上限，上游 mermaid mod 同款参数）—— 无 handler 注册时零开销直通 ④ **mermaid 内置 mod**（净室实现，非上游代码搬运）：flowchart TD/TB/BT/LR/RL（rect/round/diamond 三种节点形、`|label|` 边标签、链式边、DFS 破环 + 最长路径分层、跳级/回边走右侧 gutter、BT/RL 用 FLIP 翻转）+ sequenceDiagram（participant/消息 `->>/-->>/-x/--x/->/--`/note over-left-right/loop-opt-alt 框 + else 分隔）；解析失败、subgraph（v1 未布局）、超限（20KB/200 行/24 节点/140 行渲染）一律**保留原 fence**（fail-safe）⑤ 输出包 ```` ```text ```` fence 过 Markdown 保证空白保留。已知限制：CJK 全角字符按 1 列计宽，标签对齐在含 CJK 时会歪。
>
> **v2.8 变更**（宿主指令面 mod 化盘点 = P4 规划，详见 §四 P4 节）：对 `src/commands/` **88 条真实指令**（另 19 个 stub 死代码不计；fork 原创 22 条，git 首提交日期实证）按当前能力面做可行性分档 —— ① **第一档 7 条**现在就能转正（`/remember` ctx.fs、`/goal` 事件驱动、`/version`、`/release-notes`、`/files`、`/knowledge`、`/stickers`），模式同 /diff、/handoff ② **第二档 ~14 条**「读宿主状态拼文本」（/cost、/context-text、/cache-stats、/diagnostics、/set-ticket 等，fork 原创集中区）：内置 mod 可直接 import 宿主单例，disk mod 形态需先补宿主数据面读数接口（v2.1 提过的 appState 接缝）③ **第三档 15 条** prompt 类（/commit、/review、/bughunter × 3 等）卡在 `prompt.compose` 未实现 —— 单项补齐收益最大的缺口，建议 P4 首项 ④ **第四档**核心宿主功能（会话管理/配置中枢/账户远端/渲染管线深耦合）明确不 mod 化。
>
> **v2.9 变更**（mod 管理并入 `/plugins`，删除 `/mods` 命令）：① **对齐上游** —— 官方把自带功能以 `cc-plugin-*` 插件形态发布，`/plugins` → Installed 页按 origin 分「User / Built-in」两段，空格切换、Enter 看详情。opencc 的 mod 就是同一类东西，却另开了一个 `/mods` 命令 —— 一套扩展系统两个管理面。② **新增 `src/mods/pluginView.ts`**：把 mod 投影成 `LoadedPlugin`，内建 mod → `<name>@builtin`（落 Built-in 段）、磁盘 mod → `<name>@mods`（落 User 段），沿用插件 UI 已有的列表/详情/启停组件 ③ **启停落到 `settings.enabledPlugins`**（`<name>@builtin` / `<name>@mods`），与真实插件同一个开关位；`loadMods()` 读取该设置，**被禁用的 mod 在 `import()` 之前就跳过**（加载器无沙箱，"未注册"必须等于"未执行"，而不是"接了线但不跑"）；`setModEnabled()` 写设置的同时立刻卸载 / 走 `reloadMods()` 恢复，不留「重启才生效」的尾巴 ④ **禁用的 mod 保留灰行**：新增 `registry.noteDiscoveredMod` / `getKnownMods` 记录"发现了但没加载"的 mod，否则关掉就等于从列表消失、再也开不回来 ⑤ 详情页对 mod 走独立的 `ModComponentsDisplay`（Commands / Handlers / Tools，不是插件的 skills/agents/MCP），菜单只有「Disable/Enable plugin」+「Reload mod」+「Back」，无 Mark for update / Update now / Uninstall ⑥ **删除 `src/commands/mods/`** 与命令注册。副作用（已知取舍）：mod 加载失败不再有专门的展示位（`/plugins` Errors 页读的是插件错误总线），只在 Reload mod 的结果行里回报失败数与 mod 名。
>
> **v2.10 变更**（mod 属性配置打通 `/plugins`，受约束 string 支持 `←/→`）：① **`opencc-mod.json` 新增 `userConfig`**，内建 mod 经 `BuiltinModSpec.userConfig` 声明 —— **键名与字段 schema 都直接复用插件的 `manifest.userConfig`**，不是新造一套：`/plugins` 的 "Configure options" 菜单项、`PluginOptionsDialog`、`loadPluginOptions`/`savePluginOptions`、`validateUserConfig` 全部零改动复用，存储键就是同一个 `name@marketplace` id ② **`ctx.options`** —— 插件靠 `${user_config.KEY}` 在 MCP/LSP 配置、hook 命令与 skill 正文里做文本替换，mod 是 JS 没有文本管线，改为注册时直接拿到值对象；**不套用 schema `default`**（"用户选了默认值"与"用户从没碰过"是两种状态，只有 mod 自己知道区别）。值在 `register()` 时读一次，改完需 "Reload mod" ③ **受约束的 string（`options: string[]`）渲染成 `←/→` 循环器**。形态对齐上游 `cc-plugin-agents-md`：官方把枚举写成 `"type":"string"` + `"options":[...]`，**不是新 enum 类型**，实测其 `mods/` 目录下 4 个开源 mod 里只有 `agents-md` 声明了 `userConfig`（`instructionFiles` 一个字段），`diff`/`sec-default`/`telemetry` 都没有 —— 多数插件根本没有属性配置，所以这条只扩展既有 `string`，不引入新类型 ④ `validateUserConfig` 新增越界校验：手改 settings.json 存了不在 `options` 里的值会被拒（否则用户会被困在一个循环器永远回不到的值上）⑤ **`←/→` 曾被外层 Tabs 抢走** —— `/plugins` 的 Tab 条把 `right`/`left` 绑到 `tabs:next`/`previous`，子对话框按 Tab 是切页而不是改值。复用列表搜索模式那条 `childSearchActive` 通道让 Tabs 在子对话框持有原始输入时让位 ⑥ **diff 内置 mod 配三个真选项**：`minColumns`（默认 110）、`pollIntervalMs`（默认 2000）、`listWindow`（默认 5）—— 每个默认值都与 `diff/constants.ts` 的上游常量 1:1，"未配置"即"上游值"，一个默认值悄悄偏离移植源的选项等于替上游做了没人验证过的声明。取值集中在新的 `diff/settings.ts`，脏值一律回落默认值而不是被钳到下限（`Number(null) === 0` 会把 null 变成最激进设置）⑦ **加载失败的 mod 不再出现在 Installed 列表**：`noteDiscoveredMod` 移到校验之后调用，否则一个导入被围栏拒绝的 mod 会显示成健康的 "enabled" 行，引诱用户去配置一个根本跑不起来的东西。
>
> **v2.11 变更**（事件体系对齐官方，v2.0 决策③「能力面收窄」的解除路径起点）：① **新增 `src/mods/protocol.ts`** —— 官方协议内核，纯逻辑无宿主依赖：109 个点分事件名（engine 事件 + op 事件；`$` 的每个方法本身都是一个可 hook 的 op）、`TIERS = [prepend, user, append, builtin, core]` 五档链与 `next.to` 下钻映射、深度 `freeze()`、结构化 matcher 求值器（`===` / `RegExp` / any-of / 对象 partial 四类叶子，递归上限 8）、每 hook `10s + 1s 宽限` 预算。**取证见新增的 [`mods-upstream-contract.md`](./mods-upstream-contract.md)** ② **事件名切换**：六个 settings.json 风格旧名（`PreToolUse`/`PostToolUse`/`UserPromptSubmit`/`SessionStart`/`SessionEnd`/`Stop`）降为**别名**，注册时经 `canonicalEvent()` 归一到点分名；`Notification` **不给别名** —— 上游无此事件，映射到 `ui.log` 会断言一个不成立的等价，宁可让旧写法被拒。旧名保留而非删除，因为它们是已发布 mod 的注册写法 ③ **matcher 不再压平成字符串** —— 此前 `normalizeMatcherValue` 把 `{tool:'Bash'}` 压成 `'Bash'` 交给宿主 `HookCallbackMatcher.matcher` 做字符串比较，四类叶子的语义全部丢失；现在结构化 matcher 由 `runModChain` 内部对（可能被上游 handler 改写过的）事件参数求值，**宿主 matcher 字段保持空** —— 它选的是 settings.json hook 配置，与 mod 过滤事件参数是两个不同的问题。顺带修掉一个潜在缺陷：结构化 matcher 遇到数组会做 any-of 元素匹配，这正是 `agents-md` 的 `{instructionFiles:{kind:[...]}}` 依赖的语义 ④ **五档 tier**：`{to:'core'}` 在注册时被 `splitTier()` 提升为独立的 `tier` 字段 —— 官方靠静态扫描禁 spread/computed key 来防 `to` 被伪造，拆成两个字段后这套扫描不再必要，因为 tier 与 matcher 已经是两件事；链内按 `tierRank` 排序，同档保持 mod 加载序 ⑤ **每 hook 独立预算**：`withBudget()` 用 `Promise.race` 而非直接 `await` —— abort 是请求，一个握着 pending promise 的 hook 可能永不响应，直接 await 会让整个事件挂在单个 mod 上；超时按失败计入熔断并继续跑下层与 core。附带信号联动（外层 abort 也要传到 hook）⑥ **`HOST_EVENT_BRIDGE` 过渡桥**：宿主 `HookEvent` 来自 `src/entrypoints/agentSdkTypes.js`，是**用户 settings.json 可配置的公开 SDK 契约**（不能改），而 `tool.call`/`prompt.context` 等点分名不在其中。桥接表把已有触发点的点分事件挂回宿主 hook，使现网行为不变；**未在表中的事件（如 `prompt.context`）注册后不会被 dispatch** —— 这正是后续要补真实挂载点、而不是只改名的原因 ⑦ **更正上游审计的一处错误结论**：`mods-upstream-audit.md` §5.2/§10 称 `$` 能力面「仅 4 个顶层命名空间」「mod 拿不到宿主文件系统 `fs`」。官方 `types/claude-code.d.ts` 的 `CoreEngineInterface`（:2016-3674）实为 **24 个 noun、含 `fs`/`store`/`clock`/`http`/`process`/`env`/`settings`/`session`/`turn`/`model`/`terminal`**，且开源的 `agents-md` 源码实际调用 `$.fs.ancestors()` / `$.session.root()` / `$.env.get()`。audit 自述该结论是「从 42 处调用点还原、minified 名有重名风险」的有损抽样，**不能当定义用**，该分叉决策的依据因此不成立。审计 §四/§六/§八/§十 其余部分仍有效。附带：`ui.render` 的同步 handler overload 排序修正后，`src/mods/renderChain.test.ts` 上一处长期预存的 TS2769 一并消失，**typecheck 基线归零**。
>
> **配套文档**：
> - [`mods-upstream-contract.md`](./mods-upstream-contract.md) —— **官方契约权威快照**（事件表 / `$` noun 面 / 协议守卫 / `prompt.context` 双向同步算法 / 11 个内建插件与加载条件）
> - [`mods-upstream-audit.md`](./mods-upstream-audit.md) —— 上游 v2.1.289 实现核验（**只记事实，不含方案**；§5.2 的能力面结论已被 contract 文档更正）
> - 本文件 —— opencc 方案决策（§2.3 摘要上游基线并标注分叉点）

---

## 一、结论先行

**技术上可行，且有一块现成资产能省掉最大成本。** 但有一个战略决策必须先拍，否则做出来也是负债。

### 三个核心判断

| 判断 | 依据 |
|---|---|
| **这是大功能，不是小改动** | 官方 Mods 实现横跨加载器 + 静态分析器 + Worker 运行时，含拒斥式 AST 校验、单插件崩溃归因、熔断、五层 tier 调度、三件套 dispatch（同步/流式/链式） |
| **opencc 零实现** | 源码与 22MB `dist/cli.mjs` 双向验证：`Bun.Transpiler` / `MODS_DIR` / `modsOffAt` / `plugin_function_hooks_worker` 全部 0 命中；web 侧 vendor 副本同样 0 命中 |
| **沙箱思路可借鉴，实现需重写** | fork 自有资产 `src/tools/WorkflowTool/runtime/`（**7 个非测试文件、1,076 行**）跑通了 `node:vm` 上下文，但**其 API 面是 workflow 专用 DSL，不是通用宿主 API 注入器** —— 详见 §1.2 |

### 1.1 v1.0 数字勘误（全部经实测复核）

v1.0 有若干数字在复核后证伪，此处更正以免后续估算失准：

| v1.0 说法 | 实测 | 影响 |
|---|---|---|
| WorkflowTool runtime「10,334 行」 | **1,076 行**（非测试）/ 2,432（含测试）/ 10,064（整个 `WorkflowTool/` 含测试） | 沙箱从「直接复用」降级为「借鉴思路重写」，P1 估时需上调 |
| 「31 个 hook 事件」 | **27 个** | 事件面比预期小，但 §3.3 的 Mod 事件模型未必覆盖全部 27 个 |
| `CLAUDE_PLUGIN_ROOT` 「12 文件」 | **10 文件** | 冲突结论不变 |
| `src/entrypoints/sdk/` 「14 文件」 | 13 | 无实质影响 |
| `src/utils/plugins/` 「51 文件」 | 53 | 无实质影响 |
| 「547 个组件」 | `src/components/**` 下 `.tsx`+`.ts` 共 **618** | UI 插槽成本估计基础偏保守 |
| `src/utils/sessionHooks.ts:93` | 路径为 `src/utils/hooks/sessionHooks.ts:93`（行号正确） | grep 会落空 |
| `REPL.tsx` | 实际在 `src/screens/REPL.tsx` | 同上 |

**`HOOK_EVENTS` 双份定义**（v1.0 说法成立，但需补充）：`src/entrypoints/sdk/coreTypes.ts:26` 与 `src/entrypoints/sdk/coreSchemas.ts:371` 各有一份，实测**当前内容完全一致（均 27 项）**。但 `HOOK_EVENTS` 符号在 **11 个文件**中出现（多数为 import 转发），排查"加事件要改哪"时应按 11 个文件而非 2 个核查。

### 1.2 关于「沙箱复用」的更正

v1.0 把 `src/tools/WorkflowTool/runtime/` 列为「**直接复用**」，实测 `vmContext.ts` 后不成立：

- `createWorkflowVmContext(api)` 的 API 面是**写死的** `agent`/`parallel`/`pipeline`/`workflow`/`budget`/`log`/`phase` —— 是 workflow 专用 DSL，不是通用注入器
- `runWorkflowScript` 走 `vm.runInContext` 跑**裸字符串**，显式封死 `importModuleDynamically`，无 `SourceTextModule`
- 结论：可借鉴 `codeGeneration:{strings:false,wasm:false}` 的封堵思路与 `vmRunner` 的超时/中止模式，**但通用加载器要新写**

### 1.3 必须先拍的决策

opencc 从 2026-04-30 的 0.20.x 分叉，**独立演进约 1791 提交**（`git log --oneline | wc -l`），同步方式是 per-file `git apply --3way`，`AGENTS.md` **明令禁 cherry-pick**。

在这个策略下自己实现 Mods，意味着**上游 Mods 后续每次变更都要手工重做一遍**。

| 路线 | 长期维护成本 | 获得能力 |
|---|---|---|
| **A. fork 自研，进同步名单** | 每次上游变更手工重打补丁 | 自己要什么有什么 |
| **B. fork 自研，明确不进名单** | 只付一次成本，永久分叉 | 同上，但跟上游 Mods 彻底分家 |
| **C. 等上游同步** | 零成本 | 滞后，且丢 fork 特色 |

**建议 B**：`src/mods/` 是纯新增目录，上游无同名文件，分叉不产生同步冲突。**必须在动手前把这条写进 AGENTS.md**，否则半年后没人记得为什么不同步。

---

## 二、现状盘点

### 2.1 opencc CLI 侧

**已有资产（可直接复用）**：

| 资产 | 位置 | 复用方式 |
|---|---|---|
| **27 个 hook 事件总线** | `src/utils/hooks.ts`（5280 行）| Mods handler 直接挂现有事件，**零新增分发层** |
| 多源合并/去重/`if` 过滤 | `getMatchingHooks:1800` | 免费继承 |
| `addFunctionHook` / `removeFunctionHook` 原语 | `src/utils/hooks/sessionHooks.ts:93` / `:120` | 现成的"注册函数到 hook 管线" + 最小 unload 原语（R9） |
| `type:'function'` 执行器 | `hooks.ts:2362` / `5273` | 已有 abort/timeout 包裹 |
| `hookSpecificOutput` 协议 | `src/types/hooks.ts:38` | Mods 返回值结构可复用 |
| Plugin 分发管道 | `src/utils/plugins/`（53 文件）| 复用 marketplace/安装/缓存/路径解析 |
| 插件目录解析先例 | `pluginDirectories.ts:53` `getPluginsDirectory()` | Mods 目录沿用同样的 env 覆盖模式 |
| 动态 `import()` 先例 | `src/integrations/artifactGenerator.ts:108` | **本方案加载路径的直接模板** |
| 动态工具模板 | `src/Tool.ts:508`、`MCPTool.ts:75` | 自定义工具照抄 MCPTool 形状 |
| `assembleToolPool` 合并 | `src/tools.ts:354` | 工具注入只改这里 |
| SDK 导出面 | `src/entrypoints/sdk/`（13 文件）| 有 `SdkMcpToolDefinition` 先例 |
| Ink 组件库 | `src/ink.ts`、`src/components/**`（618 个 `.tsx`/`.ts`）| 可直接用 `Box`/`Text`/`useApp` |
| **WorkflowTool vm 经验** | `src/tools/WorkflowTool/runtime/` | **借鉴封堵思路与超时模式，加载器另写** —— 见 §1.2 |
| 宿主通知通道 | `src/Tool.ts:225` `ToolUseContext.addNotification` | `ui.notice` 的现成单向推送通道（R3 缓解依据） |
| 动态命令合并 + 缓存失效 | `src/commands.ts:556` `getCommands`（dynamicSkills + plugin commands）+ `clearCommandMemoizationCaches` | `registerCommand` 的现成通道：注册进 registry + 失效缓存即可 |

**27 个事件的实际名单**（`coreTypes.ts:26`，`coreSchemas.ts:371` 内容一致）：

```
PreToolUse, PostToolUse, PostToolUseFailure, Notification, UserPromptSubmit,
SessionStart, SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop,
PreCompact, PostCompact, PermissionRequest, PermissionDenied, Setup,
TeammateIdle, TaskCreated, TaskCompleted, Elicitation, ElicitationResult,
ConfigChange, WorktreeCreate, WorktreeRemove, InstructionsLoaded,
CwdChanged, FileChanged
```

**三个真空**：

1. **无用户代码加载器** —— 产物是 `.mjs`（非 Bun SFX），无用户 JS 加载先例可抄（`artifactGenerator.ts:108` 加载的是自己生成的产物，不是用户代码）
2. **无 UI 插槽** —— 618 个组件散在多层目录，`src/screens/REPL.tsx` 为核心
3. **无运行时 `registerTool()`** —— `getAllBaseTools()` 是字面量数组

**高危冲突**：

| 冲突 | 说明 | 严重度 |
|---|---|---|
| `CLAUDE_PLUGIN_ROOT` 已被 10 文件占用 | Mods 复用会污染 MCP/插件路径解析 | **高** |
| `HOOK_EVENTS` 双份定义 | `coreTypes.ts:26` + `coreSchemas.ts:371`，加事件要同步两处（符号共出现在 11 个文件） | **高** |
| `getMatchingHooks` 硬编码 switch | 每事件写死 matchQuery | **高** |
| `assembleToolPool` 保 prompt-cache 排序 | `tools.ts:366-372`，插入工具会打乱 cache key | 中 |

### 2.2 opencc-web 侧

**Mods 相关代码 0 行。** 现有三套插件机制都不是「用户写代码扩展自己」：
1. vendored 上游插件系统（45 文件）—— 纯声明式，JSON manifest + `.md` 组件 + spawn 子进程 hook
2. `compat/plugins/` —— 子集重写，四个 loader 是空壳
3. 前端 PluginModal —— 纯管理 UI

**可搬**：路径围栏（`manifest.ts:148-205`）、事件名、manifest 形状、`buildTool`/`MainAgentLoadContext` 注册契约。

**用不上**：PluginModal、HTTP 路由层、marketplaceManager、vm 沙箱（v2.0 已改用原生 `import()`，见 §3.2②）。

**最大冲突**：web 侧底层假设「插件不改主进程状态」（`defaultHookExecutor.ts:80-86` 注释：*"This executor never returns `blocked: true` — it is a report-only executor"*），与 Mods「改行为 + 画 UI」**正面矛盾**。

> **本节前提**：web 侧 Mods 相关代码 0 行已复核（vendor 树下 `MODS_DIR`/`Bun.Transpiler`/`modsOffAt` 全部 0 命中）。R6 仍成立 —— CLI 侧新代码需手工同步回 vendor 副本。**v2.1 勘误**：vendor 副本实际根目录为 `packages/zn-agent-core/src/compat/`（`defaultHookExecutor.ts` 位于 `src/compat/plugins/`），v1.0/v2.0 所引的 `packages/zn-agent-core/src/opencc-src/src/` **不存在**。

### 2.3 官方 Mods 的实现基线（**上游现状，非 opencc 目标**）

> ⚠️ 本节记录的是 Claude Code v2.1.289 的**实测事实**，用于判断"哪些能借鉴、哪些必须分叉"。**opencc 已在 §3.1 明确有意分叉**（JS 而非 TS、原生 `import()` 而非 vm、窄能力面）。
>
> 核验方式：`strings -n 6` 全量抽取 229MB 二进制 → 53MB / 400,517 行 → 定位 Mods 实现所在的两个 chunk（加载器+静态分析器、Worker 运行时）。

```
主进程 → 每插件一个 Worker → 每插件一个 vm realm
```

**语言与加载**：
- mod 用 **TypeScript**（opencc 有意分叉为 JS）
- `Bun.Transpiler.transformSync`，`{loader, macro:false}`，**不做类型检查**；`.js` 直接返回不转译，仅 `.ts`/`.tsx` 走转译
- 带完整**行列错误映射**（把 `position.line/column` 拼回用户可见报错，并补偿前缀偏移）
- **跑在 Bun SFX 上** —— opencc 产物是 `.mjs`，运行时是 **Node ≥22**（`bin/opencc` shebang `#!/usr/bin/env node`；`build.ts` `target: 'node'`），`Bun` 全局在产物里只是 bundler shim。**这是无法复制的结构性差异。**

**静态扫描 —— 是"拒绝"而非"提取"**（v1.0 描述有误）：
- acorn 完整 AST 遍历，逐节点**抛异常拒斥**，实测规则：

| 类别 | 规则 |
|---|---|
| 动态 `import()` | 拒绝 —— 只允许 `import` 声明 |
| import 白名单 | 仅裸模块 `claude-code` + 相对路径；越界报 `resolves outside the plugin's folder` |
| `$.catch()` | 只能在调用点 `.catch(handler)`；一旦被赋值/传参/从嵌套函数返回即拒绝 |
| top-level await | **非 entry 文件**中出现即拒绝（entry 单独作为 async module 链接） |
| 体积上限 | 单文件 1MB / 总计 8MB / 扫描每 32 文件让出事件循环 |
| 提示 | `ScanRefusal` 异常带插件名、文件、编译行号、80 字符源码摘录 |

**注册契约**（**不是** `register(on)` 导出式，而是调用点扫描）：

```js
on("<event>", hook)                          // 简写
on("command.run", { command: "x" }, hook)    // matcher 必须是对象字面量
on("<event>", { to: "<tier>" }, hook)        // tier
```

`ScanRefusal` 默认消息写死了这条契约：
> `$ is always spelled $.noun.event(...) at the call site, on is always on("<event>", hook), and next.to always next.to(e, "<tier>")`

**`$` 实际能力面**（从 42 处调用点还原，**仅 4 个顶层命名空间**）：

```
agent.spawn          command.run        process.run / process.spawn
prompt.compose / prompt.read            turn.abort
ui.ask / copy / invalidate / log / notice
```

**没有 `fs`、没有 `store`、没有 `clock`、没有 `tools.register`。** 上游 mod **拿不到宿主文件系统**；mod 间协调靠 `telemetry` 流 + tier 下钻，不是共享 KV。

**tier 链**（实测，含下钻图谱）：

```
顺序:  prepend > user > append > builtin > core
下钻:  prepend:["append","builtin","core"]   user:[]
        append:["core"]   builtin:[]   core:[]
```

**dispatch 是三件套**：`dispatch`（同步）/ `dispatchStream`（流式，async iterable）/ `linkStreams`（链接）。`next()` 参数与 `next.to()` 楼层**运行时校验**，传错类型才炸。

**UI（`Client`）契约极严**：模块路径必须**字符串字面量**、必须**相对**、必须**在 plugin 目录内**（realpath + 相对路径双重校验）、`spread` 必须排在 `module` **之前**、组件必须 default 或单个 PascalCase 导出。

**Worker 隔离**：
- 崩溃是一等公民事件：`plugin_function_hooks_worker` / `respawned` / `crashed_worker`
- **单插件归因**：`culprit.plugin` + `evidence` 栈 → 只卸载肇事者，`workerDeaths++`
- 崩溃后追问该 mod 拦截了什么：`$.xxx` 拼成人话提示
- 熔断：`unattendedCrashes >= 阈值` → 批量 disable
- 心跳：`SIGKILL` 500ms / 宽限 2000ms
- **官方提供同线程逃生舱**：`CLAUDE_CODE_HOOKS_SAME_THREAD` 环境变量

**内置 6 个 mod**（`cc-plugin-diff` 等）—— 官方自己的功能就是 mod，走 in-memory 预编译通道（`registerScan`）绕过磁盘。

---

## 三、方案设计

### 3.1 总体策略

**只做 CLI 侧刚需，且在四个维度上明确分叉出上游。**

具体地：
- ✅ 事件拦截 / 改写 / 阻断（复用现有 27 事件，**不新增**）
- ✅ 运行时注册 command / tool / agent（**上游不支持，是 opencc 净增能力**）
- ✅ 基础 UI 插槽（toast / status / pane 三种）
- ✅ **mod 写纯 JavaScript**（上游写 TypeScript）—— 见 §3.2①
- ✅ **原生 `import()` 加载，无隔离**（上游用 vm realm + Worker）—— 见 §3.2②
- ✅ **能力面收窄到上游同款**（`fs`/`store`/`clock` 延后到 P2 授权制）—— 见 §3.3
- ❌ 不做五层 tier（简化为两档：`mod` < `core`）
- ❌ 不做 per-plugin Worker 与崩溃归因（列入 P2）
- ❌ 不做完整 render site 体系（只做 3 个）
- ❌ 不做流式事件（`dispatchStream` / `linkStreams`）—— **P1 取舍，代价见 §六 R8**

> **P1 保持克制是被运行时差异强制的**，不只是主动取舍：上游 mod 跑在 Bun SFX 上，opencc 跑 Node ≥22，`Bun` 全局、`/$bunfs/root/chunk-*.js` 内嵌文件解析、`Bun.embeddedFiles` 在 node 侧全部不存在。

### 3.2 关键技术决策

**① 语言：mod 写纯 JavaScript，不做 TS 转译**

**决策：mod 源码即 `.js`/`.mjs`，运行时不做任何转译。**

理由：
- **消除一整个依赖问题** —— 生产依赖里现无可用转译器（`typescript@5.9.3` 只在 devDependencies；`esbuild`/`sucrase`/`@swc/core` 均 absent）。走 JS 路线则**不需要新增生产依赖、不需要改 `scripts/externals.ts`、不需要往 22MB 产物里塞编译器**。
- **消除错误定位问题** —— 上游 `Bun.Transpiler` 最麻烦的不是转译本身，而是要把 `position.line/column` 拼回用户可见报错（`Jo()` + 前缀偏移补偿 `Xo`）。原生 JS 由 node 直接抛出，无此负担。
- **消除 Node/Bun 风险项 R2** —— 不再需要"用 `typescript` 替代 `Bun.Transpiler`"这个高危替代。

代价：
- mod 作者失去 TS 类型提示。建议在 mod 模板里附带 `// @ts-check` + JSDoc，或提供 `tsconfig.json` 用 `checkJs` 模式。
- 无法用 TS 特有语法（enum / namespace / 装饰器 / 参数属性）。JS-first 是 mod 生态常态（VSCode extension 早期、Figma plugin、Obsidian plugin 均为 JS）。

> **仍然保留的一条上游约束**（与转译器选谁无关，直接抄）：`.js` 文件**直接加载不处理**，只对显式声明的其他扩展名做处理；`macro:false` 等价的"不做类型检查/不做宏展开"语义。

**② 加载：原生 `import()`，不用 `node:vm`**

```ts
// 模板取自 src/integrations/artifactGenerator.ts:108
const mod = await import(pathToFileURL(entryPath).href)
```

理由：
- **零启动 flag 改动**。实测 `vm.SourceTextModule` 在 Node 25.6 上**不给 `--experimental-vm-modules` 直接抛错**；而 `bin/opencc` 的 `relaunchWithLongSessionHeapIfNeeded()` 有早退条件（已有 heap+gc flag 即 `return`），加 flag 必须连早退判定一起改，否则加了/没加 flag 的进程行为分叉。这是一处确定性成本。
- **窄能力面下，隔离的边际收益小**。§3.3 已把 API 面砍到上游同款（无 `fs`/`store`），危险操作压根不在 API 面上；`node:vm` 本身也**不是安全边界**（`codeGeneration:false` 挡得住 `eval`，挡不住 `this.constructor.constructor('return process')()` 这类逃逸 —— 只要注入了宿主函数对象，逃逸面就存在）。
- 复用仓库既有先例，无需新范式。

**接受的代价**：
- mod 与宿主同进程，mod 崩溃会波及 CLI。**必须**用 `try/catch` 包住每个 handler 调用（`hooks.ts` 的 `type:'function'` 执行器已有 abort/timeout 包裹，可借鉴）。
- 崩溃归因降级为"哪个 mod 的 handler 抛错"（由 §3.4 registry 记录当前 mod 名），不做上游那套 Worker 级归因与熔断。
- 若 P1 后期出现真实需求，`vm.SourceTextModule` 路线可作为 P2 增强（flag 改造点已在上面定位清楚）。

**③ 隔离：同进程，不做 per-plugin Worker**

理由（两条并列）：
- opencc 跑 Node，**没有上游依赖的 Bun Worker 运行时**，上游那套心跳自愈 + 单插件归因 + 熔断（`SIGKILL` 500ms / 宽限 2000ms / `unattendedCrashes` 阈值）要整体重写。
- **上游自己提供同线程逃生舱**（`CLAUDE_CODE_HOOKS_SAME_THREAD` 环境变量切 `"same-thread"`），说明同线程是官方认可的降级路径。

Worker 隔离与崩溃熔断列入 P2。

**④ 命名空间：独立目录 + 独立变量名**

```
src/mods/           # 新目录（上游无同名文件 → 分叉不产生同步冲突）
OPENCC_MODS_DIR     # 不用 CLAUDE_PLUGIN_ROOT（已被 10 文件占用）
```

目录解析沿用 `pluginDirectories.ts:53` `getPluginsDirectory()` 的既有模式：env 覆盖 → 默认目录，`~` 走 `expandTilde` 展开。

### 3.3 Mods 事件模型

复用现有 27 事件，**不新增**。

**注册契约：导出式（有意分叉上游的调用点扫描）**

```js
// my-mod/mods/register.js
export function register(ctx) {
  ctx.on('PostToolUse', { tool: 'Bash' }, async (e, next) => {
    const r = await next(e)
    ctx.ui.notice(`ran ${e.tool}`)
    return r
  })
}
```

**为什么不用上游的 `on("<event>", matcher, hook)` AST 扫描**：
- 导出式是**显式契约** —— 加载器直接调 `register(ctx)`，不需要猜调用点，静态分析压力小一个量级
- 上游那套拒斥式 AST 校验（动态 import 拒绝、`$.catch` 逃逸拒绝、top-level await 拒绝、体积上限）是**为它的调用点扫描模型服务的**，换模型后大部分规则不再必要
- 保留必要的：入口文件校验（必须是 `.js`/`.mjs`）、体积上限（单文件 1MB / 总计 8MB）、`register` 必须是函数

**handler 签名**（`next()` 之前 = before，之后 = after，与上游一致）：

```ts
type ModHandler = (
  e: ModEventInput,
  next: (e: ModEventInput) => Promise<ModEventResult>
) => ModEventResult | Promise<ModEventResult>
```

**实施注记（v2.2，已按实现终态更新）**：

- **`next()` 链 = 两档 tier 真包裹（已实现）**。`buildModHookMatchers` 为每个 (event, matcher) 组生成携带 `modChain` 原始链标记的 composite `HookCallback`；`executeHooks`（`hooks.ts`，所有 per-event executor 的唯一汇聚点）检测到标记后把 composite 提出扁平并行批次：mod 链作为**外层 tier** 顺序执行，terminal `next()` 经 `runModChain` 落到 `coreRunner`——并行执行全部核心 hooks 子集并返回聚合结果。非 mod 路径零改动；`executeHooksOutsideREPL`（-p 模式 SessionEnd 等）不包裹，composite 原样执行。
- **matcher 形状转换（已实现）**：对象 matcher（`{tool:'Bash'}`）在 registry 层经 `normalizeMatcherValue` 转为 string matchQuery（对照 `getMatchingHooks` 的 per-event 取值：tool/notification_type/source/reason/trigger）。
- **mod ctx 接缝（已实现）**：`engine.createModContext(mod)` 在 `register(ctx)` 调用时同步构建并注入 handlers/commands/tools 收集器；`ctx.fs` 按白名单惰性构建，`ui.status`/`ui.notice` 走模块级 bridge，REPL 经 `useSyncExternalStore` 消费。
- **命令列表刷新（实现期发现）**：`getCommands` 在 session-start hooks 之前被 await 定格，mod 命令启动后注册不可见 —— 经 `skillChangeDetector.notifyCommandsChanged()`（memo 层清除 + 信号）+ REPL 挂载追赶两段解决。

**能力面 `$` / `ctx` —— P1 收窄到上游同款**：

```ts
interface ModContext {
  // 事件注册（opencc 扩展：上游不能运行时注册 command/tool/agent）
  on(event, matcher?, handler): void
  registerCommand(spec): void
  registerTool(spec): void

  // 交互 —— 对齐上游命名空间
  ui: {
    notice(msg: string): void        // 上游有
    log(msg: string): void          // 上游有
    ask(question: string): Promise<string>   // 上游有
    toast(msg: string): void        // opencc 扩展（P1 唯一新增 UI 原语）
  }

  // 提示词组装 —— 对齐上游
  prompt: {
    compose(parts: string[]): string
    read(): Promise<string>
  }

  // 回合控制 —— 对齐上游
  turn: { abort(reason?: string): void }
}
```

**P1 明确不提供**（原 v1.0 设计的三个命名空间）：

| v1.0 提议 | 处置 | 理由 |
|---|---|---|
| `fs: { read; write; list; exists }` | **移出 P1**，P2 走显式授权 | 给了它，AST 拒斥器就成了唯一防线，而 `node:vm` 不是安全边界 |
| `store: { get; set }` | **移出 P1**，P2 评估 | 上游没有；mod 间协调在 P1 靠事件流，不靠共享 KV |
| `clock: { setTimeout; sleep }` | **移出 P1** | `setTimeout` 由宿主注入到 ctx 顶层即可，无需独立命名空间 |

**P2 的授权制设计**（若需要）：`settings.json` 里显式白名单授权的 mod 才看到 `ctx.fs`，未授权 mod 的 ctx 上该属性为 `undefined`。这样"能力面窄 ⇒ 沙箱可验证"的不变量在默认态保持成立，授权是可见、可审计、可撤销的。

**能力面收窄的连带影响**：`ui` 的 toast / pane / status 三种插槽里，只有 toast 属于"往宿主推信息"（mod → 宿主，方向安全）；pane / status 涉及宿主状态回读，**P1 建议只做 toast**，pane/status 列入 P2（见 §七 决策点 3）。

### 3.4 目录结构

```
src/mods/
├── manifest.ts        # ModManifestSchema（Zod，对齐 PluginManifestSchema 风格；注意 zod 当前为 phantom dep，见下）
├── loader.ts          # 发现 + 校验 + import() 加载
├── validate.ts        # 入口校验（扩展名 / 体积上限 / register 是函数）
├── registry.ts        # 生命周期管理（load / unload / reload / 当前 mod 追踪）
├── engine.ts          # ctx 对象构建（受控 API 面）
├── dispatch.ts        # next() 链 + 两档 tier（同步；流式列入 P2）
└── hooks.ts           # 接入现有 hook 管线
```

> **注意**：**没有 `transpile.ts`**（JS 方案）、**没有 `sandbox.ts`**（import() 方案）。相比 v1.0 少两个文件。

Mod 目录约定：

```
my-mod/
├── opencc-mod.json           # { name, version, entry: "./mods/register.js" }
└── mods/
    ├── register.js           # export function register(ctx) { ... }
    └── lib/util.js           # 相对路径 import 允许
```

**加载器安全约束**（P1 实现，v1.0 缺失）：

- 入口必须是 `.js` / `.mjs`（其他扩展名拒绝）
- 单文件 ≤ 1MB、mod 总量 ≤ 8MB
- 相对路径 import 解析后 **realpath 必须在 mod 目录内**（照抄上游 `h2e()` 的 `relative()` + `startsWith('..')` 双重校验）
- 只允许相对路径 import；裸模块 specifier 拒绝（照抄上游白名单思路，上游只放行 `claude-code`，opencc **一个都不放行**）
- 每次 handler 调用包 `try/catch`，错误归因到当前 mod 名

---

## 四、分阶段实施

### P0 — 可行性验证（1–2 人天）✅ 已完成（随 P1 实现一并验证）

> **目标：把剩下的未知数变成已知数。**（v1.0 的三个 P0 项中，转译对照实验已因 JS 决策删除）
>
> **v2.1 注**：下表前两项已有强证据，降级为**确认性检查** —— ① 加载链路：`artifactGenerator.ts:108` 的同款 `import(pathToFileURL())` 已在 `dist/cli.mjs` 产物内运行；② 异常边界：`executeFunctionHook`（`hooks.ts:2379`）已带 timeout + signal 包裹。P0 实际重心在**目录围栏**与**事件面映射**。

| 任务 | 验收标准 |
|---|---|
| `import()` 加载链路 | 原生 `import(pathToFileURL(...))` 能否在 `dist/cli.mjs` 产物内正常加载外部 `.js` 并拿到导出？相对路径 import 是否解析正常？ |
| 异常边界 | handler 抛错时，`hooks.ts` 的 `type:'function'` 执行器是否正确隔离？错误能否归因到具体 mod？ |
| 事件面映射 | 27 个 hook 事件中，哪些能承载 mod 语义？确认 P1 实际支持子集（预计 `PreToolUse`/`PostToolUse`/`UserPromptSubmit`/`SessionStart`/`SessionEnd`/`Stop`/`Notification` 七个够用） |
| 目录围栏 | realpath 越界检测在 symlink / `..` / 绝对路径三种绕过手法下都拒绝 |

**决策门**：P0 不通过则整个方案重新评估，不要硬推。

### P1 — 最小可用（9–14 人天）✅ 已实现（`src/mods/`，feat/mods-p1）

| 任务 | 估计 | 产出 |
|---|---|---|
| mod 发现 / manifest / 校验 | 2–3 | `manifest.ts` + `validate.ts` + 目录约定 + realpath 围栏 |
| `import()` 加载器 + registry | 2–3 | `loader.ts` + `registry.ts`（load / unload / 当前 mod 追踪） |
| 事件接入 + `next()` 链 | 2–3 | `hooks.ts` + `dispatch.ts`（两档 tier，同步） |
| 注册 API 打通 | 2–3 | `registerCommand` / `registerTool` 两通道（agent 注册视需要再议） |
| `ui.notice` 单一插槽 | 1–2 | 只做 mod → 宿主单向推送 |
| 测试 + 5-phase 验证 | 2–3 | build / typecheck / test / TUI / debug log scan |

**验收**：写一个 opencc 自己的 mod（比如上下文用量指示器），能加载、能发 notice、能注册一个 tool、能拦截一次 `PostToolUse`。

> **P1 明确不做**：卸载（unload）留到 P2 会造成"加载了撤不掉"的用户可感知缺陷，**P1 必须包含最小 unload**（从 hook 管线摘除 + registry 移除）。

### P2 — 加固（12–18 人天）✅ 已实现（v2.2 变更注记录实现方式）

- **最小可用 unload / reload**（若 P1 只做了 unload，reload 放这里）
- `ctx.fs` 授权制（settings 白名单 + 运行时可见性）
- 流式事件（`dispatchStream` / `linkStreams`）
- pane / status UI 插槽（涉及宿主状态回读）
- 三档 tier 权限模型
- 崩溃归因与熔断（仿上游 `unattendedCrashes`）
- 与 `/plugin` 菜单集成
- 遥测埋点

### P3 — 对标上游（12–18 人天）⬜ 未实现（后续阶段）

- `vm.SourceTextModule` 隔离（需先解决 `--experimental-vm-modules` flag 与 `bin/opencc` 早退条件的联动）
- per-plugin Worker + 心跳自愈
- 完整 render site 体系 + `Client` 重绘循环
- 组合 mod 的名词契约机制
- in-memory 预编译通道（`registerScan` 等价物）

### P4 — 宿主指令面 mod 化（v2.8 盘点，⬜ 未排期）

> **背景**：/diff（v2.5）、/handoff（v2.6）、mermaid（v2.7）三条转正先例跑通后，对 `src/commands/` 全量指令做一次可行性盘点。判据 = 当前能力面（`registerCommand` local/local-jsx、7+1 事件、`ui.notice/status/pane`、授权 `ctx.fs`）× 指令的宿主耦合深度。fork 原创性按 git 首提交日期实证（基线 2026-04-07 之前 = 上游继承）。

**第一档 — 现在就能转正（7 条，模式同 /diff、/handoff）**

纯 local 文本输出、零宿主单例依赖，内置 mod 形态即可落地：

| 指令 | mod 化路径 | fork 原创 |
|---|---|---|
| `/remember` | 写记忆文件 → `ctx.fs` 授权制教科书场景 | ✅ |
| `/goal` | 目标 gate → `UserPromptSubmit` 事件自实现，语义最契合 mods | ✅ |
| `/knowledge` | `ctx.fs` 覆盖大半；settings 读写部分需补 API | ✅ |
| `/version` | 读构建常量，零依赖 | |
| `/release-notes` | mod 内全局 `fetch` 可用 | |
| `/files` | local-jsx `call` 拿 `ToolUseContext`（v2.6 已支持） | |
| `/stickers` | 彩蛋，零风险试点 | |

**第二档 — 可搬，建议先补「宿主数据面」（~14 条，fork 原创集中区）**

共性是「读宿主状态 → 拼文本」：内置 mod 可直接 import 宿主单例（同 diff mod 用 gitRunner），但要以 **disk mod** 形态存在或供社区复刻，需 mods 面暴露宿主读数接口（token 用量 / 成本 / LSP 诊断 / 缓存指标 —— 即 v2.1 提过的「appState 接缝」）：

`/cost`、`/context-text`、`/context`、`/cache-stats`、`/diagnostics`、`/request-size`、`/set-context-window`、`/clear-context-window`、`/commit-message`、`/advisor`、`/benchmark`、`/cache-probe`、`/set-ticket`（fork 标志性命令，`ui.status` 恰好承载会话标签显示）；`/heapdump`、`/keybindings` 另需宿主原语（v8 dump / spawn 编辑器）。

**第三档 — 卡在 `prompt.compose` 未实现（15 条，最高杠杆缺口）**

prompt 类指令（注入提示词给模型）在当前能力面无对应物。**`prompt.compose` 是解锁这 15 条的单点钥匙**，建议作为 P4 首项：`/commit`、`/commit-push-pr`、`/review`、`/security-review`、`/init`、`/init-verifiers`、`/insights`、`/auto-fix`、`/dream`、`/statusline`、`/bughunter` × 3、`/pr-comments`、workflows 动态子命令。

**第四档 — 明确不 mod 化（核心宿主功能）**

- **会话/上下文管理**（直接操纵消息树，mod 化是风险不是收益）：`/clear` `/compact` `/rewind` `/branch` `/resume` `/export` `/copy` `/rename` `/tag` `/memory`
- **配置中枢**（宿主设置本体）：`/model` `/provider` `/config` `/permissions` `/hooks` `/agents` `/mcp` `/plugin` `/sandbox` `/theme` `/vim` `/skills` 等
- **账户/计费/远端**（凭证 + 外部服务）：`/login` `/logout` `/usage` `/bridge` `/session` `/desktop` `/update` 等
- **渲染管线深耦合**：`/focus`（改 systemPromptSections）、`/color`

**结论**：① 第一档随时可做，`/remember`（ctx.fs）与 `/goal`（事件驱动）价值最高，兼作能力面实战验证 ② fork 原创 22 条中 9 条落在前两档 ③ 「宿主数据面接口」与 `prompt.compose` 是两个前置补齐点，后者杠杆最大。

---

## 五、工作量汇总

| 阶段 | v1.0 估 | **v2.0 估** | 变化原因 |
|---|---|---|---|
| P0 可行性 | 2–3 | **1–2** | 转译对照实验删除 |
| P1 最小可用 | 14–21 | **9–14** | 删转译层（2–3）、沙箱对接降为 import() 加载（3–4→2–3）、UI 插槽收窄为单一 notice（3–5→1–2） |
| P2 加固 | 10–15 | **12–18** | 新增 `ctx.fs` 授权制、流式事件、pane/status |
| P3 对标上游 | 15–20 | **12–18** | Worker 隔离后移，vm 隔离需先做 flag 改造 |
| **合计** | **41–59** | **34–52** | **净减 7–7 人天** |

**现实节奏**：按 opencc 惯用的「1–2 周一个可交付切片」，P1 约 **2–3 周**，完整 Mods 约 **1.5 个月**（v1.0 估 1.5–2 个月）。

> **注**：P1 虽净减，但 §1.2 指出沙箱从「直接复用」降级为「另写加载器」—— 这一项已在 P1 的「`import()` 加载器 + registry」中按 2–3 人天计入。若 P0 发现 `import()` 加载链路有意外阻碍，**P1 需回补 1–2 人天**。

---

## 六、风险清单

| ID | 风险 | 级别 | 缓解 |
|---|---|---|---|
| **R1** | **同步策略冲突** —— 明令禁 cherry-pick，自研 Mods 每次上游变更都要手工重打 | 高 | 动手前先定路线（建议 B），并写进 AGENTS.md。**缓解依据：`src/mods/` 是纯新增目录，上游无同名文件 → 分叉不产生同步冲突** |
| **R2** | ~~**Node vs Bun 隐性分叉**~~ | ~~高~~ | **已消解** —— JS 方案不做转译，不触碰 `Bun.Transpiler`。运行时差异（Node vs Bun SFX）仍存在，但只影响"不追平上游"的范围取舍，不再是技术风险 |
| **R3** | **TUI 并发模型无先例** —— 外部代码向 Ink 单线程渲染循环推送内容，pane/status 级插槽无先例 | 中高 | P1 只做单向（mod → 宿主）的 `ui.notice`；不做宿主 → mod 主动唤醒；**pane/status 移出 P1**。单向通道已有现成先例：`ToolUseContext.addNotification`（`src/Tool.ts:225`） |
| **R4** | `HOOK_EVENTS` 双份定义易漏改 | 中 | 复用现有 27 事件 = 零改动；加事件时用脚本校验两处一致（注意符号共出现在 11 个文件） |
| **R5** | `assembleToolPool` prompt-cache 排序被打乱 | 中 | Mod 工具插入遵守现有排序规则，加断言测试 |
| **R6** | web 侧 vendor 同步 —— CLI 侧新代码需手工同步回 vendor 副本（实际根：`packages/zn-agent-core/src/compat/`，v2.0 所引 `src/opencc-src/` 路径不存在） | 中 | Mods 核心代码放 CLI 仓，web 侧只 vendor 消费；加 `verify-server-types-self-contained` 守卫 |
| **R7** | ~~**mod 有完整机器权限**~~ | ~~中~~ | **前提已更正** —— v1.0 假设 mod 拿到 `fs`/`store`，风险成立；**v2.0 能力面收窄后该前提不成立**。P1 的 mod 无文件系统访问能力。真实残余风险是「同进程无隔离」，见 R8 |
| **R8** | **同进程无隔离** —— 原生 `import()` 加载，mod 与宿主共享进程，崩溃会波及 CLI | **中高** | ① 每次 handler 调用 `try/catch` 包裹，错误归因到 mod 名 ② 复用 `hooks.ts` 的 `type:'function'` abort/timeout 包裹 ③ P2 视真实需求引入 `vm.SourceTextModule` 隔离（flag 改造点已定位） |
| **R9** | **无卸载路径** —— 加载后无法在会话内撤销 | 中 | P1 必须含最小 unload（从 hook 管线摘除 + registry 移除；原语已存在：`removeFunctionHook`，`sessionHooks.ts:120`）；完整 reload 放 P2 |
| **R10** | **JS-first 降低 mod 作者体验** —— 无类型提示，生态偏小 | 低 | mod 模板附带 `// @ts-check` + JSDoc；提供 `checkJs` 模式 tsconfig；文档说明可用 `tsc` 自行编译 |
| **R11** | **事件面覆盖不足** —— 27 个 hook 事件未必都适合承载 mod 语义 | 中 | P0 第四项验收"事件面映射"；P1 先支持 7 个核心事件，明确列出不支持清单 |

---

## 七、给超哥的决策点

1. **路线**：B（fork 自研、不进同步名单）还是别的？—— 建议 B，`src/mods/` 纯新增目录不产生同步冲突
2. **范围**：只做 P0+P1 最小可用，还是一路推到 P3 对标上游？
3. **UI 范围**：**P1 只做 `ui.notice` 单向推送**（v1.0 的 toast/status/pane 三种 → 收窄为一种），pane/status 移 P2。是否接受？
4. **`ctx.fs` 何时给**：P2 的授权制（settings 白名单）是否够用？还是要 P1 就给？
5. **是否开源**：mod 生态要不要单独建仓库？
6. **P4 排期顺序**（v2.8）：先做 `prompt.compose`（解锁 15 条 prompt 类指令，杠杆最大）还是先清第一档 7 条轻量转正？第二档是否值得为 disk mod 形态补「宿主数据面」接口，还是只走内置 mod 直 import 宿主单例的捷径？

---

## 附录 A：证据来源

| 报告 | 路径 | 状态 |
|---|---|---|
| **官方 Mods 实现核验（本轮重做）** | [`docs/mods-upstream-audit.md`](./mods-upstream-audit.md) | ✅ **已落库，可复现** |
| 官方 Mods 深度报告（v1.0 引用） | `~/Desktop/claude-code-mods-report.md` | ⚠️ 本仓外，未核验 |
| opencc CLI 扩展机制审计 | ~~`/tmp/opencc_extension_audit.md`~~ | ❌ **已被系统清理，不可复现** |
| opencc 与上游差距分析 | ~~`/tmp/opencc_mods_gap.md`~~ | ❌ 同上 |
| opencc-web 插件机制审计 | ~~`/tmp/opencc_web_plugin_audit.md`~~ | ❌ 同上 |

> **v2.0 的证据链**：上游事实 → [`mods-upstream-audit.md`](./mods-upstream-audit.md)（基于 v2.1.289 二进制 strings 实证，含方法学限制说明）；opencc 侧事实 → 附录 C 实测命令。v1.0 依赖的三份 `/tmp` 报告已丢失，不再引用。

## 附录 B：上游核验基线（可复现）

```bash
# 抽取（53MB / 400,517 行）
strings -n 6 /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe \
  > ~/.agent_working_dir/claude-raw/2.1.289/raw/all-strings.txt
```

| 项 | 值 |
|---|---|
| 版本 | **2.1.289**（`/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code`） |
| 二进制 | 229MB |
| Mods 实现位置 | `all-strings.txt` 第 **330001–330003** 行（加载器 + 静态分析器 + 体积常量）、第 **337639** 行（Worker 运行时 / tier / 崩溃归因） |
| 遥测事件名 | `plugin_function_hooks_worker`、`plugin_function_hooks_worker_mods`、`plugin_function_hooks_load`、`plugin_bundled_register` |

**关键符号索引**（便于复核 §2.3；`→` 后为 `all-strings.txt` 行号）：

| 符号 | 含义 | 位置 |
|---|---|---|
| `qEn` | TS→JS 转译器（`Bun.Transpiler`，`macro:false`） | 330001 |
| `h5o` | 动态 `import()` 拒斥 | 330003 |
| `ee` | `$.catch` 逃逸拒斥 | 330002 |
| `kr` | `Client` UI 契约校验 | 330002 |
| `y5o` | 扫描入口（构造 `ScanRefusal` 的 `refuse` 闭包） | 330003 |
| `Lo` | `ScanRefusal` 异常类（带插件名 / 文件 / 行号 / 源码摘录） | 330003 |
| `h2e` | 路径围栏校验（realpath + `relative()` 越界检测） | 330001 |
| `qae` | `CLAUDE_CODE_HOOKS_SAME_THREAD` → `"same-thread"` / `"worker"` | 337639 |
| `zae` / `rBt` | `modsOffAt` 状态机（关闭 / 恢复计时） | 337639 |
| `MD` | worker 崩溃归因（`culprit.plugin` + `evidence`） | 337639 |
| `ho` / `jo` / `er` | 32 文件节流 / 1MB 单文件 / 8MB 总量 | 330002 |
| `oe` / `Er` | `"Client"` / `"h"`（UI 契约 AST 匹配锚点） | 330002 |

## 附录 C：opencc 侧核验命令

```bash
# 27 个事件（两处定义内容一致）
node -e "const s=require('fs').readFileSync('src/entrypoints/sdk/coreTypes.ts','utf8');
  const i=s.indexOf('HOOK_EVENTS = ['),j=s.indexOf(']',i);
  console.log(s.slice(i,j+1).match(/'([^']+)'/g).length)"

# 沙箱实况（1,076 行非测试，非 v1.0 所说的 10,334）
find src/tools/WorkflowTool/runtime -name '*.ts' -not -name '*.test.ts' | xargs wc -l

# 运行时是 Node 不是 Bun
head -1 bin/opencc                                   # #!/usr/bin/env node
node -e "console.log(require('./package.json').engines)"   # { node: '>=22.0.0' }
grep -n "target: 'node'" scripts/build.ts

# vm 模块需 flag（不带 --experimental-vm-modules 直接抛错）
node --experimental-vm-modules -e "new (require('vm').SourceTextModule)('export const a=1')"
```

> **建议同步修正 `AGENTS.md`**：技术栈表里 `Runtime | Bun` 有歧义 —— `bun` 是**构建工具链**（`bun run build`），产物运行时是 **Node ≥22**。本文档 §3.2② 与附录 C 的核验都曾栽在这一点上。
