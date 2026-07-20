# zai 自定义 slash 命令 UI 显示 + `~/.claude/commands` fallback — 设计规格

> 文档版本: 1.0 · 2026-07-20 · 状态: 设计已敲定, 待用户 review

## 0. 背景

zai 当前对 **user-defined slash 命令**有两处可见的用户体验问题:

1. **UI 显示缺失**: 用户在 Agent 输入框输入 `/greet alice`(用户自定义命令,greet.md 来自 `~/.zai/commands/`),服务器端 `packages/zai/src/server/routes/command.ts:47-53` 把 markdown 模板替换 `$ARGUMENTS` → `alice`,返回 `{ type: 'prompt', payload: { rendered: 'Hello alice' } }`。前端 `AgentInputBox.handleSend`(packages/zai/src/web/src/components/AgentInputBox.tsx:488-490) 走 `case 'prompt': await postPromptToLLM(result.payload.rendered, blocks)` → 直接调 `/api/agent/prompt` 而**没有向 zustand store push user.text**。结果:LLM 流式回复正常出现,但用户看不到自己刚输入的 `/greet alice` 与 server 渲染后的 `Hello alice`。同上的还有 `case 'unknown'`(用户键入未知 slash 名)→ 直接 `postPromptToLLM(text, blocks)`,同样跳过 store push。

2. **命令目录加载路径单一**: 既有 spec `2026-07-15-zai-builtin-commands-design.md` §1.1 写明 "**不读 OpenCC 默认命令路径(`~/.claude/commands`),zai 用 `~/.zai/commands/`(单一来源,显式配置)**" —— 这在当时是合理的隔离决定。`packages/zai/src/server/services/commands/userLoader.ts:14-17` 的 `defaultCommandsDir` 也只构造 `~/.zai/commands`。然而实际用户(尤其跨 OpenCC 工作流迁移过来的)经常把命令写到 `~/.claude/commands/`,zai 启动后这些命令不会出现在 `/` 下拉菜单。

本 spec 修复两件事: (1) 在前端补 store push + MessageBubble 渲染 muted 渲染后行; (2) 在 `userLoader` 增加 `~/.claude/commands` **单向 fallback**(zai 目录优先,不存在则取 claude)。

## 1. 范围与非范围

### 1.1 范围内

| 编号 | 改动 |
|---|---|
| A1 | `AgentInputBox.handleSend` slash 分支: `case 'prompt'` push 原始 `/{cmd} {args}` + 渲染后 `user.text`(带 `isRenderedPrompt:true` 标志) |
| A2 | `AgentInputBox.handleSend` slash 分支: `case 'unknown'` push 原始 `/{cmd} {args}` user.text(已有 push 同样跳过,需补) |
| A3 | `MessageBubble.tsx` user.text 分支: 收到 `isRenderedPrompt:true` 时,在用户气泡内前缀一行 muted 灰文本 `⤷ 渲染后:<rendered>`,视觉上紧贴原始输入之下 |
| A4 | `userLoader.ts:defaultCommandsDir` 改为返回目录序列,实现"取 `~/.zai/commands/`;不存在时取 `~/.claude/commands/`"的单向 fallback |
| A5 | `userLoader.ts:loadUserCommands` 严格走"zai → 单向 fallback claude"语义(zai 存在则**只**用 zai,不存在则**只**用 claude),不做合并;详细见 §3.4 |
| A6 | 测试: `packages/zai/test/services/commands/userLoader.test.ts` 加 3 个 case(仅 zai / 仅 claude / 两个都存在有冲突); `packages/zai/src/web/src/components/AgentInputBox.test.tsx` 加 2 个 case(`prompt` 路径 / `unknown` 路径) |
| A7 | 更新既有 spec `2026-07-15-zai-builtin-commands-design.md` §1.1: 写入本 spec 的变更说明 |

### 1.2 非范围

