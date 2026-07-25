# zai Agent 页面 LAN 分享 — Design Spec

**日期**: 2026-07-25
**作者**: brainstorming session
**状态**: 设计待 review

## 1. 背景与目标

zai 当前 server 只 listen 在 `127.0.0.1`,本机独享;团队/会议演示场景中,主讲人希望让同局域网(LAN)用户通过浏览器跟随 Agent 实时对话。需要在不破坏现有 local-only 安全默认的前提下,**显式 opt-in** 暴露 server 到 LAN,提供"复制分享链接"能力。

**目标**:
- 用户启动 `zai --lan`,server 监听 `0.0.0.0:port`,LAN 用户可访问
- Agent 页面工具栏新增"分享"按钮,弹出 IP 列表,点选即复制 `http://<ip>:<port>/agent?sid=<sid>`
- 复用现有 `?sid=` 路由机制(已由 `useAgentStore` 处理,无需新增路由适配)

**非目标**:
- 公网访问 / 鉴权(明确不在本期)
- QR 码(已与用户确认不引入)
- share-link 持久化进 transcript(本期纯 URL)
- 自动检测 client 是 LAN 端(用户决定用 server 提供的列表)

## 2. 用户体验

### 启动
```bash
zai --lan        # 监听 0.0.0.0,LAN 可达
zai              # 默认 127.0.0.1,行为不变
```

### 操作流
1. 用户在 Agent 页面输入若干对话,产生一个 `sessionId`
2. 点工具栏 `ShareAltOutlined` 按钮 → 弹出 Popover,标题"分享到 LAN"
3. Popover 列出所有候选地址,每行 `<ip>:<port>` + `<ip>:<port>/agent?sid=<sid>` + 复制图标
4. 用户选某行点复制 → toast "已复制 http://192.168.x.x:port/agent?sid=..."
5. 把链接发给 LAN 同事,对方浏览器打开即进入同一会话

### 边界态
- 无 sessionId(空 session):按钮 disabled
- `instanceContext.ips` 为空(可能 `--lan` 没启用):弹层显示 "未启用 --lan" 提示
- `navigator.clipboard.writeText` reject:弹 `message.error` + 文本可选中

## 3. 架构

### 改动面

| 层 | 文件 | 变更 |
|---|---|---|
| CLI | `packages/zai/src/cli/start.ts` | 加 `--lan` flag,`true` 时 host='0.0.0.0',传入 `createApp` |
| CLI | `packages/zai/src/cli/ports.ts` | `listen(port, host)` host 改为参数化 |
| Server types | `packages/zai/src/server/types.ts` | `AppOptions` 加 `host?: string` |
| Server app | `packages/zai/src/server/index.ts` | `createApp` 把 host 注入 `app.locals.instanceContext` |
| Server utils | `packages/zai/src/server/utils/lanIps.ts` (新) | `detectLanIps()` 探测非 internal IPv4 列表 |
| Server route | `packages/zai/src/server/routes/system.ts` | GET `/system` 返回 `host`, `port`, `ips` |
| Web store | `packages/zai/src/web/src/store/useAppStore.ts` | `instanceContext` 加 `host`, `port`, `ips` |
| Web entry | `packages/zai/src/web/src/components/Layout.tsx` | hydrate effect 把新字段透传 |
| Web UI | `packages/zai/src/web/src/components/AgentInputBox.tsx` | 工具栏加 `ShareAltOutlined` 按钮 + Popover |
| Web UI | `packages/zai/src/web/src/components/SharePopover.tsx` (新) | 弹层内容:IP 列表 + 复制按钮 |

### 数据流

```
启动:
  zai --lan
    → start.ts parseArgs({lan: true})
    → host = '0.0.0.0', port = <resolved>
    → server.listen(port, host, ...)
    → createApp({ cwd, cwdName, token, port, host })
    → app.locals.instanceContext = { cwd, cwdName, host }
    → /api/system GET → 返回 { host, port, ips, cwd, cwdName, branch }
    → detectLanIps() 遍历 os.networkInterfaces(),过滤 IPv4 && !internal

前端启动 hydrate:
  Layout useEffect
    → api.get('/system') → data
    → setInstanceContext({ cwd, cwdName, branch, host, port, ips })

用户点分享:
  AgentInputBox ShareAltOutlined Button onClick
    → setShareOpen(true)
  Popover open
    → SharePopover 渲染
      - 从 useAppStore.instanceContext 取 ips / port
      - 从 useAgentStore.sessionId 取 sid
      - 每行 url = `http://${ip}:${port}/agent?sid=${sid}`
      - Copy 按钮 onClick
        → navigator.clipboard.writeText(url)
        → 成功: message.success("已复制 ...")
        → 失败: message.error("复制失败")
  Popover close (用户点外侧 / 再次点 Share 按钮 / 点某行的 Copy 完成后)
