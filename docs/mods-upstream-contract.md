# 官方 Mods 契约快照（2.1.296）

> 本文件是**对齐工作的权威基准**。所有结论按证据强度标注来源，冲突时以本文件为准。
> 取证源：
> - **GitHub** `anthropics/claude-code` → `mods/`（`types/claude-code.d.ts` 13186 行 + 4 个开源 mod 源码）
> - **二进制** `~/source/claude-2.1.296/bundle.js`（43 MB，109 个点分事件名、事件协议守卫、`prompt.context` 合并算法）
> - 三个版本的注册表逐字比对（2.1.287 / 2.1.292 / 2.1.296 插件集合一致）
>
> **本文件描述的是上游，不是 opencc 的现状。** 两者的差集见
> [`mods-upstream-gaps.md`](./mods-upstream-gaps.md) —— 读本文前先读那份，
> 否则会以为下游已经具备这里描述的全部机制。

## ⚠️ 本文推翻 `mods-upstream-audit.md` 的两条结论

| audit 的结论 | 实况 | 证据 |
|---|---|---|
| §5.2「`$` 能力面仅 4 个顶层命名空间」「mod 拿不到宿主文件系统 `fs`」 | **错**。`CoreEngineInterface`（d.ts:2016-3674）有 **24 个 noun**，含 `fs` / `store` / `clock` / `http` / `process` / `env` / `settings` / `session` / `turn` / `model` / `terminal` | d.ts:2738 `fs`、:2860 `store`、:2893 `clock`、:3012 `env`；agents-md 源码实际调用 `$.fs.ancestors()` / `$.session.root()` / `$.env.get()` |
| §10「能力面 4 个命名空间」作为 opencc 保持项 | 分叉依据不成立 | 同上 |

audit 记录的是 v2.1.289 口径，且 §5.2 自述「$ 方法名从 42 处调用点还原，minified 名有重名风险」——**它是一次有损抽样，不是定义**。d.ts 是官方签名的发布产物，可直接引用。

audit §四（静态扫描拒斥规则）、§六（tier 链）、§八（Worker 隔离）、§十（分叉决策）仍然有效，**但 §5.2 与 §10 的「能力面」行需按本文修正**。

---

## 一、事件总线：三层来源统一成一种注册

官方只有一种注册形状，**109 个事件名**（bundle @3646702 全量字面量）：

```
on('<event>', hook)              // 全事件
on('<event>', matcher, hook)     // 带过滤（matcher 必须是对象字面量）
```

### 1.1 engine 事件（宿主主动发出）

| 分组 | 事件 |
|---|---|
| prompt | `prompt.submit` `prompt.read` `prompt.fill` `prompt.suggest` `prompt.edit` `prompt.autocomplete` `prompt.section` `prompt.context` `prompt.attachment` `prompt.mention` `prompt.compose` |
| tool | `tool.call` `tool.check` `tool.describe` `tool.list` `tool.register` |
| session | `session.start` `session.end` `session.send` `session.receive` `session.append` `session.attach` `session.detach` `session.messages` `session.cwd` `session.root` `session.model` `session.turns` `session.id` `session.repo` `session.surfaces` `session.surface` `session.usage` `session.version` `session.compact` `session.authorize` `session.measure` |
| turn | `turn.start` `turn.complete` `turn.step` `turn.abort` |
| ui | `ui.render` `ui.resolve` `ui.press` `ui.input` `ui.select` `ui.message` `ui.scroll` `ui.focus` `ui.blit` `ui.copy` `ui.notify` `ui.fault` |
| 其它 engine | `agent.offer` `agent.spawn` `model.complete` `model.fork` `model.classify` `attribution.text` `skill.prompt` `plugin.register` |

### 1.2 op 事件（`$` 的每个方法都是一个可 hook 的 op）

**这是核心机制**：`$` 上每个方法调用都会过一次 dispatch，所以 mod 能 hook 宿主自己的动作，而不只是 engine 事件。

`fs.*` `store.*` `clock.*` `http.*` `process.*` `env.*` `settings.*` `state.*` `telemetry.*` `flag.value` `audio.*` `mcp.*` `mcp.connect` `ui.open` `ui.close` `ui.panes` `ui.status` `ui.toast` `ui.log` `ui.notice` `ui.invalidate` `prompt.submit` `prompt.read` `prompt.compose` `tool.register` `tool.list` `command.run` `command.list` `command.register` `config.list` `config.set` `agent.register` `turn.abort` `engine.create`