- server 端 `/api/agent/command` 响应形态不变(仍是 `{type, payload}`); 不引入新 variant
- 命令 registry 冲突语义不变(用户命令与 built-in 重名 → 前缀 `user:`,既有 userLoader.ts:127-145 维持)
- 不引入文件 watcher(沿用既有 MVP 行为,CRUD 后手动 reload)
- 不在 `ZAI_DATA_DIR` 重定向场景下覆盖 fallback(若 `dataDir` 显式指定,fallback 仅作用于该 `dataDir` 路径下的命令目录)
- 不改变 server 渲染机制(仍走 `renderPrompt` 替换 `$ARGUMENTS` / `$1..$n` / `${name}`)

## 2. 数据流(端到端)

```
[用户输入 /greet alice]
   ↓ selectSlashItem(type='prompt') → setInput("/greet alice ")
   ↓ 用户按 Enter → handleSend
POST /api/agent/command { name: 'greet', args: 'alice', sessionId }
   ↓ server command.ts 命中 user prompt
   ↓ getPromptForCommand → renderPrompt({ body:'Hello $ARGUMENTS', args:'alice' }) → 'Hello alice'
   ↓ res.json({ type:'prompt', payload:{ rendered:'Hello alice' } })
   ↓ 前端 case 'prompt' 路径:
       1. push userMsg_1:  { type:'user.text', text:'/greet alice' }
       2. push userMsg_2:  { type:'user.text', text:'Hello alice', isRenderedPrompt:true }
       3. await postPromptToLLM('Hello alice', [])
   ↓
[UI 渲染]
   MessageBubble:
     ┌────────────────────────────┐  ← 浅蓝 user.card, 头像 UserOutlined
     │ /greet alice              │
     │ ⤷ 渲染后:Hello alice       │  ← muted 灰, 同一 card 内
     └────────────────────────────┘
   随后:
     ┌────────────────────────────┐  ← 浅绿 assistant.card, 头像 RobotFilled
     │ LLM 流式回复               │
     └────────────────────────────┘
```

`case 'unknown'` 路径数据流相同,但只 push 第一条(原始文本),不渲染 muted 行 —— 因为 server 没做 prompt 替换,只把原文本转发给 LLM。

## 3. 接口设计

### 3.1 `AgentMessage` 扩展(运行时类型,shared/events.ts schema 不变)

```ts
// packages/zai/src/web/src/store/useAgentStore.ts (类型扩展)
export type AgentMessage = {
  // ... 既有字段
  type: 'user.text' | 'user.message' | /* ... */ 
  text?: string
  // NEW: 仅对 user.text 下的"渲染后 prompt"为 true
  isRenderedPrompt?: boolean
  // ... 既有字段
}
```

**决策**: 不改 zod schema(`packages/zai/src/shared/events.ts`),AgentMessage 是前端运行时 store 类型,不进 SSE 协议,前端任意扩展字段不影响 server。

### 3.2 `MessageBubble` 渲染分支

```ts
// packages/zai/src/web/src/components/transcript/MessageBubble.tsx:750 区域
if (msg.type === 'user.text' || msg.type === 'user.message') {
  const msgAttachments = (msg.attachments as ...) ?? [];
  const isRendered = (msg.isRenderedPrompt as boolean | undefined) ?? false;
  return (
    <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:16 }}>
      <Card size="small" style={{ maxWidth:'70%', background:'#e6f4ff', borderRadius:12 }}>
        {msgAttachments.length > 0 && <AttachmentStrip ... />}
        <Space direction="vertical" size={4} style={{ width:'100%' }}>
          <Space>
            <UserOutlined />
            <Text>{linkifyText(msg.text || msg.prompt || '')}</Text>
          </Space>
          {isRendered && (
            <Text
              type="secondary"
              style={{
                fontSize:12,
                fontStyle:'italic',
                color:'rgba(0,0,0,0.55)',
                borderLeft:'2px solid rgba(0,0,0,0.18)',
                paddingLeft:8,
              }}
            >
              <span style={{ color:'rgba(0,0,0,0.45)', marginRight:4 }}>⤷</span>
              <span style={{ fontWeight:500 }}>渲染后</span>
              <span style={{ margin:'0 6px', color:'rgba(0,0,0,0.35)' }}>·</span>
              {linkifyText(msg.text || msg.prompt || '')}
            </Text>
          )}
        </Space>
      </Card>
    </div>
  );
}
```

