# Mods 对齐 2.1.296 —— 未完成项

[`mods-upstream-contract.md`](./mods-upstream-contract.md) 描述的是**上游**的行为。
本文记录其中 opencc **尚未实现**的部分，避免后来者读契约时以为下游已经具备。

核验方式：事件名在 `src/` 生产代码中零出现（静态），或全局无生产调用点。

---

## 一、安全

### `$.env` 无任何过滤（待办）

```ts
// src/mods/nouns.ts
get: name => dispatchModOp('env.get', { name }, () => process.env[name]),
set: (name, value) => dispatchModOp('env.set', { name, value }, () => {
  process.env[name] = value
}),
```

任意插件可读 `ANTHROPIC_API_KEY` 及任何环境变量；`env.set` 还能写入宿主进程环境，
影响宿主自身及其后续启动的所有子进程。

**上游防线**：`d.ts:3016` —— `name` 必须是字符串字面量，`claude plugin validate` 会
列出你读了哪些变量。**依赖发布前的静态校验**，opencc 无 validate 环节，无法照搬。

**已议定但暂缓的方案**（最简黑名单）：

```ts
const SENSITIVE_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)$/i
```

- `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `AWS_SECRET_ACCESS_KEY` → 拒
- `CLAUDE_CODE_DISABLE_ATTACHMENTS` / `CLAUDE_CODE_SIMPLE` 等官方 mod 实际读取的 → 放行
- `i` 标志防 `api_key` 小写绕过
- 命中时抛明确错误，而非静默返回 `undefined`（与 `$.fs` 移除白名单后的做法一致）

**已知局限**：改名即可绕过 —— `PSEUDO_AUTH` 之类不以敏感词结尾的变量仍可读。
升级路径是加 `settings.mods.envAllowlist`，与已移除的 `mods.authorized` 同一套形式。

**内部一致性**：同一份代码里 `tool.check` 严守「插件只能收紧」
（`toolExecution.ts`，丢弃 mod 的 `allow`），`env` 却毫无限制 —— 两种安全标准并存。
改信任模型应单独一个 PR。

---

## 二、从不触发的事件

事件表声明 109 个。**88 个已接、21 个仍无 dispatch 点**（脚本重跑于 2026-10-12）。

判定脚本必须**剥掉注释**再匹配调用点，否则会假通过：本轮第一次跑出的
「97/12」里，`agent.offer` 被算成已接 —— 唯一提到它的地方是 `subscriberGate.test.ts`
的注释和一个测试夹具。**名字出现在散文里不等于有 dispatch 点。**
另外 `HOST_EVENT_BRIDGE` 的键是带引号的属性（`'tool.call': 'PreToolUse'`），
不匹配 `dispatchMod*(` 的裸调用式样，也要单独计。

21 个按「是否有意」再分一次账：

**按名拒绝 6 个**（`UNAVAILABLE_EVENTS`，见 `protocol.ts`）—— 不是漏接，是本机没有对应能力，
拒掉比留一个永不触发的名字诚实：

```
audio.play   audio.speak   ui.blit   ui.fault   ui.message   prompt.autocomplete
```

**真待接 15 个**：

```
agent.offer        agent.register      engine.create      mcp.call
mcp.connect        plugin.register     session.attach      session.authorize
session.compact    session.detach      session.measure     session.receive
ui.input           ui.press            ui.select
```

| 事件 | 为什么难 |
|---|---|
| `agent.offer` / `agent.register` | 后者需要「插件可注册 agent」整条路。**分组本身不用改** —— 上游用 `source:"plugin"`（见审计 §6.3 更正） |
| `plugin.register` | 需要 `uses:{events,calls,env,state}` 静态扫描，opencc 无 validate 环节 |
| `ui.press` / `ui.input` / `ui.select` | 不是三个事件，是一套：`ui.render` 元素树 + press-hold 注册表 + surface + 焦点模型 |
| `mcp.call` / `mcp.connect` | 包一层已有 MCP 连接池即可，但需 server 名归一化 |
| `session.*`（5 个） | 尚未定位 opencc 的对应触发点 |

> **`/mod-probe` 不能单独判定这件事。** 该内置 mod 订阅全部事件并报告哪些被触发过，
> 但它区分不了「没接线」和「本次没调用」：op 事件要等对应的 `$` 方法被调用才触发。
> 一次只有 4 个内建 mod 的 session 里，`fs.read` / `store.get` / `clock.now` 都不会出现，
> 而它们实现完好。**静态分析才是准确判据**，探针只适合发现「跑着跑着哑掉」的事件。
>
> 另注：`mod-probe` 自本轮起为 `optIn`（`/plugins` 里显式启用才加载）——
> 它订阅全部事件，默认加载会让每个 dispatch 点永久走慢路径。

### 最关键的一条：`prompt.context`

契约 §4 那套 `{blocks, instructionFiles}` 双向同步算法**完全未实现**。
它是这次对齐的核心卖点，也是官方 `agents-md` 的主功能入口。

---

## 三、op 事件缺对应 `$` 方法

以下 7 个事件已声明为可 hook，但 `$` 上没有能触发它们的方法：

`mcp.call` `mcp.connect` `agent.register` `prompt.read` `prompt.compose`
（`audio.play` / `audio.speak` 有 `UNAVAILABLE_EVENTS` 明确拒掉，不在此列）

按契约自订的原则（`protocol.ts`：「要么真能 dispatch，要么按名字拒掉」），
这些属于「注册成功但触发不了」的第三种状态。应实现方法，或从声明表中移除。

---

## 四、协议守卫（契约 §三）

`checkArgument` / `restoreArgument` / `measureArgument` / `restoreResult`
在 `src/mods/` 零命中。上游的违规字符串确认真实存在于
`~/source/claude-2.1.296/modules/0156-module-0156-ec6f77.mjs`。

opencc 只有 `cloneAndFreeze` 与结构化 matcher，**没有「非法改动回落到上一个合法值」这一层**。

另注：上游也不是每个事件都有描述对象 —— 该对象是「需要守卫的事件」的表，
不是 109 行的统一形状。移植时必须按 bundle 自己的表逐个对，不能给每个事件补齐 7 个字段。

---

## 五、次要分叉（有意保留，非缺陷）

| 项 | 上游 | opencc | 判断 |
|---|---|---|---|
| 事件名兼容 | 无旧名 | 旧名别名**已移除**（本轮） | 对齐：`PreToolUse` 等是宿主 hook 词汇，上游在 classic 通道（`bundle@10904719`），不是 mod 事件 |
| `/g` `/y` matcher | 注册时拒绝（`bundle@3444038`） | 接受并重置 `lastIndex`（`protocol.ts`） | 分叉。会写 mod 仍持有的 RegExp 对象 |
| `frozenWriteError` | — | 导出未用；mod 拿到 V8 原始 `TypeError` | 分叉。接上需要 Proxy 包每个载荷，热路径成本高 |
| `INVALIDATABLE_EVENTS` | 未找到上游对应声明 | 7 个事件的列表 | **存疑**，可能是自创。上游 `bundle@1303175` 只提到 `ui.render` |
