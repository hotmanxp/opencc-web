# 官方 Mods 实现核验报告

> **目的**：记录 Claude Code Mods 机制的**实测事实**，作为 [`mods-plan.md`](./mods-plan.md) 的证据基线。
>
> **基线版本**：Claude Code **v2.1.289**
> **核验日期**：2026-10-05
> **方法**：二进制 strings 全量抽取 + 符号定位 + 上下文还原（无源码，反编译受限）
>
> ⚠️ **本文件只记录上游事实，不含 opencc 的方案决策。** 方案在 `mods-plan.md` §3。

---

## 一、核验方法与可复现性

### 1.1 抽取

```bash
strings -n 6 /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe \
  > ~/.agent_working_dir/claude-raw/2.1.289/raw/all-strings.txt
```

| 项 | 值 |
|---|---|
| 二进制大小 | 229MB |
| 抽取产物 | 53MB / **400,517 行** |
| 产物位置 | `~/.agent_working_dir/claude-raw/2.1.289/raw/all-strings.txt` |

### 1.2 方法学限制（重要）

`strings` 按 NUL 边界切分，**chunk 边界会切断跨模块的变量定义**。因此：

- ✅ 可靠：字符串字面量、遥测事件名、错误消息文案、常量值、模块 import 语句
- ⚠️ 需交叉验证：minified 符号名（`qEn`/`y5o`/`MD`）—— 同一符号在 bundle 内**不唯一**，`kr`/`MD`/`zae` 有多个同名定义点
- ❌ 不可靠：控制流、完整类型签名、闭包捕获关系

**本报告的每条结论都标注了证据强度。** 涉及控制流的结论（如下 §5 的 tier 图谱）已做多点交叉验证。

### 1.3 Mods 实现定位

| 位置（`all-strings.txt` 行号） | 内容 |
|---|---|
| **330001** | 转译器 `qEn`、路径围栏 `h2e`、扩展名解析 `or`、体积常量 `ho`/`jo`/`er` |
| **330002** | AST 校验器 `ee`/`kr`、UI 契约常量 `oe`/`Er`、tier/matcher 解析 `Uo` |
| **330003** | 扫描入口 `y5o`、`ScanRefusal` 类 `Lo`、动态 import 拒斥 `h5o`、模块图遍历 `It` |
| **337639** | Worker 运行时、tier 调度、`qae` 线程开关、`zae`/`rBt` modsOffAt 状态机、`MD` 崩溃归因 |

---

## 二、运行时前提：跑在 Bun SFX 上

**这是 opencc 无法复制的结构性差异。**

| 维度 | 上游 Claude Code | opencc |
|---|---|---|
| 分发形态 | Bun SFX 单文件 | `dist/cli.mjs`（Node ESM） |
| 模块解析 | `/$bunfs/root/chunk-*.js` 虚拟路径 | 标准 ESM |
| 全局对象 | 真 `Bun`（`Transpiler`/`embeddedFiles`/`YAML`/`spawn`/`gc`…） | 无（产物里的 `Bun.*` 是 bundler shim） |
| vm 模块 | 可用 | **需 `--experimental-vm-modules`**，否则抛错 |

**推论**：上游 Mods 的加载契约（含转译、chunk 解析、内嵌文件访问）在 opencc 侧**无法直接复用**。这是 `mods-plan.md` 选择分叉的根本原因。

---

## 三、TS 转译

**证据强度：强**（`qEn` 完整函数体）

```js
function qEn(e,o){
  let r=go(e), t=r==="js", n=r==="ts"?"":Xo;
  if(t) return o;                                    // .js 直接返回，不转译
  try{
    let s={loader:r, macro:!1};
    return new Bun.Transpiler(s).transformSync(`${n}${o}`)
  }catch(s){ throw new Ie(Zo(s, Gt(n, ...))) }     // 行列错误映射
}
```

| 事实 | 值 |
|---|---|
| 转译器 | `Bun.Transpiler`，`{ loader, macro: false }` |
| 类型检查 | **不做**（`macro:false` 只关宏，类型检查本就未启用） |
| `.js` 处理 | **直接返回，不转译** |
| 扩展名映射 | `.js`→`.ts`/`.tsx`；`.jsx`→`.tsx`；`.mjs`→`.mts`；`.cjs`→`.cts` |
| 错误处理 | `Zo()` 聚合多错误；`Jo()` 把 `position.line/column` 拼进用户可见报错；`Xo` 前缀做偏移补偿 |
| 摘录行宽 | 80 字符（`dr=80`） |

> **注意**：`Bun.Transpiler` 在 bundle 中出现 **2 次** —— 一次是上述实现，一次是错误文案 `"$" is not supported in Bun.Transpiler`。「仅一处使用」的判断成立，但**带完整行列错误映射**是 `typescript.transpileModule` 不具备的。

---

## 四、静态扫描：拒斥式校验（**不是"提取"**）

**证据强度：强**（`y5o`/`h5o`/`ee`/`kr`/`Lo` 函数体完整可见）

⚠️ **这是对 `mods-plan.md` v1.0 的重要更正** —— v1.0 描述为「acorn 完整 AST 扫描，提取事件注册/`$` 调用面/`next.to` tier」。实际是**逐节点遍历并抛异常拒绝**。

### 4.1 拒斥规则表

| 类别 | 规则 | 证据 |
|---|---|---|
| 动态 `import()` | **拒绝** —— 只允许 `import` 声明 | `h5o` |
| import 白名单 | 仅裸模块 `claude-code` + 相对路径；裸模块名 `gQe="claude-code"` | `p5o` 错误消息 |
| 目录围栏 | realpath 解析后越界报错 `resolves outside the plugin's folder` | `h2e` |
| `$.catch()` | 只允许在调用点 `.catch(handler)`；一旦被**赋值/传参/从嵌套函数返回**即拒绝 | `ee` |
| top-level await | **非 entry 文件**中出现即拒绝（entry 单独作为 async module 链接） | `It` |
| `Client` 模块路径 | 必须**字符串字面量**、必须**相对**、必须在 plugin 目录内 | `kr` / `So` |
| `Client` spread 顺序 | spread 必须在 `module` **之前**，否则可能替换它 | `jr` → `isSpreadAfter` |
| 组件导出 | 必须 default 或**单个** PascalCase 导出，否则报错列出全部导出名 | `$as` |
| 单文件体积 | ≤ 1MB（`jo=1048576`） | `ve` |
| mod 总体积 | ≤ 8MB（`er=8388608`） | `Un` / `Bn` |
| 扫描节流 | 每 32 个文件让出事件循环（`ho=32`） | `It` |
| 扩展名 | hooks module 及其 import 的文件必须以代码扩展名结尾 | `Te` / `ar` |