### 3.3 `handleSend` push 逻辑

```ts
// packages/zai/src/web/src/components/AgentInputBox.tsx:488 区域

const pushUserMsg = (text: string, isRenderedPrompt = false) => {
  useAgentStore.setState((s) => ({
    status: 'streaming',
    messages: [
      ...s.messages,
      {
        eventId: `user-${Date.now()}-${isRenderedPrompt ? 'r' : 'o'}`,
        sessionId: '',
        ts: Date.now(),
        turnIndex: 0,
        type: 'user.text',
        text,
        isRenderedPrompt,
        attachments: readyAttachments.map((a) => ({ /* ... */ })),
      },
    ],
    sendSeq: s.sendSeq + 1,
  }));
  attachments.forEach((a) => URL.revokeObjectURL(a.thumbnail));
  setAttachments([]);
};

// in case 'prompt':
case 'prompt':
  pushUserMsg(text, false);             // /greet alice
  if (result.payload.rendered) {
    pushUserMsg(result.payload.rendered, true);  // Hello alice
  }
  await postPromptToLLM(result.payload.rendered, blocks);
  return;

// in case 'unknown':
case 'unknown':
  pushUserMsg(text, false);             // 只显示原始输入
  await postPromptToLLM(text, blocks);
  return;
```

### 3.4 `userLoader.defaultCommandsDir`

```ts
// packages/zai/src/server/services/commands/userLoader.ts
function defaultCommandsDirs(dataDir?: string): string[] {
  const zaiDir = dataDir ? join(dataDir, '.zai', 'commands') : join(homedir(), '.zai', 'commands');
  const claudeDir = join(homedir(), '.claude', 'commands');
  // 单向 fallback:zai 存在则只取 zai;不存在则取 claude
  if (existsSync(zaiDir)) return [zaiDir];
  return [claudeDir];
}

function loadUserCommands(context: CommandContext): Promise<PromptCommand[]> {
  for (const dir of defaultCommandsDirs(context.dataDir)) {
    if (existsSync(dir)) {
      return scanDir(dir);   // 既有 entries 循环逻辑拆出函数
    }
  }
  return [];
}
```

实现细节: 把现有 `loadUserCommands` 的目录扫描循环提取成内部 `scanDir(dir)`,由 `loadUserCommands` 顺序遍历 `defaultCommandsDirs()` 返回的目录,首个存在的目录被扫描,后续目录**不扫描**(严格的"zai 优先,不存在则取 claude"语义,不做合并)。

### 3.5 既有 spec 更新

`docs/superpowers/specs/2026-07-15-zai-builtin-commands-design.md` §1.1 "沿用的核心约束" 修改第 2 项:

```diff
-- 不读 OpenCC 默认命令路径(`~/.claude/commands`),zai 用 `~/.zai/commands/`(单一来源,显式配置)
++ 命令加载: 优先读取 `~/.zai/commands/`;该目录不存在时,回退读取 `~/.claude/commands/`(单向 fallback,
++ 详见 `2026-07-20-zai-slash-command-ui-display-design.md`)
```

不删除既有 spec,只在原地标注已废,链接到本 spec。

## 4. 测试设计

### 4.1 `packages/zai/test/services/commands/userLoader.test.ts` 新增

| case | 描述 |
|---|---|
| 仅 `~/.claude/commands` 存在,加载 1 个命令 | `mkdtempSync(...zai-cmd-test-fallback-)` → 删 `commands/.zai` → 在 `home/.claude/commands` 写 `greet.md` → `loadUserCommands({ cwd:'/x', dataDir: tmpHome })` → 期望返回 1 条 |
| `~/.zai/commands` 与 `~/.claude/commands` 都存在,只取 zai | 两个目录都写 `greet.md`(zai 目录内 body=`Hello $ARGUMENTS`,claude 目录内 body=`Bye $ARGUMENTS`) → 期望 **只** zai 命令被加载(claude 完全被屏蔽),greeting 内容是 `Hello`(zai 胜) — 验证 §3.4 严格单向语义 |
| 两个目录都不存在 | 返回 `[]` |

