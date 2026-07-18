# ThinkingBlock 灯泡发光脉冲动画 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `ThinkingBlock` 折叠态的紫色"思考" pill 上的灯泡图标上加发光脉冲动画，模型流式思考期间循环 `#f7d774 ↔ #ffe999`，流式结束或历史回放时恢复白色静态。

**Architecture:** 在 `ThinkingBlock` 函数签名增加可选 `streaming?: boolean` prop。父组件 `MessageBubble` 透传 `streaming`（其在 `Agent.tsx:1817` 已计算）。`streaming=true` 时，组件用 React Fragment 包裹根层返回，条件挂载一段行内 `<style>`（声明 `@keyframes zai-think-glow` + `prefers-reduced-motion` 降级），并给 `<BulbOutlined>` 的行内 style 加 `animation`；`streaming=false` 或未传时不挂 `<style>`、不加 animation，行为与现状完全一致。

**Tech Stack:** React 18、TypeScript、Ant Design (`BulbOutlined` 来自 `@ant-design/icons`)、行内 CSS keyframes。

**Spec:** `docs/superpowers/specs/2026-07-18-thinking-bulb-glow-animation-design.md` (commit `a1c5ada`)

## Global Constraints

- 不修改 `packages/zai/src/web/src/index.css`（动画样式仅通过行内 `<style>` 注入）
- 不新增测试
- 不新增依赖
- 不改 pill 背景色（保持主题紫 `#722ed1`）、不改"思考"文字样式、不改左侧紫罗兰边条
- `streaming` prop 可选，未传时灯泡静态（向后兼容历史回放与已有调用点）

---

## 文件改动一览

| 文件 | 行 | 改动性质 |
|------|-----|---------|
| `packages/zai/src/web/src/pages/Agent.tsx` | 308 | `ThinkingBlock` 函数签名扩展，加 `streaming?: boolean` 入参 |
| `packages/zai/src/web/src/pages/Agent.tsx` | 308 内部 | 返回 JSX 用 Fragment 包裹，新增条件 `<style>` 与 `<BulbOutlined>` 动态 `animation` 样式 |
| `packages/zai/src/web/src/pages/Agent.tsx` | 747, 958 | 两处 `<ThinkingBlock>` 调用都透传 `streaming={streaming}`（v3 修复补 958：流式 thinking_delta 路径，**这是真正"正在思考"的渲染点**）|

不创建任何新文件。

---

## Task 1: 接入 streaming prop 与动画样式

**Files:**
- Modify: `packages/zai/src/web/src/pages/Agent.tsx:308`（ThinkingBlock 函数签名与实现）
- Modify: `packages/zai/src/web/src/pages/Agent.tsx:727`（MessageBubble 内 ThinkingBlock 调用点）

**Interfaces:**
- Consumes: 现有 `MessageBubble` 已接收 `streaming: boolean`（`Agent.tsx:717-723`），并由 `Agent.tsx:1817` 计算
- Produces: `ThinkingBlock({ text: string; streaming?: boolean })` 扩展后的 React 组件；新 keyframe `zai-think-glow`

### 改动 1：扩展 ThinkingBlock 函数签名

打开 `packages/zai/src/web/src/pages/Agent.tsx`，定位到 308 行附近的 `function ThinkingBlock({ text }: { text: string }) {`，替换为：

```tsx
function ThinkingBlock({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}) {
```

### 改动 2：将 ThinkingBlock 返回 JSX 用 Fragment 包裹并新增条件 `<style>`

在同一函数内，把当前的 `return ( <div ...>...</div> );` 整体替换为：

