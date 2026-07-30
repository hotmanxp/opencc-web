# Z.AI 默认打开 Agent 页面

**日期**: 2026-07-30
**状态**: 已批准,待实施
**范围**: 仅前端路由

## 背景

`packages/zai/src/web/src/router.tsx` 中根路径 `/` 与通配 `*` 当前都 `Navigate to="/login"`,导致用户每次打开 Web 默认进入登录页(PA 神兵 / 开放平台 OAuth 流程)。Agent 才是日常使用主场景,登录仅偶尔需要(侧边栏菜单仍可直访 `/login`)。

## 目标

- 打开 Web(根路径 `/`)默认进入 Agent 页
- 任意未匹配路径(`*` 兜底)也进入 Agent 页,行为与根路径一致
- 不破坏 `/login`、`/tools`、`/resources`、`/config`、`/dirs`、`/dashboard`、`/m` 的直访

## 改动

**唯一改动文件**:`packages/zai/src/web/src/router.tsx`

```diff
-        <Route path="/" element={<Navigate to="/login" replace />} />
+        <Route path="/" element={<Navigate to="/agent" replace />} />
         <Route path="/login" element={<Login />} />
         ...
-        <Route path="*" element={<Navigate to="/login" replace />} />
+        <Route path="*" element={<Navigate to="/agent" replace />} />
```

## 不改动

- `Layout.tsx` Sider 菜单顺序:保持当前 `登录 / 系统信息 / 工具 / 资源 / 配置 / 目录 / Agent`,登录入口仍可直访
- `Login.tsx` 内容不变
- `Agent.tsx` 内容不变;沿用现有 `useAgentStore` session 初始化逻辑
- `MobileLayout.tsx` / `MobileAgent.tsx`:移动端 `/m` 路径独立保留
- 任何 server 端路由

## 数据流

无变化。`<Agent />` 挂载时按现有逻辑:
1. `useAgentStore` 检查 `sessions`
2. 列表为空 → `createNewSession()`
3. 触发 `loadTranscript()` 拉取 transcript
4. 渲染 `AgentConversation` + `AgentInputBox`

## 错误处理

- `*` 落到 `/agent` 后,`Agent` 组件按正常空 session 流程兜住,无新错误路径
- 直接访问 `/login` 仍能进入登录页(用于需要时手动触发 OAuth 流程)

## 测试

- 单元测试无需新增或修改:
  - `App.test.tsx` 仅测主题,无关路由
  - `Agent.test.tsx` 仅测 Agent 组件本身,无关默认入口
  - 项目无路由级单测模式
- 手动验证步骤:
  1. 启动 `pnpm --filter zai dev`
  2. 浏览器打开 `http://localhost:<port>/` → 应进入 Agent 页
  3. 浏览器打开 `http://localhost:<port>/foo/bar` → 应跳转到 Agent 页
  4. 浏览器打开 `http://localhost:<port>/login` → 仍进入登录页
  5. Sider 菜单点击 "Agent" → 高亮 `/agent`,正常加载

## 风险

- 极低。仅两处客户端字符串常量变更
- 后续如要恢复默认登录入口,改回 `to="/login"` 即可,无需迁移