```

## 4. 关键设计决策

### 4.1 `--lan` flag 而非环境变量
- CLI flag 比 `ZAI_LAN=1` 更直观,与 zai 现有 CLI 风格一致(其他 flag 如 `--port` 已存在)
- 默认 `127.0.0.1` 保留 local-only 安全默认,避免误开

### 4.2 IPs 在 server 端探测而非前端
- 前端浏览器无 `os.networkInterfaces()`,必须 server 端探测
- 探测 + `/api/system` 返回统一在 server,前端只渲染
- 探测时机:每次 `/api/system` 调用(轻量、无副作用)

### 4.3 复用现有 `?sid=` 路由
- `useAgentStore.ts:18-33` 已有 `readUrlSid / writeUrlSid`,store 内部自动同步
- 分享 URL `?sid=<sid>` 客户端打开 → store 读 URL sid → `setCurrentSession` → 加载 transcript
- **无需新增路由适配**

### 4.4 按钮 disabled 而非 hidden
- 无 sessionId 时按钮 disabled,提示"先开一个会话"
- `ips.length === 0` 时按钮可点,Popover 显示"未启用 --lan"

### 4.5 弹层受控 Popover
- 用 AntD `Popover trigger="click" open={shareOpen}`,与 SettingsDrawer 模式一致
- 关闭路径:点外侧 / 再次点 Share 按钮 / Escape

### 4.6 Popover 位置
- 工具栏加在 `<span flex:1 spacer>` 后、`SettingsButton` 之前,即工具栏右端最右位置
- 选择理由:`flex:1` spacer 把按钮推到 row 最右端,Share 是核心操作 (演示场景),放最右突出
- 不与现有 6 个图标挤;toolbar 用 `flex` + `flexShrink: 0`,新按钮自然落位

## 5. 数据契约

### GET /api/system 返回

```ts
{
  ok: boolean,
  version: string,
  cwd: string,
  cwdName: string,
  branch: string | null,
  host: string,         // 新增 - 实际 bind 的 host ('127.0.0.1' | '0.0.0.0' | ...)
  port: number,         // 新增 - 实际 bind 的端口
  ips: string[]         // 新增 - os.networkInterfaces() 过滤后的 IPv4 列表
}
```

### `app.locals.instanceContext` 扩展

```ts
{
  cwd: string,
  cwdName: string,
  host: string          // 新增 - 默认 '127.0.0.1'
}
```

### `useAppStore.instanceContext` 扩展

```ts
{
  cwd: string,
  cwdName: string,
  branch: string | null,
  host: string,         // 新增
  port: number,         // 新增
  ips: string[]         // 新增
} | null
```

## 6. 错误处理

| 场景 | 行为 |
|---|---|
| `navigator.clipboard` 不可用(insecure context) | `message.error("复制失败,请手动选择")` + URL 用 `<code>` 包裹可手动复制 |
| clipboard.writeText reject | `message.error("复制失败")` |
| `instanceContext.ips` 空 | Popover 显示"未启用 `--lan`,无法分享到局域网" |
| `sessionId` 空 | 按钮 disabled,tooltip 提示"先开一个会话" |
| server 启动时 `--lan` 但端口被占 | 现有 ports.ts 抛 EADDRINUSE,行为不变 |

## 7. 测试策略

### Server
- `packages/zai/test/server/lanIps.test.ts`(新)
  - `detectLanIps()` 不包含 `127.0.0.1`/`::1`
  - 去重正确(同名 interface 多个 address)
- `packages/zai/test/server/system-route.test.ts`(新)
  - GET `/api/system` 返回 `host/port/ips` 字段,缺一报 500
- `packages/zai/test/cli/start-lan.test.ts`(新)
  - `--lan` 时 server listen `0.0.0.0`
  - 不带 `--lan` 时 server listen `127.0.0.1`(行为不变)
- 现有 `test/cli/ports.test.ts`:扩展签名,原有 EADDRINUSE case 保持通过

### Web
- `packages/zai/test/web/SharePopover.test.tsx`(新)
  - 无 sessionId → 显示"先开一个会话"
  - `ips.length === 0` → 显示"未启用 --lan"
  - 有 sessionId + ips → 渲染 N 行,点 Copy 调 `navigator.clipboard.writeText`
  - `clipboard.writeText` reject → `message.error` 被调
- `packages/zai/test/web/AgentInputBox.test.tsx`(现有文件):新增 case
  - `data-testid="share-button"` 存在
  - 无 sessionId 时 disabled
  - 点 share 按钮 → Popover 打开

## 8. 文件清单(本 spec 影响的所有文件)

**新建**:
- `packages/zai/src/server/utils/lanIps.ts`
- `packages/zai/src/web/src/components/SharePopover.tsx`
- `packages/zai/test/server/lanIps.test.ts`
- `packages/zai/test/server/system-route.test.ts`
- `packages/zai/test/cli/start-lan.test.ts`
- `packages/zai/test/web/SharePopover.test.tsx`

**修改**:
- `packages/zai/src/cli/start.ts`
- `packages/zai/src/cli/ports.ts`
- `packages/zai/src/server/types.ts`
- `packages/zai/src/server/index.ts`
- `packages/zai/src/server/routes/system.ts`
- `packages/zai/src/web/src/store/useAppStore.ts`
- `packages/zai/src/web/src/components/Layout.tsx`
- `packages/zai/src/web/src/components/AgentInputBox.tsx`
- `packages/zai/test/cli/ports.test.ts`(如需更新)
- `packages/zai/test/web/AgentInputBox.test.tsx`(新增 case)

## 9. 风险与边界

### 风险
1. **网络安全**:`--lan` 后 server 无鉴权,LAN 任意人都能访问 → 与 zai 现有"local-only,无鉴权"模型一致,用户 opt-in 自负其责
2. **firewall 拦截**:部分 OS 防火墙弹窗会拦截 0.0.0.0 监听 → 用户需手动放行(常见 OS 行为,不在代码可控范围)
3. **多网卡 IP 选择**:不同 OS interface 命名差异大 → 由 `detectLanIps()` 返回全列表,前端让用户挑

### 边界
- 本期不持久化 share 链接
- 本期不做 share 链接过期
- 本期不记录"谁通过 share 链接访问"