### 4.2 错误消息质量

`ScanRefusal` 异常携带**插件名 + 文件路径 + 编译行号 + 源码摘录（80 字符）**，且默认消息写死了调用契约：

> `$ is always spelled $.noun.event(...) at the call site, on is always on("<event>", hook), and next.to always next.to(e, "<tier>")`

这是**编译期引导**设计 —— 报错本身就是教学。

### 4.3 in-memory 预编译通道

`Ne.register()` / `Ne.registerScan()` 提供进程内注册表，可绕过磁盘直接注入已编译模块。官方内建 mod（如 `cc-plugin-diff`）走这条路径。

---

## 五、注册契约与 `$` 能力面

**证据强度：中**（`$` 方法名从 42 处调用点还原；minified 名有重名风险，但调用点上下文一致）

### 5.1 注册形态

```js
on("<event>", hook)                          // 简写
on("command.run", { command: "x" }, hook)    // matcher 必须是对象字面量
on("<event>", { to: "<tier>" }, hook)        // tier
```

- matcher 禁止 spread / computed key / accessor（否则 `to` 可被设成任意值）
- 一个 matcher 内 `to` 不能出现两次
- `command.run` 的 matcher 需字面量列出要注入的命令名（`runCommands`）

**注意：这不是 `register(on)` 导出式契约。** 上游靠**扫描 AST 里的 `on(...)` 调用点**发现注册。

### 5.2 `$` 实际能力面 —— ⛔ 本节结论已证伪，勿引用

> **2026-10-11 更正**：本节原标题为「`$` 实际能力面（仅 4 个顶层命名空间）」，正文断言 mod 拿不到宿主文件系统、**没有 `fs` / `store` / `clock`**。**该结论错误。**
>
> 官方 `mods/types/claude-code.d.ts` 的 `CoreEngineInterface`（:2016-3674）定义的是 **24 个 noun**：
>
> ```
> plugin  ui  model  audio  mcp  session  turn  prompt  tool  command  config  agent
> fs      store  clock  http  process  settings  env  terminal  desktop  mobile  vscode
> ```
>
> `fs`（:2738，`read/write/list/exists/stat/ancestors`）、`store`（:2860）、`clock`（:2893）、`env`（:3012）**都在**。开源的 `mods/agents-md/hooks/register.ts` 源码实际调用了 `$.fs.ancestors({names, of, below})`、`$.session.root()`、`$.env.get('CLAUDE_CODE_SIMPLE')`、`$.telemetry.log(...)` —— 其中 `fs.ancestors` 是逐级目录 walk，AGENTS.md 的加载完全靠它。
>
> **原文的错误来源**：本节自述「`$` 方法名从 42 处调用点还原；minified 名有重名风险」—— 那是**一次有损抽样**，不是签名定义。上游把完整契约以 `.d.ts` 形式开源，正是为了让这件事不必靠考古。审计的其余章节（§四 静态扫描、§六 tier 链、§八 Worker 隔离）仍然有效。
>
> **权威来源改为 [`mods-upstream-contract.md`](./mods-upstream-contract.md) §二。** 本文余下内容保留为取证记录，不作为实现依据。

<details>
<summary>原文（已证伪，留档）</summary>

```
agent.spawn            command.run          process.run / process.spawn
prompt.compose         prompt.read          turn.abort
ui.ask / copy / invalidate / log / notice
```

**不存在的**（`mods-plan.md` v1.0 曾设计）：

| v1.0 提议 | 原断定的"上游实况" |
|---|---|
| `fs: { read; write; list; exists }` | ❌ **mod 拿不到宿主文件系统** |
| `store: { get; set }`（共享 KV） | ❌ mod 间协调靠 `telemetry` 流 + tier 下钻 |
| `clock: { setTimeout; sleep }` | ❌ `setTimeout` 由宿主注入 |
| `tools: { register }` | ❌ 上游 mod **不能运行时注册 tool** |
| `commands: { register }` | ❌ `command.run` 是**执行**已注册命令，非注册 |
| `agents: { register }` | ❌ `agent.spawn` 是**启动** agent，非注册 |

**安全含义**：上游用**能力面收窄**替代沙箱。mod 能做的事完全由宿主注入的 API 面决定。

</details>

> 末句「上游用能力面收窄替代沙箱」这一**观察仍然成立**，只是能力面比本节列的大得多 —— 24 个 noun 里有 `process.run`（可执行子进程）与 `http.fetch`，收窄的边界比"拿不到文件系统"宽得多，实施时需按 [`mods-upstream-contract.md`](./mods-upstream-contract.md) 的完整清单重新评估。

### 5.3 静态扫描的产出结构

`scan` 结果包含：`hooks`（注册表）、`calls`（`$` 调用面）、`runCommands`、`nextTo`（tier）、`telemetry`、`env`（`process.env` 读写记录）、`state`、`clients`（UI 组件）。

> `env` 字段值得注意 —— 上游**显式追踪 mod 对 `process.env` 的读写**，说明 mod 确实能访问 env，这条路径被单独建模。

---

## 六、tier 链与 dispatch

**证据强度：中**（tier 数组与下钻图为字面量，交叉验证；dispatch 控制流从片段推断）

### 6.1 tier 顺序与下钻图谱

```
顺序:  prepend > user > append > builtin > core

下钻:  prepend:["append","builtin","core"]
        user:  []
        append:["core"]
        builtin: []
        core:   []
```

**关键**：复杂度不在层数（5 是常量），而在 `next.to(e, tier)` 的**下钻语义** —— mod 可把控制权让给更低层。

### 6.2 dispatch 是三件套

| 方法 | 用途 |
|---|---|
| `dispatch` | 同步事件 |
| `dispatchStream` | 流式事件，返回 async iterable |
| `linkStreams` | 链接多个流 |