```tsx
return (
  <>
    {streaming && (
      <style>{`
        @keyframes zai-think-glow {
          0%, 100% { fill: #f7d774; }
          50%      { fill: #ffe999; }
        }
        .zai-thinking-bulb svg path {
          animation: zai-think-glow 1.4s ease-in-out infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes zai-think-glow { 0%, 100% { fill: #cacaca; } }
        }
      `}</style>
    )}
    <div style={{ marginBottom: 8, maxWidth: "100%" }}>
      <Collapse
        size="small"
        ghost
        bordered={false}
        activeKey={active ? ["thinking"] : []}
        onChange={(keys) =>
          setActive((Array.isArray(keys) ? keys : [keys]).includes("thinking"))
        }
        expandIcon={() => null}
        items={[
          {
            key: "thinking",
            label: (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  minWidth: 0,
                  flex: 1,
                  overflow: "hidden",
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 2,
                    padding: "1px 6px",
                    borderRadius: 10,
                    background: THINKING_ACCENT,
                    color: "#fff",
                    fontSize: 11,
                    fontWeight: 600,
                    lineHeight: 1.6,
                    flexShrink: 0,
                  }}
                >
                  <BulbOutlined
                    className="zai-thinking-bulb"
                    style={{ fontSize: 11 }}
                  />
                  思考
                </span>
                <span
                  style={{
                    fontSize: 13,
                    color: "rgba(255,255,255,0.55)",
                    display: "inline-flex",
                    alignItems: "center",
                    flexShrink: 0,
                    lineHeight: 1.6,
                  }}
                >
                  {active ? <CaretDownOutlined /> : <CaretRightOutlined />}
                </span>
                <span
                  style={{
                    fontSize: 12,
                    color: "rgba(0,0,0,0.45)",
                    fontStyle: "italic",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flex: 1,
                    minWidth: 0,
                  }}
                  title={firstLine}
                >
                  {preview}
                </span>
              </div>
            ),
            children: (
              <div
                style={{
                  fontSize: 12,
                  padding: "10px 12px",
                  background: THINKING_BG,
                  borderLeft: `3px solid ${THINKING_ACCENT}`,
                  borderRadius: 4,
                  color: "rgba(255,255,255,0.78)",
                  fontStyle: "italic",
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  whiteSpace: "pre-wrap",
                  lineHeight: 1.6,
                }}
              >
                {linkifyText(text)}
              </div>
            ),
          },
        ]}
      />
    </div>
  </>
);
```

注：上面把整个组件 return 体完整列出，避免"参考 Task N"式的省略；`active`、`firstLine`、`preview` 等中间变量保持原代码不变。

**关键架构说明**：AntD `BulbOutlined` 的 SVG `<path>` 在源码里硬编码 `fill="#cacaca"`，CSS `color` 属性**不会**传导到 path 的 fill。因此必须在 `<style>` 内通过 `.zai-thinking-bulb svg path { animation: ... }` 选择器把 animation 直接挂到 path 上，并在 keyframe 里改 `fill`。用 `color` 动画是无效的（已通过对比截图验证）。

### 改动 3：MessageBubble 内透传 streaming

定位到 `Agent.tsx:725-731`，把：

```tsx
  if (msg.type === "assistant.thinking") {
    return (
      <ThinkingBlock
        text={(msg.thinking as string) || (msg.text as string) || ""}
      />
    );
  }
```

改为：

```tsx
  if (msg.type === "assistant.thinking") {
    return (
      <ThinkingBlock
        text={(msg.thinking as string) || (msg.text as string) || ""}
        streaming={streaming}
      />
    );
  }
```

### 验证步骤

- [ ] **Step 1: 类型检查**

运行：
```bash
cd /Users/ethan/code/opencc-web/packages/zai && pnpm typecheck
```
预期：0 errors（若未配置 `typecheck` 脚本，则 `pnpm exec tsc --noEmit`）。

- [ ] **Step 2: 现有单测**

运行：
```bash
cd /Users/ethan/code/opencc-web/packages/zai && pnpm test
```
预期：所有现有测试通过（无新增测试，不应有测试失败）。

- [ ] **Step 3: 手动视觉验证（streaming 态）**

启动 dev server：
```bash
cd /Users/ethan/code/opencc-web/packages/zai && pnpm dev
```
打开浏览器访问页面，发送任意消息触发 streaming，观察 ThinkingBlock 折叠态：紫色 pill 上的灯泡颜色在 `#f7d774 ↔ #ffe999` 间柔和循环，周期 1.4s。

- [ ] **Step 4: 手动视觉验证（流式结束）**

等流式结束，灯泡恢复白色静态；pill 背景、`思考` 文字、左侧紫罗兰边条均无变化。

- [ ] **Step 5: 手动视觉验证（历史回放）**

点击任意历史 session，灯泡完全静止、白色，无任何动画残留。

- [ ] **Step 6: 手动视觉验证（prefers-reduced-motion）**

在浏览器 DevTools → Rendering 面板勾选 "Emulate CSS media feature prefers-reduced-motion: reduce"，再次触发 streaming，灯泡保持白色、不循环。

- [ ] **Step 7: 提交**

```bash
git add packages/zai/src/web/src/pages/Agent.tsx
git commit -m "feat(zai-web): animate ThinkingBlock bulb glow during streaming"
```

---

## Self-Review

**1. Spec coverage:**
- ✅ 接口扩展 `streaming?: boolean` → 改动 1
- ✅ 透传路径 MessageBubble → ThinkingBlock → 改动 3
- ✅ 行内 `<style>` + 局部 keyframes → 改动 2
- ✅ 颜色 `#f7d774 ↔ #ffe999`（改 fill 而非 color，因为 AntD BulbOutlined path 硬编码 fill）→ 改动 2
- ✅ 周期 1.4s `ease-in-out` → 改动 2
- ✅ `prefers-reduced-motion` 降级 → 改动 2
- ✅ 不修改 index.css → 全局约束
- ✅ 不新增测试 → 不创建测试文件
- ✅ 折叠/展开、pill 背景、"思考"文字不动 → 改动 2 完整保留原 JSX

**2. Placeholder scan:** 无 TBD/TODO/模糊指令；改动 2 给出完整 return 体（含 `active`、`firstLine`、`preview` 中间变量上下文）；验证步骤全部有具体命令与预期。

**3. Type consistency:** 改动 1 定义 `streaming?: boolean`；改动 3 透传同一类型 `streaming`（来源为 `MessageBubble` 的 `streaming: boolean` 入参，已存在）；改动 2 的 className `zai-thinking-bulb` 与 `<style>` 内 CSS 选择器 `.zai-thinking-bulb svg path` 一致；keyframe 名 `zai-think-glow` 在 `<style>` 内自洽（不再需要 inline animation 字符串）。

**4. 修复记录（v2）:** 第一版提交（commit `2f27d1a`）使用 `<BulbOutlined style={{ animation: ... }}>` + keyframe 改 `color`，但 AntD `BulbOutlined` 的 SVG `<path>` 在源码里硬编码 `fill="#cacaca"`，CSS `color` 属性不会传导到 path 的 fill，导致动画在视觉上完全无效。已在 v2 修复：把 inline `animation` 移除，加 `className="zai-thinking-bulb"`，`<style>` 块内用 `.zai-thinking-bulb svg path { animation: ... }` 选择器直接挂到 path 上，keyframe 改 `fill`。已通过 Chrome DevTools 截图对比验证修复有效。

**5. 修复记录（v3）:** 用户报告"还是没看到动画"。v1/v2 修复只覆盖了 `MessageBubble` 路径（`Agent.tsx:747`），但**真正的流式渲染路径在 `content_block_delta` 分支**（`Agent.tsx:958`）—— 该分支在模型每个 thinking chunk 到达时调用 `<ThinkingBlock text={delta.thinking || ""} />`，**没有传 streaming**，所以 thinking 流的整个生命周期内 `streaming` 永远是 `undefined`，`<style>` 块不挂载，动画不跑。v3 修复：在 958 处调用点也传 `streaming={streaming}`，与 747 处行为对齐。