### 1.3 classic 通道

`classic.Setup` / `classic.PreToolUse` / `classic.SessionEnd` 等（bundle @10904719 `ZQt`）——老 hook 事件名的兼容层，与 mod 通道并存。

---

## 二、`$` = `CoreEngineInterface`（19 noun，d.ts:2016-3034）

> **更正**：本节此前写「24 noun」，并在表尾混入 `terminal`/`desktop`/`mobile`/`vscode`。
> 逐行统计 `CoreEngineInterface`（2016–3034，6 空格缩进的顶层成员）实为 **19 个**；
> 那 4 个的行号（3106/3127/3145/3161）落在紧随其后的
> `export type Elements = {`（3105–3172）里 —— 那是每种渲染表面的**组件表**
> （`Text` `Button` `Input` …），不是 `$` 的能力面。原表格 23 行却写「24」。
> opencc 未实现这 4 个，错误止于本文，没有传导进代码。

| noun | @行 | 方法 |
|---|---|---|
| `plugin` | 2020 | `name` `root` |
| `ui` | 2034 | `notice` `invalidate` `blit` `resolve` `log` `ask` `toast` `status` `open` `close` `panes` `scroll` `focus` |
| `model` | 2232 | `complete` `fork` `classify` |
| `audio` | 2286 | `play` `speak` |
| `mcp` | 2319 | `call` |
| `session` | 2345 | `messages` `cwd` `root` `model` `turns` `id` `repo` `surfaces` `surface` `usage` `version` `compact` `authorize` |
| `turn` | 2476 | `abort` |
| `prompt` | 2495 | `submit` `read` `fill` `suggest` `compose` |
| `tool` | 2561 | `list` `call` `check` `register` |
| `command` | 2614 | `list` `run` `register` |
| `config` | 2655 | `list` `set` |
| `agent` | 2685 | `spawn` `list` `register` |
| `fs` | 2738 | `read` `write` `list` `exists` `stat` **`ancestors`** |
| `store` | 2860 | `get` `set` `delete` `keys` |
| `clock` | 2893 | `now` `sleep` `after` `every` |
| `http` | 2932 | `fetch` |
| `process` | 2961 | `run` |
| `settings` | 2987 | `read` |
| `env` | 3012 | `get` `set` |

各渲染表面的组件表另见 `Elements`（d.ts:3105）：`terminal` 组件表含 `Raster` `Image`，
`desktop` / `vscode` 含 `Svg`，`mobile` 不含输入类组件。

`fs.ancestors({ names, of?, below? })` 是逐级目录 walk —— **agents-md 的 AGENTS.md 加载完全依赖它**。

`fs` 的边界是**路径**而非身份：`d.ts:2738-2751` 说路径相对工作目录或绝对、插件自带文件在
`$.plugin.root` 之下、单次读 4 MiB 上限。**没有 allowlist** —— opencc 曾经有的
`settings.mods.authorized` 白名单是分叉产物，已移除。

**noun 可被插件扩展**：`EngineInterface extends CoreEngineInterface`（d.ts:3674），插件通过 `engine.create` 事件 ADD 自己的 noun。`$.telemetry` 就是 telemetry 插件 ADD 的，其他插件（agents-md）用它上报，并用 `quietly()` 吞掉「telemetry 插件没加载」的异常。

---

## 三、协议守卫（bundle 事件表对象，audit 未覆盖）

> **opencc 未实现本节。** `checkArgument` / `restoreArgument` / `measureArgument` /
> `restoreResult` 在 `src/mods/` 零命中。opencc 只有 `cloneAndFreeze`（冻结载荷）
> 与结构化 matcher，没有「非法改动回落到上一个合法值」这一层。
> 移植本节前不要假定下游已有对应保护。

每个事件在 bundle 里登记为一个描述对象，形如：