`next()` 参数与 `next.to()` 楼层**运行时校验**（`s(v,"next() argument")` / `s(x,"next.to() floors")`），传错类型才抛错。

> **`mods-plan.md` v1.0 完全未提流式事件。** `prompt` / `turn` 类事件天然流式，砍掉等于砍掉一半可用场景。

### 6.3 opencc 侧接线状态（2026-10-11）

事件总数 **109** = engine 64 + op 52，去重后重叠 7。平衡恒等式：
`109 == 已接线 + 桥接 + 按名拒绝 + 未接线`，每次改动后重跑校验，避免"删了多少行"式的误判。

| 类别 | 数量 | 说明 |
|---|---|---|
| 源码层有触发点 | 83 | 82 个有 `dispatchModOp/Engine/Stream/Sync` 字面调用点；`ui.render` 走独立的 `transformModRenderText` 渲染链（`renderTap.ts:68`）。**这是源码计数，不等于事件会触发** —— 见 6.3.1 |
| 桥接 | 4 | `tool.call`→`PostToolUse`、`session.start`/`session.end`、`turn.complete`→`Stop` |
| 按名拒绝 | 6 | `audio.play`/`audio.speak`/`ui.blit`/`ui.fault`/`ui.message`/`prompt.autocomplete` —— 无对应能力，**按名报错**而不是给一个永不触发的 `on()` |
| 无触发点 | 16 | 见下 |

#### 6.3.1 运行时实测（`/mod-probe`，真实 dist）

首次端到端跑 `mod-probe`（`bun run build` 后的 `dist/cli.mjs`，pty 驱动真实 REPL）：

```
Event slots: 4 fired, 100 subscribed-but-never-fired, 5 refused — of 109.
  command.describe ×434
  prompt.section ×24
  prompt.submit ×1
  session.start ×1
```

**只有 4 个事件被证实会触发。** 源码审计说 73，这个差距就是"空壳"的确切定义 —— 本节就是为此存在。

两个必须说清的点，否则这个数字会被误读：

1. **52 个 op 事件本来就不该"触发"。** op 事件是 `$` 方法的调用点，没人调 `$.fs.read`，`fs.read` 就不会触发。probe 只注册 handler、从不调用任何 noun，所以 op 事件显示"未触发"是**正确行为**，不是缺口。（若某天有 mod 真的调了某个 noun 而它仍未触发，那才是 bug。）
2. **`turn.start` 在本次实测中没有触发**，而源码里它有调用点（`src/query.ts:589`，`queryLoop` 内、`while` 之前）。已排除的假设：打包后 `mods/dispatch.js` 出现两份独立状态（实测 `dist/cli.mjs` 中 `refreshOpChains` 与 `hasModHandlersFor` 各只出现 1 次，打包器已去重）。**剩下的两种可能没有区分开**：(a) 那次驱动里查询循环根本没跑（回复为空、`turn.start` 在首个模型调用之前就该触发却没触发）；(b) 那一刻 `hasModHandlersFor('turn.start')` 为 false。**在跑通一个确认产生助手回复的会话之前，不得声称 `turn.start` 已接线。**

**修正（2026-10-12）**：上述第 2 点的悬念已解开 —— 是 **(a)**，而且原因不是驱动问题。`turn.start` 的调用点里用了未 import 的 `extractTextContent`（见 §6.4），ReferenceError 抛在 `queryLoop` 的 `while (true)` 之前，**每个 turn 都在首次模型调用之前死掉**。所以那次"查询循环根本没跑"不是驱动没喂进去，是宿主自己崩的。

修复后重跑，`turn.start` 确实触发：

```
Event slots: 9 fired, 95 subscribed-but-never-fired, 5 refused — of 109.
  attribution.text ×4    command.describe ×444   prompt.section ×24
  prompt.submit ×1        session.start ×1        tool.describe ×26
  turn.complete ×1        turn.start ×1           ui.render ×1
```

新增的 5 个（`turn.start` / `turn.complete` / `tool.describe` / `attribution.text` / `ui.render`）全部是**修复前查询根本没跑**所以无从触发的。**这就是为什么空壳必须用运行时证据判定**：源码里的调用点在一次崩溃面前和不存在没有区别。

> **`mod-probe` 现为 `optIn: true`（默认关闭）**。诊断类 mod 不该在每个用户会话里常驻，所以它不再自动加载 ——
> 要复现上表须先在 `/plugins` → Installed 里启用它。上表是**启用状态下**的读数。

> 驱动本身的两个坑（都会伪装成产品 bug）：
> - opencc 冷启动要 **45 秒到 4 分钟**。固定 `settle` 的驱动器会在进程还没起来时就把输入打进去，于是"没回复"其实是没有接收方。
> - **输入框提交后不会自动清空**。紧接着发下一条命令会被拼接成 `上一条/下一条` 的普通 prompt —— `/mod-probe` 变成一句提问，自然永远出不来报告。发命令前先发 `\x15`（Ctrl-U）清行。

未接线按前缀：

- `session.*` 6 —— `usage` 要接 `/context` + `/cost` 的读数
- `agent.offer` / `agent.register` / `engine.create` / `plugin.register`
- `mcp.call` / `mcp.connect` —— `mcp.call` 必须过权限路径，否则 mod 可无提示调用任意 MCP 工具
- `ui.input` / `ui.press` / `ui.select` —— 需要输入管道重构

`prompt.*` 十个事件**已全部落地**（5 个按名拒绝 / 5 个已接），下面记录三个最后接上的、以及一个必须写下来的映射决定。

> **更正**：本节此前记「`prompt.*` 9 个未接，需要先做 `instructionFiles` 结构化重构」。**后半句是错的** —— `getMemoryFiles(): Promise<MemoryFileInfo[]>`（`src/utils/claudemd.ts`）**已经是结构化的**，且与上游 `InstructionFile` 几乎同构：`path` / `type`(↔`kind`) / `content` / `parent?` 四个字段一一对应。不需要重构。

#### 枚举映射：`AutoMem` 与 `TeamMem` 都算 `memory`

