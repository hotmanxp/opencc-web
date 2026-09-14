# 多 Session cwd 持久化(zai patch,2026-09-14)

> **来源**:基于 deep-research 调研(2026-09-14,3 路 agent 共识)
> **目标**:把 vendor BashTool 的进程级 `STATE.cwd` 单例 + zai 手工维护的 `CwdStore` 升级为 **per-session 真实的 cwd 持久化** — 多 session 互不干扰、同 session 内 cd 自动累积、跨 turn 不重置。
> **范围**:compat 层 + zai server。不改 vendor(`@zn-ai/zn-agent-core/opencc-src/*`),通过 wrap vendor `BashTool.call` 在 compat 层接 cwd 自动同步。

## 1. 背景与现状

### 1.1 核心矛盾(deep-research 结论)

| 真相源 | 写入者 | 读取者 | 粒度 |
|--------|--------|--------|------|
| vendor `STATE.cwd`(`opencc-src/bootstrap/state.ts:72`) | vendor `BashTool` 跑完 bash 后 trailer `pwd -P >\| tmpfile` 触发 `setCwdState()` | vendor `pwd()`(`utils/cwd.ts:19`) | **进程级单例** |
| vendor `sdkContextStorage.cwd`(`bootstrap/state.ts:464` ALS) | zai `routes/agent.ts:1394` `runWithSdkContext({ cwd })` 注入;trailer 完成后 `setCwdState` 也在 ALS context 内**只更新 ctx.cwd 不更新 STATE** | vendor `getCwdState()` 优先读 ctx.cwd(`state.ts:617-620`) | **per-async-context** |
| zai `CwdStore: Map<sessionId, SessionCwd>`(`compat/cwdStore.ts:20`) | **仅手工**:`POST /agent/sessions`(agent.ts:2068)+ `weixinInboundBridge.ts:533`,**BashTool cd 永不回填** | `GET /pwd` 路由 + `resolveInboxCwd`(agent.ts:1093-1102) | **per-session(只读镜像)** |

### 1.2 三方冲突(deep-research §4)

- **冲突 #1**:zai 是否改写 BashTool 行为 — **B + C 一致**:只 patch `checkPermissions`,cwd 路径 100% 沿用 vendor
- **冲突 #2**:`CwdStore` 是否自动同步 BashTool cd — **B + C 一致**:**不自动同步**,这是 zai 的功能性缺口
- **冲突 #3**:`runWithSdkContext({ cwd })` 是否真的影响 BashTool spawn cwd — **B 正确**:是的,通过 `getCwdState() = ctx?.cwd ?? STATE.cwd`(state.ts:617-620)
- **冲突 #4**:vendor `getCwdState` 的 ALS 优先级 — **B + C 一致**:`cwdOverrideStorage > ctx.cwd > STATE.cwd`

### 1.3 当前 bug 复现路径

```
[turn 1]
  POST /agent/prompt → runQueryLoop:
    runWithSdkContext({ sessionId: 'sid-1', cwd: '/Users/me/proj' }, query)
      BashTool.call({ command: 'cd /tmp' })
        Shell.exec → spawn bash -c "cd /tmp && pwd -P >| tmpfile"
        trailer → setCwdState('/tmp') → mutates ctx.cwd → '/tmp'
      BashTool returns. ctx discarded.
  CwdStore.get('sid-1') === undefined → 仍是 undefined

[turn 2]
  POST /agent/prompt → runQueryLoop:
    cmd.cwd = resolveInboxCwd('sid-1') = CwdStore.get('sid-1') ?? process.cwd()
                                          = undefined ?? process.cwd()
                                          = process.cwd()  ← 重置回默认
    runWithSdkContext({ sessionId: 'sid-1', cwd: process.cwd() }, query)
      BashTool.call({ command: 'pwd' })
        → '/Users/me' 不是 '/tmp' ← turn 1 的 cd 消失
```

**root cause**:`CwdStore` 是只读镜像,vendor 的 cwd 状态在 ALS context 退出后被丢弃,而 zai 拿不到 trailer 更新值。

## 2. 目标