```js
var Yi = {
  event: "prompt.context",
  restoreArgument: Gi,                                   // 结果非法时回落到上一个合法值
  checkArgument: gr,                                     // (next, prev) => 违规原因字符串 | undefined
  measureArgument: (e, t) => wr(e, t, []),               // 参数改动量（预算/熔断度量）
  settle: Ki,                                            // 结果规范化
  restoreResult: zi,                                     // 结果非法时的回落
  check: C(gr),                                          // 结果校验
  measure: wr,                                           // 结果改动量
}
```

`checkArgument` 返回字符串即为违规原因，可读性极高，例如：

- `"a changed origin (the engine set it; next(e) passes it on)"` —— `origin` 字段由引擎设定，hook 改它是非法
- `"a changed key (what the person pressed; next(e) passes it on)"`
- `"no { text, inputText } (strings)"`
- `"a { cursor, start, end } outside the text (whole offsets, ordered)"`

**语义**：`e` 是 `Frozen<T>`（d.ts:3974 深度冻结，`e.command = "ls"` 运行时直接 throw）；hook 通过 `next(e)` 传新对象给下一层，非法改动会被守卫发现并回落到上一个合法值，而不是让整条链崩掉。

---

## 四、`prompt.context` 的双向同步算法（bundle `Wi` 函数）

事件载荷是 `{ blocks, instructionFiles }`：

- `blocks`：具名文本块数组，其中一块 `name === "claudeMd"`
- `instructionFiles`：`{ path, kind, content, parent? }[]`，`kind ∈ {managed, user, project, local, memory}`

宿主 resolver（bundle @9014968）：

```js
CYn = (computeCore) => {
  if (!Jl("prompt.context")) return;        // 无订阅者 → 连 core 都不算（惰性）
  const core = computeCore()
  return dispatch("prompt.context", core).then(
    (r) => ({ blocks: r.blocks, instructionFiles: r.instructionFiles }),
    (err) => (logError(`prompt.context: the dispatch failed, the context stands as core computed it: ${err}`), core)   // 失败回落 core
  )
}
```

合并算法（语义化重写）：

```
sync(mod, core):
  if core.instructionFiles is undefined:  return { ...mod, instructionFiles: undefined }

  files        = mod.instructionFiles ?? core.instructionFiles
  text         = mod.blocks 里 claudeMd 块的文本
  textChanged  = text !== core 的 claudeMd 文本
  filesChanged = files 深比较 !== core.instructionFiles

  # 只改了文件列表 → 用文件重建 claudeMd 块
  if !textChanged && filesChanged && files !== undefined:
      return { ...mod, blocks: rebuildClaudeMdBlock(mod.blocks, files), instructionFiles: files }

  # 文本没变，或 files 恰好等于由 files 渲染出的文本 → 采信 files
  if !textChanged || (files !== undefined && text === render(files)):
      return { ...mod, instructionFiles: files }

  # 两者都改且不一致 → 文本为准，文件视为 unknown
  log("prompt.context: a hook changed the claudeMd text and the instruction files in one step; the text stands and the files read as unknown")
  return { ...mod, instructionFiles: undefined }
```

**这条规则是移植 agents-md 的前提**：hook 只改 `instructionFiles`（加文件）而不碰 `blocks`，引擎会自己把 `blocks` 里的 `claudeMd` 重建。

---

## 五、tier 链

```js
TIERS = ["prepend", "user", "append", "builtin", "core"]   // d.ts:9743
```

同事件的 hook 按此序嵌套。`next.to(e, tier)` 让控制权下钻给更低层，各层可下钻的层：

| tier | 可下钻到 |
|---|---|
| `prepend` | `append` `builtin` `core` |
| `user` | （无） |
| `append` | `core` |
| `builtin` | （无） |
| `core` | （无） |

dispatch 三件套：`dispatch`（同步）/ `dispatchStream`（流式，返回 async iterable）/ `linkStreams`。

**hook 失败语义**（d.ts:3239）：*"a hook that fails is skipped: the hooks beneath and core run in its place, **or its last `next` result stands**; the failure is reported by name."* —— 单个 hook 失败只跳过自己，下层与 core 照跑。

> **更正**：原文在此写「10s 预算 + 1s 宽限」。上游有三个时钟
> （d.ts:4237 / :4245 / :4253）：`ms` = 10000 是 hook 预算；`catchMs` = 1000 是
> *".catch handler's grace: a fresh budget from the moment it is called"*，
> 属于一种 opencc 没有的 handler 形状；`lingerMs` = 5000 是
> *"how long a hook may keep running after `next.signal` aborted"*。
> 把 `catchMs` 读成「超时宽限」是错的 —— opencc 曾据此导出一个无人引用的
> `MOD_HOOK_GRACE_MS = 1_000`，现已删除。

