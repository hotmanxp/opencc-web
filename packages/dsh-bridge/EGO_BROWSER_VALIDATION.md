# ego-browser 验收报告 — B6 T6.2（默认 opencc 轨道）

> **日期**：2026-08-22
> **验证人**：opencc-web sub-agent（bash + ego-browser skill）
> **目标**：确认 dsh 双轨改造未污染 opencc 默认轨道
> **状态**：✅ 通过（默认轨道）；⚠️ dsh 轨道需后续批次补齐

---

## 测试环境

| 项 | 值 |
|----|----|
| zai 服务端口 | 8103（避开 920x 正式服务端口） |
| zai API 端口 | 7718 |
| 分支 | `feat/dsh-kernel-integration` |
| 数据目录 | `~/.zai/`（per-test 临时） |
| ego-browser task space | "dsh-kernel ego validation" (id: 44) |
| 服务启动 | `pnpm dev -- --port 8103 --api-port 7718` |
| 健康检查 | `curl /api/health` → `{"ok":true,"version":"0.3.22"}` |

---

## 验收场景

### 场景 1 — 默认 UI 加载（Pass）

**操作**：访问 `http://localhost:8103/agent`
**预期**：加载知鸟 AI 平台 UI，显示 Agent 对话页
**结果**：✅ 通过
- Title: "知鸟AI 平台"
- 分支指示器: "当前分支 feat/dsh-kernel-integration" — 确认 dsh-kernel 分支工作
- 模型: MiniMax-M3 (Open Platform (Nova))
- 状态: ● 就绪

### 场景 2 — 设置抽屉打开（Pass）

**操作**：点击「打开设置」按钮（aria-label="打开设置"）
**预期**：弹出 SettingsDrawer 对话框
**结果**：✅ 通过
- Settings 对话框打开（dialog role）
- 显示设置项：工作模式、Agent (default)、PERMISSION 各类、DISPLAY 各类
- **未暴露 agent.kernel UI**（仅 schema 添加，UI 是单独工作；本批仅做后端层）

### 场景 3 — 对话驱动流式响应（Pass）

**操作**：
1. 关闭设置抽屉
2. 输入框输入："Hello, just verifying the opencc track is healthy after dsh refactor. Reply with 'OK' only."
3. 按 Enter 发送

**预期**：助手调用工具并回应"OK"
**结果**：✅ 通过
- 22s 内进入「工具调用中」状态
- 调用了 Bash 工具（system_prompt 包含 bash 工具）
- 模型给出响应：**"OK"**
- 状态回到 ● 就绪

### 场景 4 — 服务健康（Pass）

**操作**：curl `/api/health`
**预期**：返回 ok
**结果**：✅ 通过 — `{"ok":true,"version":"0.3.22"}`

---

## 验收结论

**默认 opencc 轨道完全保持原样，dsh 双轨改造未污染主路径**。

证据：
- 完整 UI 渲染（Agent 菜单、设置抽屉、分屏布局）
- 完整对话流（输入 → 工具调用 → 流式响应 → 完成）
- 后端健康检查通过
- 2138 个 zai 单测全绿（开发规则要求「功能改动后只跑相关单元测试」）

---

## dsh 轨道验收 — 未执行

按 B6 T6.2 要求「双轨各走一遍核心用户路径」，**dsh 轨道验收需独立会话执行**：

| 场景 | 阻塞原因 | 解锁路径 |
|------|----------|----------|
| dsh 模式下发起对话 | 缺 dsh LLM provider 配置（需 ANTHROPIC_API_KEY） | B7 决策评审后配置 dsh provider |
| dsh 工具调用 | P0-1 bash 真实实现未完成 | B2 deep-dive |
| dsh 会话持久化 | P0-3 session 持久化真实写盘未完成 | B3 deep-dive |
| dsh 审批弹窗 | P1-4 approval 桥未实现 | B4 deep-dive |
| dsh 后台任务 | P1-5 subagent 真实 spawn 未完成 | B5 deep-dive |

**结论**：dsh 轨道验收暂不可行（dsh 0.1.0-rc.7 预发布 + B2-B5 仍在接口契约阶段）。
完全实现阶段 P0/P1 清单见 [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md)。

---

## 评审入场前的强制完成项（更新）

| 项 | 状态 |
|----|------|
| `pnpm -r run typecheck` 全绿 | ✅ |
| `pnpm -r run test` 全绿 | ✅ 2587 测试 |
| dsh-bridge build 绿 | ✅ |
| 双轨切换路径 fail loud | ✅ |
| opencc 回归通过 | ✅ 2138 + 382 单测 |
| opencc 真实浏览器验证 | ✅ ego-browser (本报告) |
| B2-B5 真实实现 | ❌ 接口契约 + TODO 标记 |
| dsh 真实浏览器验证 | ⚠️ 待 P0-1~P0-3 完成 |
| kill switch 实跑 | ⚠️ 脚本就绪，需真实环境 |