- **G1**:同 session 内连续多次 BashTool 调用,`cd` 自动累积(下一次 Bash 在新目录)
- **G2**:同 session 跨 turn 时,上次 cd 仍然生效(不重置回 process.cwd())
- **G3**:多 session 并存时,每个 session 有独立的 cwd(互不干扰)
- **G4**:session 重建/进程重启后 cwd 归零(可接受,已在 `CwdStore.ts:8` 注释里说明)
- **G5**:不改 vendor(opencc-src/*)— 通过 compat 层 wrap BashTool 完成
- **G6**:与现有 vendor 行为兼容(`preventCwdChanges` / `cwdOverrideStorage` ALS / subagent path)

## 3. 非目标(明确不做)

- **不做** vendor `STATE.cwd` 改为 `Map<sessionId, cwd>` — vendor 改造需要 build:core + 全工具回归测试,改动面太大
- **不做** 磁盘持久化(进程重启后 cwd 恢复) — Phase 2 可选
- **不做** 前端 BashTab REPL(`ReplSession.cwd`)修复 — 独立子系统,A 独家发现,Phase 2/3 处理
- **不做** `cwd.changed` 事件的 emit 修复(`stateBridge.ts:30-32` 订阅但全仓库从未 emit) — Phase 2 处理
- **不做** subagent 的 `runWithCwdOverride` 调用 — vendor 已有机制,缺 zai 调用方,留作后续

## 4. 架构与组件边界

### 4.1 新建/修改文件

| 路径 | 改动 | 估行数 |
|------|------|--------|
| **改** `packages/zn-agent-core/src/compat/tools/opencc/builtin.ts` | 新增 `wrapBashToolWithCwdSync` 函数(纯函数,无副作用),在 `getOpenccBuiltinTools()` 取出 `BashTool` 后**先 wrap 再 `forceAllowCheckPermissions`**;wrap 后的 `wrappedBash` 放入 `cachedTools` 数组 | +50 |
| **改** `packages/zn-agent-core/src/bundle-entry.ts` | 不需要新增 export(`runWithSdkContext` / `SdkContext` / `getCurrentSessionId` / `CwdStore` 都已导出) | 0 |
| **不改** `packages/zn-agent-core/src/compat/cwdStore.ts` | `getOrInit` 已存在(cwdStore.ts:31-36),无需新增方法 | 0 |
| **不改** `packages/zai/src/server/routes/agent.ts` | 外层 `runWithSdkContext({ cwd })` 保留 — Phase 1 不破坏现有行为,Phase 3 可移除 | 0 |
| **新建** `packages/zn-agent-core/test/unit/compat/builtin.cwdWrap.test.ts` | 单元测试:mock BashTool + getSdkContext + CwdStore,验证 wrap 前后行为 | ~120 |

### 4.2 组件边界理由

- **wrap 函数放在 compat/tools/opencc/builtin.ts**:BashTool 已经在那里被导出 + `forceAllowCheckPermissions`,wrap 是同一层级的操作,放在一起不增加新文件依赖
- **不动 vendor opencc-src/***:vendor 已经被 fork(zai 自有 patch),继续 patch 会让 vendor 与 upstream drift 增加;compat 层 wrap 是 AGENTS.md 推荐路径
- **不改 routes/agent.ts**:外层 `runWithSdkContext({ cwd })` 仍然必要 — 它给 vendor 非 bash 路径(transcript 落盘 `originalCwd` 等)透传 cwd;compat wrap 接管 bash 路径,两者并存

## 5. 核心机制详解

### 5.1 wrap 函数实现

```ts
// compat/tools/opencc/builtin.ts 内新增
function wrapBashToolWithCwdSync(tool: OpenccBuiltinTool): OpenccBuiltinTool {
  const originalCall = tool.call.bind(tool)
  return {
    ...tool,
    async call(input, toolUseContext, ...rest) {
      const sid = getCurrentSessionId()  // compat ALS,runQueryLoop 已设
      if (!sid) return originalCall(input, toolUseContext, ...rest)

      const beforeCwd = CwdStore.get(sid) ?? process.cwd()
      const ctx: SdkContext = {
        sessionId: sid,
        sessionProjectDir: null,
        cwd: beforeCwd,
        originalCwd: beforeCwd,
      }
      await runWithSdkContext(ctx, async () => {
        await originalCall(input, toolUseContext, ...rest)
      })
      // runWithSdkContext 闭包结束后,ctx 仍是同一对象引用;
      // setCwdState() 在 originalCall 内部把 ctx.cwd 直接 mutate 到新 cwd
      if (ctx.cwd !== beforeCwd) {
        CwdStore.set(sid, ctx.cwd)
      }
    },
  }
}
```

### 5.2 关键不变量

1. **`runWithSdkContext` 嵌套语义**:ALS 标准语义,`sdkContextStorage.getStore()` 返回**最内层** ALS;zai 外层 `runWithSdkContext({ sessionId, cwd })` 嵌套在内层 `runWithSdkContext({ sessionId: sameSid, cwd: cstore.get })` 外,但 vendor 读 `ctx.cwd` 时取最内层 — 即 compat wrap 喂的 cstore 值
2. **`setCwdState` mutate 语义**:`setCwdState(cwd)`(`state.ts:622-629`)在 ctx 存在时**直接 mutate ctx.cwd**(line 625 `ctx.cwd = cwd.normalize('NFC')`),所以闭包退出后 `ctx.cwd` 仍是新值
3. **`getCurrentSessionId()` 来自 compat ALS**:zai `routes/agent.ts:1127` `runWithSessionId(cmd.sessionId, async () => ...)` 已经把 sessionId 灌进 compat ALS,BashTool.call 调用时该 ALS 仍 active
4. **`preventCwdChanges` 不冲突**:subagent 路径下 vendor 设 `preventCwdChanges=true`,`Shell.ts:425` 守卫 `!preventCwdChanges` 阻止 `setCwdState` 触发 → ctx.cwd 不变 → wrap 后 `ctx.cwd === beforeCwd` → 不写 CwdStore ✓

### 5.3 wrap 后的工具对象身份

- 用 `{...tool, call: wrappedCall}` 浅拷贝,其他属性(`name` / `description` / `inputSchema` / `prompt` 等)沿用 vendor 原对象
- `forceAllowCheckPermissions(wrappedBash)` 改 wrappedBash 的 `checkPermissions`(不需走 `Object.defineProperty` 二次保险,直接赋值即可,因为 wrappedBash 是新对象,可写)
- vendor 的 `toolUseContext.options.tools` 数组拿到的是 wrappedBash,所有 vendor 路径(BashTool.call / ToolRegistry / tool search)用的都是 wrappedBash.call,绕过就失效

## 6. 数据流(turn 1 + turn 2)

```
[turn 1: cd /tmp && pwd]
  POST /agent/prompt
    runQueryLoop:
      runWithSessionId('sid-1', async () => {
        runWithSdkContext({ sessionId: 'sid-1', cwd: process.cwd() }, query)  ← 外层,zai 喂
          query → 工具分发 → wrappedBash.call({ command: 'cd /tmp' })
            ┌─ wrap step 1: sid = getCurrentSessionId() = 'sid-1'
            ├─ wrap step 2: beforeCwd = CwdStore.get('sid-1') ?? process.cwd() = '/Users/me'
            ├─ wrap step 3: ctx = { sessionId: 'sid-1', cwd: '/Users/me', originalCwd: '/Users/me' }
            ├─ wrap step 4: runWithSdkContext(ctx, async () => {
            │     originalCall({ command: 'cd /tmp' })
            │       → BashTool.call → Shell.exec → spawn bash -c 'cd /tmp && pwd -P >| tmpfile'
            │       → bash 写 /tmp 到 tmpfile → Node readFileSync → setCwdState('/tmp')
            │       → setCwdState mutate ctx.cwd = '/tmp'  ← 同 ctx 对象引用
            │   })
            └─ wrap step 5: ctx.cwd = '/tmp' ≠ beforeCwd → CwdStore.set('sid-1', '/tmp')

[turn 2: pwd]
  POST /agent/prompt
    cmd.cwd = resolveInboxCwd('sid-1') = CwdStore.get('sid-1') = '/tmp'  ← 跨 turn 保留
    runWithSessionId('sid-1', async () => {
      runWithSdkContext({ sessionId: 'sid-1', cwd: '/tmp' }, query)
        wrappedBash.call({ command: 'pwd' })
          wrap step 2: beforeCwd = CwdStore.get('sid-1') = '/tmp'  ← CwdStore 持续反映
          ...
          pwd 输出 '/tmp' ✓

[多 session: sid-2 同时刻跑 cd /etc]
  wrappedBash.call({ command: 'cd /etc' })
    sid = getCurrentSessionId() = 'sid-2'  ← compat ALS per-async-context 隔离
    beforeCwd = CwdStore.get('sid-2') ?? process.cwd() = '/Users/me'
    ctx = { sessionId: 'sid-2', cwd: '/Users/me', ... }
    runWithSdkContext(ctx, originalCall)
    ctx.cwd = '/etc' → CwdStore.set('sid-2', '/etc')
  sid-1 的 CwdStore 不动 = '/tmp' ✓
```

## 7. 边界场景

| 场景 | 行为 | 实现 |
|------|------|------|
| **subagent bash** | `preventCwdChanges=true` → `setCwdState` 不触发 → ctx.cwd 不变 → wrap 不写 CwdStore | 现有 vendor 守卫 `Shell.ts:425` |
| **background bash** | `result.backgroundTaskId` 已设 → 同上不更新 cwd | 现有 vendor 守卫 |
| **concurrent 多 session** | 每个 session 的 compat ALS `getCurrentSessionId()` 不同 → wrap 各处理各的 CwdStore key | AsyncLocalStorage 隔离 |
| **concurrent 同 session 多次 Bash** | 单 turn 内串行(LLM tool_use 串行分发),不冲突 | 不需特殊处理 |
| **session 创建** | `POST /agent/sessions` body.cwd 走 `CwdStore.set(sid, cwd)` — 与 wrap 协作,初始值正确 | 现有 zai `agent.ts:2068` |
| **session 删除** | `DELETE /agent/sessions/:id` 调 `CwdStore.delete(sid)` — wrap 后下次再访问返回 undefined → fallback process.cwd() | 现有 zai `agent.ts:2117` |
| **cwd 目录被删后 cd** | `Shell.ts:236-266` cwd 失效 → vendor 回 `getOriginalCwd()` → trailer 写回 | 现有 vendor |
| **getCurrentSessionId() 为空** | wrap 直接走 `originalCall`(不包 inner ctx,不写 CwdStore) | wrap 守卫 |
| **wrap 期间 throw** | CwdStore 不写(因为在 await 之后才写);vendor error 上抛,LLM 看到 tool_error | wrap try/catch 不需要,bash 自然冒泡 |

## 8. 测试用例

### 8.1 单元测试:wrap 函数(mock BashTool)

`packages/zn-agent-core/test/unit/compat/builtin.cwdWrap.test.ts`:

- **no sessionId**: `getCurrentSessionId()` returns undefined → 直接调 originalCall,不读 CwdStore,不写
- **first call writes CwdStore when ctx.cwd changes**:mock BashTool.call 让 runWithSdkContext 内部把 ctx.cwd 改成 '/tmp'(模拟 vendor trailer 副作用) → wrap 后 `CwdStore.get(sid) === '/tmp'`
- **no write when ctx.cwd unchanged**:mock BashTool 不改 ctx.cwd → wrap 后 CwdStore 仍是 process.cwd()
- **CwdStore pre-existing value**:预 set CwdStore.set(sid, '/existing') → wrap 读 '/existing' 作为 beforeCwd
- **CwdStore miss → process.cwd() fallback**:无 CwdStore entry → wrap 用 process.cwd()
- **sessionId isolation**:两个 session 并行 wrap → CwdStore 各自 entry 互不干扰

### 8.2 集成测试(可选,Phase 1.5)

模拟实际 BashTool 调用,用 child_process spawn `bash -c 'cd /tmp && pwd'`:
- 真实 setCwdState 触发
- 验证 CwdStore 写入

(可以走 vendor 的 BashTool.call + 简单 bash 命令,端到端验证)

### 8.3 手动验证(/ego-browser,Phase 1 完成后)

```bash
pnpm --filter @zn-ai/zai dev -- --port 8102 --api-port 7715
```

1. 创建 session A,prompt: `cd /tmp && pwd` → 应输出 `/tmp`
2. 续 prompt: `pwd` → **应输出 `/tmp`(不再是 process.cwd)**
3. 创建 session B(同 server 实例),prompt: `pwd` → 应输出 process.cwd(隔离)
4. session A 续 prompt: `cd /etc && pwd` → `/etc`
5. session A 续 prompt: `pwd` → `/etc`(继续累积)
6. 重启 server,session A 续 prompt: `pwd` → 应回到 process.cwd(进程重启 cwd 重置)

## 9. 兼容性

- **vendor BashTool 行为零变化**:wrap 仅在外部包一层,内部 originalCall 走 100% vendor
- **`forceAllowCheckPermissions` 兼容性**:wrap 之后再 patch checkPermissions,不影响 wrap 的 cwd 处理
- **subagent 兼容**:`runWithCwdOverride` ALS 仍生效(vendor pwd() 优先级 cwdOverrideStorage > ctx.cwd > STATE.cwd),wrap 写 CwdStore 但下次 wrap 读 CwdStore 仍会被 cwdOverrideStorage 屏蔽 — 行为正确
- **zustand store / session projection 兼容**:不改 session 投影字段
- **现有 BashTool 单测**(如有):vendor BashTool 自身测试不受影响(走 vendor path);新测试走 compat wrap

## 10. 验收清单(完成定义)

- [ ] `wrapBashToolWithCwdSync` 函数实现 + `getOpenccBuiltinTools` 调用 wrap
- [ ] 单元测试 8.1 全部用例 PASS
- [ ] `pnpm --filter @zn-ai/zn-agent-core test test/unit/compat/builtin.cwdWrap.test.ts` 绿
- [ ] `pnpm --filter @zn-ai/zn-agent-core test test/unit/compat/openccInit.test.ts`(可能受 wrap 影响)绿
- [ ] `pnpm --filter @zn-ai/zai test test/server/routes/agent.ts`(runQueryLoop 相关)绿
- [ ] `pnpm run build:core` 成功(vendor 没改但 bundle 重打)
- [ ] 手动 /ego-browser 验证 6 步全过(创建 session A → cd → 续 pwd → 多 session 隔离 → 累积 → 重启重置)
- [ ] Phase 2(磁盘持久化)/ Phase 3(外层 runWithSdkContext 简化)留给后续 plan

## 11. 相关文档

- `docs/superpowers/specs/...` — 当前 spec
- `docs/superpowers/plans/2026-09-14-zai-cwd-multi-session-persistence.md` — 实施 plan
- deep-research 终稿:`/tmp/deep-research-vendor-bash-cwd-FINAL.md`
- 子报告:
  - A: `/tmp/deep-research-vendor-bash-cwd-A.md`(Explore,本地)
  - B: `/tmp/deep-research-vendor-bash-cwd-B.md`(opencc vendor)
  - C: `/tmp/deep-research-vendor-bash-cwd-C.md`(dsh vendor)
- vendor 关键代码:
  - `packages/zn-agent-core/src/opencc-src/utils/Shell.ts:197-479` — Shell.exec + trailer 写入
  - `packages/zn-agent-core/src/opencc-src/utils/shell/bashProvider.ts:76-197` — buildExecCommand 拼 trailer
  - `packages/zn-agent-core/src/opencc-src/bootstrap/state.ts:72` / `:617-629` — STATE.cwd + getCwdState/setCwdState
  - `packages/zn-agent-core/src/opencc-src/tools/BashTool/BashTool.tsx:526` / `:736` / `:998` / `:1055` — BashTool 入口
- zai 关键代码:
  - `packages/zn-agent-core/src/compat/cwdStore.ts:1-55` — CwdStore(已存在 getOrInit)
  - `packages/zn-agent-core/src/compat/tools/opencc/builtin.ts:78-222` — getOpenccBuiltinTools 入口
  - `packages/zai/src/server/routes/agent.ts:1127` / `:1393-1394` / `:2068` / `:2082` / `:2117` — zai runQueryLoop + CwdStore 调用点
  - `packages/zn-agent-core/src/bundle-entry.ts:98-108` — CwdStore / runWithSessionId / runWithSdkContext 导出