---

## 六、matcher

- 必须是**对象字面量**（禁 spread / computed key / accessor）—— 否则 `to` 可被设成任意 tier
- 叶子四类：`===` / `RegExp` / any-of 数组 / 对象 partial；递归深度上限 8
- 一个 matcher 内 `to` 不能出现两次

---

## 七、`PluginOptions` / `userConfig`

`ConfigKind = 'boolean' | 'choice' | 'text' | 'number'`（d.ts:1636）。

- 声明了 `options: [...]` 的 **string 字段**在 `/config` 画成 picker
- **存储值不在 options 内等同未设**，回落 default
- 必填字段无值 → 加载失败并指出字段名
- 敏感值存 secure storage

agents-md 的 `instructionFiles` 正是 `type: 'string'` + 4 个 options。

---

## 八、11 个内建插件（2.1.287 / 2.1.292 / 2.1.296 三版逐字一致）

加载器函数 `Nie()`，`builtinPluginsInitialized` 一次性守卫（bundle，标识符随版本变，**读法见下**）。

| 插件 | 短名 | 加载条件 |
|---|---|---|
| `cc-plugin-sec-default` | `sec-default` | 无条件 |
| `cc-plugin-agents-md` | `agents-md` | 无条件 |
| `cc-plugin-telemetry` | `telemetry` | 无条件 |
| `cc-plugin-plugin-authoring` | `plugin-authoring` | 非 local-agent |
| `cc-plugin-mods-guide` | — | 非 local-agent |
| `cc-plugin-mermaid` | `mermaid` | 非 local-agent |
| `cc-plugin-you-should-know` | — | 非 local-agent |
| `cc-plugin-tips` | `tips` | 非 local-agent 且非 remote |
| `cc-plugin-responsive-mode` | `responsive-mode` | 同上 |
| `cc-plugin-diff` | `diff` | 同上 |
| `cc-plugin-claude-test` | `claude-test` | 同上 |

`Ron() === CLAUDE_CODE_ENTRYPOINT.startsWith("remote")`。

**读法（不要依赖压缩后的函数名——`ASe` 在不同版本是不同字母，用它做正则会静默返回 0 条）：**

```bash
python3 -c "
import re
s=open('bundle.js',encoding='utf-8',errors='replace').read()
for n,c in re.findall(r'\"(cc-plugin-[a-z0-9-]+)\",\(\)=>import\.meta\.require\(\"/\\\$bunfs/root/(chunk-[a-z0-9]+\.js)\"\)', s): print(n,c)"
```

短名别名表紧跟 `PluginDirectoryUnavailableError` 类定义之后；只覆盖 9 个（`mods-guide` 与 `you-should-know` 无短名）。

**部分 mod 的编译产物其实在主 bundle 里可读**，不必依赖 chunk：`agents-md` @36385773 / @36385941、`telemetry` @36381755（`scan:{hooks:[...]}`）、`sec-default` @36371342（deny 加固）。逐个插件按特征字符串在主 bundle 搜，比依赖 chunk 可靠。

---

## 九、官方 mod 的运行形态（opencc 明确不分叉的部分）

- **TS 源码**，跑在 Bun SFX 上，`Bun.Transpiler` 同步转译（`macro:false`，不做类型检查）
- 三层隔离：主进程 → per-plugin Bun Worker → per-plugin vm realm（`codeGeneration:{strings:false, wasm:false}`）
- 静态扫描是**拒斥式**（逐节点遍历抛 `ScanRefusal`）不是提取；错误消息自带教学：*"`$` is always spelled `$.noun.event(...)` at the call site, `on` is always `on("<event>", hook)`, and `next.to` always `next.to(e, "<tier>")`"*
- 体积：单文件 ≤ 1MB，mod 总量 ≤ 8MB
- `Client` UI 模块路径必须是**相对字符串字面量**，spread 必须在 `module` 之前
- 官方 mod 站单例跑 `agentLoop / buildSystemPrompt / permissionDecision`，与宿主共享内存态