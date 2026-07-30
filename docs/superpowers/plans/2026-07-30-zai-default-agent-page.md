# Z.AI 默认打开 Agent 页面 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打开 Z.AI Web 客户端时,根路径 `/` 与任意未匹配路径默认进入 Agent 页(而非登录页);`/login` 等其他路径仍可直访。

**Architecture:** 仅修改前端 React Router 配置(`packages/zai/src/web/src/router.tsx`),把根路径与通配 `*` 兜底的 `<Navigate to="/login" />` 改为 `<Navigate to="/agent" />`。`/agent` 路由已存在,挂载现有 `<Agent />` 组件,不引入新文件、新依赖、新状态。

**Tech Stack:** React Router v6 (`<Routes>` / `<Route>` / `<Navigate>`),AntD 侧边栏,Vitest + happy-dom(项目无路由级单测模式,本次不新增单元测试)。

## Global Constraints

- 改动范围严格限定为 `packages/zai/src/web/src/router.tsx`,不触碰 server 端路由、`Layout.tsx` Sider 顺序、`Login.tsx`、移动端 `/m`、其他已存在路径
- `/login`、`/tools`、`/resources`、`/config`、`/dirs`、`/dashboard` 直访行为不变
- 移动端 `/m` 走 `MobileLayout` + `MobileAgent`,与本次改动无关
- 项目无路由级单测,本次按 spec 不新增单元测试,以手动验证为准
- 不修改 `pnpm-lock.yaml` / `package.json` / 任何依赖

## File Structure

- **Modify**: `packages/zai/src/web/src/router.tsx`
  - 唯一文件,改第 37 行与第 45 行的 `<Navigate to="/login" replace />` → `<Navigate to="/agent" replace />`

---

## Task 1: 翻转根路径与 404 兜底的默认跳转目标

**Files:**
- Modify: `packages/zai/src/web/src/router.tsx:37`
- Modify: `packages/zai/src/web/src/router.tsx:45`

**Interfaces:**
- Consumes: 无(纯字符串常量)
- Produces: 桌面端根路径 `/` 与任意未匹配路径(`*`)均导航到 `/agent` 路由;`/agent` 路由已存在,挂载 `Agent` 组件;`/login` 仍由 `Login` 组件渲染,Sider 菜单"登录"项指向 `/login` 不变

- [ ] **Step 1: 打开 router.tsx 定位两处目标行**

```bash
# 确认目标行号
grep -n 'to="/login"' /Users/ethan/code/opencc-web/packages/zai/src/web/src/router.tsx
# 预期输出 (行号可能略有漂移, 以 grep 结果为准):
# 37:        <Route path="/" element={<Navigate to="/login" replace />} />
# 45:        <Route path="*" element={<Navigate to="/login" replace />} />
```

两处 `to="/login"` 必须各只命中一次,且都出现在桌面端 `<Route element={<Layout />}>` 子路由块内。命中行数若 ≠ 2,停下来核查,不要继续。

- [ ] **Step 2: 翻转根路径第 37 行的跳转目标**

用 `Edit` 工具:

- `old_string`: `<Route path="/" element={<Navigate to="/login" replace />} />`
- `new_string`: `<Route path="/" element={<Navigate to="/agent" replace />} />`
- `replace_all`: false

- [ ] **Step 3: 翻转 404 兜底第 45 行的跳转目标**

用 `Edit` 工具:

- `old_string`: `<Route path="*" element={<Navigate to="/login" replace />} />`
- `new_string`: `<Route path="*" element={<Navigate to="/agent" replace />} />`
- `replace_all`: false

- [ ] **Step 4: 自检改动**

```bash
# 1. 应已无任何 to="/login" 残留
grep -n 'to="/login"' /Users/ethan/code/opencc-web/packages/zai/src/web/src/router.tsx
# 预期: 无输出 (exit code 1)

# 2. 应出现两处 to="/agent" 兜底
grep -n 'to="/agent"' /Users/ethan/code/opencc-web/packages/zai/src/web/src/router.tsx
# 预期:
# 37:        <Route path="/" element={<Navigate to="/agent" replace />} />
# 45:        <Route path="*" element={<Navigate to="/agent" replace />} />

# 3. /agent / /login 等具体路径路由仍在
grep -n 'path="/agent"\|path="/login"\|path="/tools"\|path="/dashboard"' /Users/ethan/code/opencc-web/packages/zai/src/web/src/router.tsx
# 预期: 6 行 (path="/login" + path="/tools" + path="/resources" + path="/config" + path="/dirs" + path="/agent" + path="/dashboard")
```

- [ ] **Step 5: 跑前端构建/类型检查,确认无回归**

```bash
cd /Users/ethan/code/opencc-web/packages/zai
pnpm tsc --noEmit 2>&1 | tail -20
# 预期: 无新增 TS 错误. 若有, 停下来排查.
```

注:如果项目没有 `tsc` 脚本,改跑 `pnpm build` 看是否能成功编译前端 bundle。

- [ ] **Step 6: 启动 dev server 手动验证(可选但建议)**

```bash
cd /Users/ethan/code/opencc-web/packages/zai
pnpm dev &
DEV_PID=$!
sleep 5
# 用浏览器或 curl 验证重定向 (具体端口从启动日志读, 默认常见为 5173/4000/8080)
# 1) 根路径 → /agent
curl -sI http://localhost:<port>/ | head -3
# 预期: HTTP 200 (Vite SPA index.html)
# 2) Agent 页能拿到关键 API 调用 (可选)
curl -s http://localhost:<port>/api/system | head -c 200
# 预期: JSON,含 cwd/version 等字段

# 关闭 dev server
kill $DEV_PID 2>/dev/null || true
```

完整手动验证(浏览器)按 spec §测试:
1. 浏览器打开 `http://localhost:<port>/` → 进入 Agent 页(空 session 列表触发 `createNewSession`)
2. 浏览器打开 `http://localhost:<port>/foo/bar` → 跳转到 Agent 页
3. 浏览器打开 `http://localhost:<port>/login` → 仍进入登录页
4. Sider 菜单点击 "Agent" → 高亮 `/agent`,正常加载

- [ ] **Step 7: 提交**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/router.tsx
git status --short packages/zai/src/web/src/router.tsx
# 预期: M packages/zai/src/web/src/router.tsx (单文件)

git -c commit.gpgsign=false commit -m "$(cat <<'EOF'
feat(zai): default web root to agent page

flip router.tsx root + catch-all Navigate target from /login to /agent.
Sider menu still exposes /login for the occasional OAuth flow; /agent
already exists and mounts the existing <Agent /> component.
EOF
)"
```

---

## Self-Review Checklist

- **Spec coverage:**
  - 目标 1(根路径默认进 Agent)→ Task 1 Step 2 ✓
  - 目标 2(`*` 兜底进 Agent)→ Task 1 Step 3 ✓
  - 目标 3(不破坏其他路径直访)→ Step 4 grep 校验 + 不动其他 `<Route>` 行 ✓
  - 测试策略(spec: 不新增单元测试,手验)→ Step 6 ✓
- **Placeholder scan:** 无 "TBD / TODO / 后续补" 等占位
- **Type consistency:** 仅修改两处 `to=` 字符串,无类型/签名变化
- **Scope check:** 单文件双行,1 任务 1 commit,与 spec "极低风险" 一致