上游 `INSTRUCTION_FILE_KINDS = ["managed","user","project","local","memory"]`，opencc 的 `MEMORY_TYPE_VALUES = ["User","Project","Local","Managed","AutoMem","TeamMem"]`。前四个直接对上；**上游的一档 `memory`，在 opencc 是两档**。

决定：**两者都映射成 `memory`**。理由是 mod 问的是「这是不是记忆文件」，不关心它来自哪个存储；拆成两档等于给每个 mod 一个会静默漏掉一半记忆的过滤器 —— 那种失败不报错，只是 mod 以为自己覆盖了全部。

#### `prompt.context` / `prompt.compose` / `prompt.attachment`

- **`prompt.context`** —— 插槽点是 `prependUserContext`（`src/utils/api.ts`）。opencc 的 `context` 本来就是 `{key: text}` 渲染成 `# key\nvalue`，与上游 `PromptContextBlock {name, text}` 同构，所以 blocks 是现成的；`instructionFiles` 走上面那条 `getMemoryFiles()`。`<system-reminder>` 外壳包在链的答案**外面**，与上游一致。函数因此变成 async，两个调用点（query.ts、generateAgent.ts）改为 await。
- **`prompt.compose`** —— 插槽点是 `getSystemPrompt` 的最终 return。`scope: shared|session` 正是 opencc 自己缓存分界线（`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`）的反面读法：分界线之前是 shared，之后是 session。**分界线本身不进链** —— 上游明写引擎自己放置边界与所有 cache marker，让 hook 挪边界等于让它挪 prompt cache。为此 `resolveSystemPromptSections` 改为返回 `{name, text}` 而非位置化字符串，否则每个 section 只能靠下标寻址，hook 按 id 替换/移动/删除都无从谈起。
- **`prompt.attachment`** —— 插槽点是 `normalizeAttachmentForAPI`。调用方在它**之后**才包 `<system-reminder>`，所以「外壳在链外」是结构保证而非靠自觉。同步 dispatch（与 `prompt.edit` 同理：`normalizeMessagesForAPI` 是整条 transcript 上的同步 pass）。

##### 引擎事件其实有两种 `next` 语义，`dispatchModEngine` 只能表达其中一种

上游 d.ts 对引擎事件的 `next` 写了两句不同的话，而它们要的是**两套不同的 dispatch**：

| 语义 | 上游原话 | 事件 |
|---|---|---|
| **`next(e)` 解析为 core 算出的答案** | "`next(e)` resolves to `{ sections }` … The bottom is the engine's own composition"（d.ts:3435） | `prompt.compose`、`prompt.attachment`、`tool.describe` |
| **改写事件，core 从事件推导答案** | "Append, drop, reorder or rewrite with `next({ ...e, blocks })`"（d.ts:3424） | `prompt.context` |

区别在于**答案能不能从事件本身算出来**。`prompt.context` 的 blocks 就在事件里，所以 core 从 `e` 推导即可。而 `prompt.compose` 的 sections 是**引擎刚组装的** —— hook 自己算不出来，只能靠 `next(e)` 读到。

`dispatchModEngine` 的 terminal 回答 `{continue: true, ...event}`，chain 结果再喂给 core：这正好是第一类语义做不到的事。实测后果（`src/mods/promptSections.test.ts` 抓到的）：

```ts
// 上游 d.ts:3441 官方示例
on("prompt.compose", async ($, e, next) => dropped(await next(e), "tone"))
//                                       ^^^^^^^^^^^ 拿到的是 {continue:true, model, ...}
//                                                    没有 sections → dropped() 抛错
//                                                    → 链跳过该 handler → 引擎送出自己的组装
```

**hook 触发了、返回了、什么都没改，而且没有任何日志。** 与 `prompt.edit` 那次「装了 mod 就打不了字」同型：症状是「mod 装了跟没装一样」。

因此新增 `dispatchModEngineResult`（`src/mods/dispatch.ts`）：terminal **就是** core，`next(e)` 解析为引擎组装的答案；不调 `next` 直接返回则整体替换（上游 d.ts:3425 `() => ({blocks: []})`）；返回空或抛错则透传 core 的答案（上游 `prompt.section` 的 "a hook that fails passes it through"）。`prompt.compose` 改走这条路径。

同一批修复里另外两处**静默空壳**，都是「hook 触发了但引擎没读它的答案」：

- **`prompt.attachment` 的 `{text: null}` 丢弃是空操作** —— core 写的是 `typeof e.text === 'string' ? e.text : text`，把 null 又还原成原文，于是 d.ts:6629 的 `PromptAttachmentResult {text: string | null}` 里那个 null 永远丢不掉附件。改为 core 对非字符串一律回答 null，调用方收到 null 返回 `[]`。
- **`prompt.mention` 的 deny 闸门是空操作** —— core 写的是 `() => ({allow: true})`，**完全不看事件**，所以链照常触发、每个路径照常放行；注释里「a hook can DENY a path」当时并不成立。改为 core 读 `e.allow`。

两处都先证红再改：把修复逐个回退，对应测试确实转红（`prompt.attachment` 1 fail / `prompt.mention` 1 fail），恢复后 16 pass。

**端到端实测**（真实 dist、真实 REPL、探针 mod 用上游文档写法注册）：探针打印的是 `next(e)` **实际解析到的东西**，而不是「事件触发了吗」—— 后者任何调用点都看得出来，前者才能证伪 dispatch 形状。

```
[pt] compose: 22 sections (shared=7 session=15) [harness,intro,system,doing-tasks,
      actions,tools,tone,pronouns,action_caution,task_continuity,session_guidance,
      tool_param_json,context_management,act_dont_rederive,delivering_work_max,
      overcorrection,subagent_steer_delegation,memory,env_info_simple:...,
      summarize_tool_results,token_budget,codegraph]
[pt] context: blocks=[claudeMd,currentDate]
      files=[user:AGENTS.md,project:AGENTS.md,project:AGENTS.md,
             memory:MEMORY.md,memory:MEMORY.md]
[pt] attach: type=agent_listing_delta   next(e).text=5113b
[pt] attach: type=mcp_instructions_delta next(e).text=2234b
[pt] attach: type=skill_listing         next(e).text=31963b
```

三件事一次说清：