注: 测试用 `dataDir=tmpHome`, 但 `defaultCommandsDirs` 同时 use `homedir()`,需要把 `process.env.HOME` 临时设到 `tmpHome`(vitest `vi.stubEnv` 或 `Object.defineProperty(process.env, 'HOME', ...)`),或者扩展 `defaultCommandsDirs` 接受 `claudeDir` 注入参数(更干净)。**采用 inject `homeDir` 参数路径** —— `defaultCommandsDirs({ dataDir, homeDir })` 内部默认 `homedir()`,测试传 `tmpHome`。`loadUserCommands` 透传 `homeDir`。

### 4.2 `packages/zai/src/web/src/components/AgentInputBox.test.tsx` 新增

| case | 描述 |
|---|---|
| `prompt` 路径推两条 user.text | mock server 返回 `{ type:'prompt', payload:{ rendered:'Hello alice' } }` → 触发 `handleSend('/greet alice')` → 断言 store.messages 末尾存在两条 `{type:'user.text'}`,第一条 `text=='/'+name+args`、第二条 `text=='Hello alice'` 且 `isRenderedPrompt===true` |
| `unknown` 路径推一条 user.text | mock server 返回 `{ type:'unknown', payload:{ input:'/greet' } }` → 断言末尾一条 user.text, `text===input text`,无 isRenderedPrompt |

需要 mock `api.post('/agent/command')` 返回对应结构,以及 `postPromptToLLM` 不被实际调用(Mock store 让 streaming 路径短路或 mock fetch)。

## 5. 风险评估

| 风险 | 缓解 |
|---|---|
| 两条 user.text 在前端跟 LLM reply 重复算 sendSeq | `sendSeq` 在 push 第二条时也 +1(既有 setState 链路已处理);`turnIndex` 0 在两条都是"发送前的用户轮"语义,满足 |
| 用户输入 raw 文本可能包含 prompt injection 的视觉欺骗(例如打字 `</div><script>`) | 与既有 user.text 同样过 `linkifyText` 不解析 HTML,zustand memory store 不会执行;不引入新攻击面 |
| `~/.claude/commands` 是 OpenCC 写入的目录,可能包含 OpenCC 专属 frontmatter 字段(zai 不识别) | zai 的 `parseFrontmatter` 已用 `yaml.load` 容错,未知字段忽略;既有 `userLoader.test.ts:62-67` "skips invalid YAML"测试已覆盖空白 frontmatter,新增 case 覆盖 partial yaml |
| fallback 路径在 CI 不存在 `~/.claude/commands` | 测试用 `tmpHome` 注入,生产路径 `homedir()` 在开发机确实常在,默认行为是 silent skip(`existsSync` false) |

## 6. 兼容性与回退

- **前向兼容**: 既有 user.text 消息没有 `isRenderedPrompt` 字段,`MessageBubble` 走默认 `false`,行为不变。回归测试既有 `AgentInputBox.test.tsx` 用例必须继续绿。
- **回退**: 若发现 fallback 把不该出现的命令带进来,回退方法:`userLoader.ts` 把 `defaultCommandsDirs` 改回返回 `[zaiDir]`,无 schema 兼容问题。
- **错误隔离**: `userLoader` catch 子句(`/commands` 目录读不到任何文件)维持既有的 `console.warn` 行为。

## 7. 检查清单(交付前)

- [ ] `AgentInputBox.test.tsx` 现有用例全绿
- [ ] `userLoader.test.ts` 现有 4 用例 + 新增 3 用例全绿
- [ ] `MessageBubble.test.tsx` 若存在,现有用例全绿
- [ ] 现有 spec `2026-07-15-zai-builtin-commands-design.md` §1.1 已加入 fallback 说明
- [ ] 本 spec 文件命名为 `YYYY-MM-DD-zai-slash-command-ui-display-design.md`,已 commit
- [ ] 没有引入新 npm 依赖
- [ ] 没有修改 zod schema / SSE 协议 / server 任何代码