- `compose` 的 `next(e)` 解析出 **22 个 section id**、shared 7 / session 15 —— 缓存分界线的两半在真实会话里确实分开了，不是一个恒等于 `shared` 的摆设。
- `context` 的 `files` 里 **两条 `MEMORY.md` 都报 `memory`** —— 就是本次裁定的那条映射（AutoMem 与 TeamMem 同档）在真实会话里生效的证据；其余四档 `user` / `project` 原样透传。
- `attachment` 的 `next(e)` 解析出真实字节数，不是事件本身。

**探针自己踩的两个坑**（都记在这里，因为它们和被测的 bug 是同一类）：`next` 解析的是 **Promise**，探针漏了 `await` 就去读 `res.sections`，读到 `undefined` 报成「引擎什么都没给」；`scope[0]` 打出来 22 个 `s` —— `shared` 和 `session` 首字母相同，于是「两半是否分开」这件事恰好被这个打印方式抹掉。测量装置和被测系统一样要独立验证。

**`prompt.attachment` 是同步契约**（上游示例 `on("prompt.attachment", {type:'todo_reminder'}, () => ({text: null}))` 不是 async）。探针写成 `async` 时日志如实记下：

```
[mods] "ptprobe" prompt.attachment handler returned a promise — ignored (synchronous host site)
```

结果被丢弃，且计入熔断失败次数 —— 这是设计内的行为，但 mod 作者需要知道：这条事件写 `async` 等于静默失效。

**已知未修（不在本批范围）**：`tool.describe` 的 `isDeferred` 生效，但 `description` 被丢掉 —— claude.ts:1230 的 core 只回 `{tool, isDeferred}`，从不读 `e.description`，而上游 d.ts:3465 的结果正是 `{description, isDeferred?}`。修它不能只在原地补一个字段：`toolToAPISchema` 的描述走会话级 `toolSchemaCache`，事后再写回 `tool.description` 会让第一轮生效、第二轮起被缓存的旧值覆盖 —— 比不接更糟。正确位置是 dispatch 移到 `toolToAPISchema` 内、`cache.set` 之前。

#### `tool.describe`：两个答案要放在两个地方

上游 `ToolDescribeResult`（d.ts:10016）是 `{description, isDeferred?}`，一句话两个去处，而宿主里它们落在两处完全不同的代码上：

| 答案 | 去处 | 为什么不能放别处 |
|---|---|---|
| `isDeferred` | `claude.ts` 在**过滤与序列化之前**决定的 `deferredToolNames` | 放到 `toolToAPISchema` 里就晚了 —— 工具早就选定完了，hook 说「藏起来」已经无处可藏 |
| `description` | 模型读到的 schema 文本 | 模型读的是 `tool.prompt()` 的返回值，**不是** `tool.description`（内建工具根本没这个字段），所以改字段等于改空气 |

原先的接线两处都错：payload 写的是 `t.description ?? ''`，对内建工具恒为 `''`，hook 拿到空串去改；core 只回 `{tool, isDeferred}`，改好的 `description` 直接丢掉。`provider` 同理——`t.source` 这个字段不存在，于是每个工具（包括 MCP 的）都报同一个 `'built-in'` 字符串。现在 `provider` 按 opencc 真知道的填：`isMcp` 为真给 `{kind:'mcp'}`，否则 `{plugin:'engine', tier:'core'}`；上游的 `mcp:<server>` 填不出来（server 名在 MCP 连接上，不在 Tool 上），所以不编。

链体抽成 `resolveToolDescriptions`（`src/mods/toolDescribe.ts`）：每个工具每会话只渲染一次描述，并把 `{base, answer}` 一起记下——答案不变就不重渲染、不动 schema 缓存（上游原话是「an unstable answer spends the model's prompt cache on every call」；**稳定**的答案同样不该付这个代价）；答案变了就只失效该工具那一条 schema 缓存（`invalidateToolSchema`），别的工具不受影响，于是改写能在**本次请求**就上线，而不是下个会话。

事件本身也换到 `dispatchModEngineResult`——上游 d.ts:3465 对 `tool.describe` 写的同样是「`next(e)` resolves to `{description, isDeferred?}`」，属 (A) 类语义。

**证红**：`options.description` 那一行去掉（即退回「改完就丢」）后 4 个测试转红，恢复后 7 pass。

**端到端实测（真实 dist、真实 REPL）**：光看日志只能证明 hook 跑过、看到的是真实文本（`Agent` 8070b、`AskUserQuestion` 1763b，`provider={"plugin":"engine","tier":"core"}`），证明不了**模型收到的是改写后那份** —— schema 是会话级记忆化的，改写必须拼进那份。于是把标记做得无法忽略，再让模型背出自己工具描述的最后一行：

```
❯ What is the exact last line of the AskUserQuestion tool's description? Quote it verbatim.

⏺ZZPROBEQQ: if you can read this line, the tool.describe rewrite reached the request.
  (That trailing line in the tool description looks like an embedded probe rather
   than real documentation — flagging it in case it's unintentional.)
```

模型逐字背出，还指出这行「像是塞进工具描述里的探针」。两次独立请求都稳定复现。这一行字只存在于 mod 改写后的 schema 里，所以它是上了 wire 的证据。

**端到端实测**（真实 dist、真实 REPL）：`P:attach,compose,context,edit` —— 四个事件在一次真实会话里全部触发。


#### `prompt.*` 里最需要判断的两处（read / fill / suggest / edit / mention 已接）

**`prompt.autocomplete` —— 按名拒绝。** 上游入参是 `{text, cursor, token, start}`，即光标处补全 token。opencc 最接近的是 PromptSuggestion：它从**空输入框**预测「下一句要问什么」，不接受 text/cursor/token，显示条件是 `inputValue.length > 0 ? null : suggestionText`，即输入中有任何字符就不出现。接上去、从上游移植的 token 补全器会拿到完全不同的行为 —— 那是空壳。

**`prompt.fill` —— 做成 op 事件，不做宿主调用点。** 上游 `PromptFillOrigin` 明写：引擎侧的写入 "reserved for its own sites, **none of which raises `prompt.fill` as shipped**"。也就是说**引擎从不 raise 这个事件，只有插件的 `$.prompt.fill` 会**。若在 `insertTextAtCursor` 上 dispatch，等于给从上游移植的 mod 发送上游从不发送的事件 —— 比不接更糟。

**opencc 的 prompt 状态所有权是分裂的**，这是这批接线的主要难点：`text` 归 REPL（`inputValueRef`，REPL.tsx:1468），`cursor` 是 PromptInput 局部 `cursorOffset`（PromptInput.tsx:264），**从不向上传**。两值唯一同时在作用域内的只有 REPL。解法是沿用仓里既有的 facts 通道模式（`setSessionFacts`）新建两个通道：REPL 每次渲染发布 `setPromptBoxFacts`，并把已有的 `insertTextRef` 适配成 `setPromptFillHook` —— 那个 ref 本来就是输入框唯一的对外通道，且已带齐三种模式需要的三种原语（光标处 splice、整篇替换带光标、末尾追加）。

**`prompt.edit` —— 同步 dispatch，且这是刻意的。** 自然站点在按键热路径（`useTextInput.ts` 的 `setValue`）。在那里 `await` 会把写入推到更晚的微任务，期间 `liveValueRef` 已被下一个按键改写 —— 快速连打两键就会基于彼此过期的镜像编辑。仓里已有先例：`attribution.ts` 的 `getAttributionTexts` 正因不能改 async 而选 sync dispatch。

**E2E 抓到一个单测抓不到的 bug**：core 最初返回 `e.text`，但上游 `PromptEditInput.text` 是**编辑前**的草稿（d.ts:6845）—— 于是每次按键都被回退，输入框永远空着。正确做法是 core 重新施加 splice（这也让 hook 改写 `start`/`end`/`inputText` 真正生效）。这个 bug 表现为「装了 mod 就打不了字」，单测层面完全看不出来，只有真跑一次 REPL 才发现。

**端到端实测**（真实 dist、真实 REPL）：

| 验证 | 结果 |
|---|---|
| `prompt.edit` 随每次按键触发 | `E:edit`，输入框照常填充与提交 |
| hook 改写 `inputText` | 敲 `abcdef` → 框里显示 6 个 `*`，`abcdef` 从未出现 |
| `prompt.suggest` | 生成点 `executePromptSuggestion`（async）可拦截 |
| `prompt.mention` | `processAtMentionedFiles` 在读文件**之前**过链，可 deny 路径 |

`prompt.edit` 的 splice 用最长公共前缀/后缀还原，8 种编辑形态（追加、中段替换、插入、删除、清空）逐一验证重建结果与原串逐字相同。
- `turn.step` —— 已接，见下

#### `turn.step`：接在原始 delta 循环，不是 `deps.callModel`

上游 `TurnStepChunk` 有 6 种 chunk：`text` / `thinking` / `tool` / **`input`**（工具参数的增量 JSON）/ `stop` / `engine`。**`input` 才是这个事件存在的理由** —— 上游明写 "a hook that saw it whole could not change what had already been shown"，指的就是参数在流式到达期间可改写。

opencc 的 `deps.callModel` 按 **content block** 产出 message，不是按 delta，在那里接只能拿到 `text`/`thinking`/`tool`/`stop`，**拿不到 `input`**。插槽点在 `src/services/api/claude.ts` 的 `content_block_delta` 原始流循环里 —— 已在那里接。

**接法是 PUSH 适配 PULL**：那个循环是手写的 `while (true)` + `iterator.next()`，内含 abort 竞态、空闲看门狗、停顿统计 —— 全仓库最脆弱的一段。把它改写成 generator 等于重排这些逻辑，收益为零。所以改成：`openTurnStepSink`（`src/mods/turnStepStream.ts`）把链的**底座**做成一个队列驱动的 generator，pump 把 chunk 推进去、把 hooks 处理后的结果取回来再累积 —— 即上游的 "what leaves the outermost hook is what is shown and recorded"。

零订阅时 `sink` 为 `null`，每个 `exchange` 就是恒等函数，累积路径与该事件存在之前逐字相同。

**踩过的三个坑**（都由测试暴露，不是靠推理）：

1. **微任务竞态不可用**。原想用 `Promise.race([pull(), Promise.resolve()])` 判边界，但已兑现的 promise 永远赢过挂起的 pull —— 结果是每个 exchange 只拿到 1 个 chunk，静默截断响应。正确做法是**两个只会settle其一的真 future**：链要么产出一个 chunk，要么回到底座要下一个（`bottom.asked()`）。
2. **`runModStreamChain` 每次 `next(e)` 都新建一层委托 generator**，而上游文档的 hook 形态正是**每 chunk 调一次 `next(e)`** —— 底座被反复重入。底座必须可重入：共享一个游标，每个 chunk 只交付出一次。
3. **`push` 必须只交给一个消费者**。同时入队**并**兑现 waiter，会让同一个 chunk 被消费两次 —— 表现为模型在每个 exchange 的最后重复一次。

**端到端实测**（真实 dist、真实 REPL、带真实工具调用）：

| mod 行为 | 结果 |
|---|---|
| 只统计不改写 | `tool, input, stop, thinking, text` 五种 chunk 全部触发 |
| 把每个 `input` chunk 改写成非法 JSON | **API 直接 400 拒绝** —— 证明改的是**真的发出去的内容**，不是副本 |
| 丢弃所有 `input` chunk | 工具**拿不到参数**，命令没按原样执行 —— 即上游 "a block whose `tool` chunk never comes out of the chain is no tool call" |

第二行是决定性的：它证明 `turn.step` 不是 observe 事件的伪装。

`process.spawn` 与它共用 `dispatchModStream`，端到端测试打真实子进程（`/bin/sh`、`/bin/cat`），含 stdout/stderr 分流、stdin、退出码、启动失败 reject。

#### `agent.register` 为什么还没接（这是个特性，不是接线）

上游 `$.agent.register(spec)` 注册一个 `<plugin>:<name>` 类型的 agent，返回 `{ agent }`。`AgentSpec` 的字段与 opencc 的 `BaseAgentDefinition` 几乎一一对应（`description`→`whenToUse`、`prompt`→`getSystemPrompt`，其余同名），**唯一的障碍是 `source`**。

`getActiveAgentsFromList()`（`src/tools/AgentTool/loadAgentsDir.ts`）按 `source` 分六组再塞进 `Map`：

```
built-in | plugin | userSettings | projectSettings | flagSettings | policySettings
```

**任何不在这六组里的 `source`，会进 `allAgents` 但被静默丢出 `activeAgents`** —— 一个 mod 注册了 agent、`$.agent.list()` 列得出来、Agent 工具却永远 spawn 不到它。这正是"空壳"的另一种形态，而且不会有任何报错。

所以正确做法是让 mod 注册的 agent 落进已有的某一组，而不是新造一个 `'mod'` 组。

**更正（2026-10-12，bundle 取证后推翻本节原结论）**：原文主张"给 `source` 加一个 `'mod'` 成员"，
理由是"硬塞进 `'plugin'` 会谎报来源 —— `loadPluginAgents()` 是 marketplace 插件的路径"。**该理由不成立**，
按上游实现走恰好就是 `source: "plugin"`：

```js
// bundle @10654646，registeredAgents 的唯一读出口 L3t
function L3t(){return[...it().registeredAgents.values()].flatMap(({plugin:e,pluginId:n,pluginRoot:r,spec:s})=>{
  let{name:h,...y}=s, b=$3t(`${nH(e,n)}:${h}`,y,"userSettings");
  if(b===null)return[];
  let{source:w,baseDir:M,fromAdditionalDirectory:z,...V}=b;
  return[{...V,source:"plugin",plugin:n,filename:h,registeredAtRunTime:!0,registeringPluginRoot:r}]
})}
```

上游**没有**第七个 source 组：`bz`（@10651865）的分组顺序与 opencc 完全一致
（`built-in → plugin → userSettings → projectSettings → flagSettings → policySettings`，后者覆盖前者），
注册进来的 agent 由 `Xet`（@10655067）插在最后一个 `plugin`/`built-in` 之后。

**而且它根本不会撞名**：`agentType` 是 `"<plugin>:<name>"`，而 `name` 经 `Sro`（@6533695）限定为
`[A-Za-z0-9_-]{1,64}` —— `:` 不可表达。于是"项目的 `agents/foo.md` 与某插件注册的 `foo` 同名"这个
担心的场景不存在：前者占 `foo`，后者只能叫 `plugin:foo`，spawn 是精确字符串匹配，两者并存。
**新造 `'mod'` 组反而会引入一个上游没有的分组，并丢掉 `registeredAtRunTime` /
`registeringPluginRoot` 这两个上游用来做"是否经过同步插件审批"的字段。**

需要移植的是接线，不是新分组：

1. `getActiveAgentsFromList()` 之后按 `Xet` 的规则插入（插在最后一个 `plugin`/`built-in` 之后）；
2. `registeredAtRunTime: true` —— 上游 spawn 时对 `source === "plugin"` 的 agent 做同步插件审批
   （bundle @16481943），且注册来的默认判定是 `"refused"` 而非 md 的 `"not judged"`，更严。

`/agents` 命令上游已删除（@10202990 `"(removed)"`），故无显示标签可对齐。

### 6.4 一次真实回归：`@ts-nocheck` 让 typecheck 对本次全部改动失明

**症状**：重新构建后，发送消息没有回复。已提交但无回复 —— TUI 与 `-p` 模式皆然。

**根因**：`turn.start` 接线块里调用了 `extractTextContent(...)`，而 `src/query.ts` **从未 import 它**。ReferenceError 抛在 `queryLoop` 这个 generator 内部 —— 位于 `while (true)` 之前 —— 于是每一次 turn 都在首次模型调用之前死掉。

**为什么所有闸门都没拦住**：

| 闸门 | 结果 | 原因 |
|---|---|---|
| `bun run typecheck` | ✅ 绿（0 error） | `src/query.ts` 第 1 行是 `// @ts-nocheck` |
| `bun run build` | ✅ 通过 | Bun 把自由变量当合法标识符打包，不报错 |
| `bun test src/mods/` | ✅ 440 pass | 测试不经过 `queryLoop` 这条路径 |
| `/mod-probe` | ⚠️ 只有间接信号 | `prompt.submit` 也没触发 —— 提示查询根本没起来 |

**本次改动触及的 8 个文件，全部带 `// @ts-nocheck`**：

```
src/query.ts  src/ink/ink.tsx  src/services/api/claude.ts
src/services/tools/toolExecution.ts  src/tools/AgentTool/AgentTool.tsx
src/utils/forkedAgent.ts  src/utils/processUserInput/processUserInput.ts
src/tools/AgentTool/AgentTool.spawnEvent.test.ts
```

也就是说，**整个 mods 对齐工作从头到尾没有任何类型检查覆盖**。这才是本次事故的真正教训：不是"少写了一个 import"，而是"我用来担保正确性的那道闸门对我改的每一个文件都是瞎的"。

**已加的闸门** — `scripts/check-nocheck-names.ts`：

把 `@ts-nocheck` 文件在**内存中**去掉 pragma 重新类型检查（不改工作树），**只报 TS2304 `Cannot find name`**。只取这一类而非全部诊断，是因为去掉 pragma 会暴露约 240 条既有类型债（五年代码库的松散可赋值性），一并报出则这道闸门永远转绿、也就永远不会被执行；而 TS2304 是唯一一类**必然是运行时崩溃**而非潜在类型松散的错误 —— 它既是最危险的一类，也是唯一可处理的一类。

当前基线 **486 个 `@ts-nocheck` 文件、27 处既有 occurrence**，由机械扫描捕获而非手挑。手挑会漏（本次手写基线就漏了 3 条）。基线条目在 occurrence 消失时会告警，防止"修好了却仍留在名单里、日后复发时被继续掩盖"。

**接入点**：挂在 `build.ts` 与 `typecheck` 两处。挂 build 是因为 CI 门禁的是 `bun run smoke`（= build），而 `pr-checks.yml` **不跑**根 typecheck（只跑 `bun run --cwd web typecheck`）—— 只接 typecheck 等于没接。

**验收**：把 import 删掉重新引入同一个 bug，`bun run build` 以 `EXIT=1` 失败并点名 `src/query.ts: cannot find name 'extractTextContent'`。修复后 TUI 与 `-p` 均恢复回复（`PONG` / `PONG2` / `PONG3` / `PONG-FINAL` 四次实测）。

> **可推广的教训**：一道闸门"通过"只有在它**看得见**你改的东西时才是证据。`tsc` 对 `@ts-nocheck` 文件的沉默不是通过，是缺席。

---

## 七、UI（`Client`）契约

**证据强度：强**（`kr`/`So`/`jr`/`$as` 函数体完整）

| 约束 | 规则 |
|---|---|
| 路径形式 | 必须**相对**字符串字面量（`"./board.tsx"`），不能是变量/模板/展开 |
| 扩展名 | 必须是代码扩展名 |
| 目录围栏 | realpath 后必须在 plugin 目录内 |
| 参数形状 | props 必须是**对象字面量**，且 `module` 在 spread **之后**（避免被替换） |
| 组件导出 | default 或单个 PascalCase：`export function Board(props, surface) { ... }` |
| 拦截 | 捕获的 `Client` 只能 `.catch(handler)`，不能赋值/传参/返回 |

---

## 八、Worker 隔离与崩溃归因

**证据强度：强**（`MD` / `zae` / `rBt` / `qae` 函数体与消息完整）

### 8.1 线程开关（官方逃生舱）

```js
var qae = () => a.CLAUDE_CODE_HOOKS_SAME_THREAD ? "same-thread" : "worker";
```

**官方自己提供同线程降级路径** —— 这是 opencc 选择同进程方案的重要依据。

### 8.2 崩溃归因

| 机制 | 细节 |
|---|---|
| 事件 | `plugin_function_hooks_worker` / `respawned`；`plugin_function_hooks_load` / `crashed_worker` |
| 归因粒度 | **单插件** —— `culprit.plugin` + `evidence`（stack 或其它） |
| 处置 | 只卸载肇事插件，其余保留；`workerDeaths++` 计数 |
| 追问 | 崩溃后拼出人话：`"<plugin> was unloaded: it crashed the hooks worker; what it withheld ($.a, $.b)"` |
| 熔断 | `unattendedCrashes >= 阈值` → 批量 disable |
| 心跳 | `SIGKILL` 500ms（`y$t=500`）/ 宽限 2000ms（`k$t=2000`） |

### 8.3 `modsOffAt` 状态机

`zae`（恢复）/ `rBt`（关闭）区分 **native mod**（`rD(args) !== undefined`）与 **worker mod**，分别计数上报：

```js
m("plugin_function_hooks_worker_mods", "turned_off", { worker_mods, native_mods })
```

> mod **崩溃**与 mod **被关闭**是分开计量的两个事件 —— 归因体系的一部分。

### 8.4 启用态与信任

四层开关：`enabledFromPolicyOnly` / `enabledFromTrustedSettingsOnly` / `defaultEnabled` / `isAvailable()`，叠加 `enabledPlugins` 设置白名单。

> 这与 opencc 现有 hook 的 `shouldSkipHookDueToTrust` **不是一回事** —— 那是 hook 执行时的信任判定，这是 mod 的**启用态判定**。

---

## 九、内建 mod

官方内建 6 个 mod（`cc-plugin-diff` 等），走 in-memory 预编译通道。

**含义：官方自己的部分功能就是用 mod 实现的** —— mod 机制不是边缘特性，是内核架构。

---

## 十、对 opencc 的可借鉴 / 必须分叉

> ⚠️ **「能力面」一行的上游值已证伪**（见 §5.2 更正）：上游实为 24 个 noun，含 `fs` / `store` / `clock` / `process.run` / `http.fetch`。原「4 个命名空间，无 `fs`」是一次有损抽样的产物，**该行的分叉理由因此不成立**。2026-10-11 起 opencc 按 [`mods-upstream-contract.md`](./mods-upstream-contract.md) 的完整清单重新推进能力面对齐（`mods-plan.md` v2.11 起）。其余行仍有效。

| 维度 | 上游 | opencc 决策 | 理由 |
|---|---|---|---|
| mod 语言 | TypeScript | **JavaScript** | 消除转译依赖（R2 消解）；无类型提示为代价 |
| 加载 | `Bun.Transpiler` + vm realm | **原生 `import()`** | 无 `Bun` 全局；`vm.SourceTextModule` 需 flag；隔离边际收益小 |
| 注册契约 | AST 扫描 `on(...)` 调用点 | **导出式 `register(on, options)`** | 显式契约，静态分析压力小一个量级；`on("<event>", matcher, hook)` 的调用面与上游一致（v2.11） |
| 能力面 | ⛔ 24 个 noun（`fs`/`store`/`clock`/`process`/`http`/…），见 §5.2 | **对齐中**（v2.11 起按 contract 清单推进） | 原"同款"的前提是错的；`fs.ancestors` 是 `agents-md` 的硬依赖 |
| 事件名 | 109 个点分名 | **已对齐**（v2.11，旧名保留为别名） | 见 `src/mods/protocol.ts` |
| 静态校验 | 完整拒斥式 AST | **精简版**（扩展名/体积/围栏/裸模块） | 换注册模型后大部分规则不再必要 |
| Worker 隔离 | per-plugin Worker + 归因 + 熔断 | **同进程**（P1） | Node 无 Bun Worker；官方有 `SAME_THREAD` 逃生舱 |
| tier | 5 层 + 下钻 + 三件套 dispatch | **5 层已对齐**（v2.11）；流式 dispatchStream 列 P2 | 下钻映射与官方一致 |

---

## 附：符号索引速查

在 `all-strings.txt` 中检索以下符号可复核本报告结论：

```
qEn    转译器          330001
h5o    动态import拒斥   330003
ee     $.catch逃逸拒斥  330002
kr     Client契约校验   330002
y5o    扫描入口         330003
Lo     ScanRefusal      330003
h2e    路径围栏         330001
qae    SAME_THREAD开关   337639
zae    modsOffAt恢复    337639
rBt    modsOffAt关闭    337639
MD     崩溃归因         337639
ho/jo/er  32/1MB/8MB   330002
oe/Er     "Client"/"h" 330002
```

遥测事件名（全文检索）：

```
plugin_function_hooks_worker
plugin_function_hooks_worker_mods
plugin_function_hooks_load
plugin_bundled_register
```
