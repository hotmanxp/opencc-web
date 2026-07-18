# Thinking 灯泡发光脉冲动画

**状态：** 设计稿
**日期：** 2026-07-18
**作用域：** `packages/zai/src/web/src/pages/Agent.tsx` `ThinkingBlock` 组件

## 背景

`ThinkingBlock`（`packages/zai/src/web/src/pages/Agent.tsx:308`）渲染紫色"思考" pill + 灯泡图标 `<BulbOutlined>`，用于在 Agent 对话视图展示模型思考内容。

**问题：** 模型真正处于 thinking 流式阶段时（`status === "streaming"`），灯泡完全静止，与"正在思考"的视觉语义不符。已存在的状态栏 `SPINNER[spinnerIdx]` 旋转文字与 `StreamingMarkdown` 末尾的 `zai-blink` 光标闪烁都在响应 streaming，但 ThinkingBlock 没有任何反馈。

## 目标

让 ThinkingBlock 的灯泡图标在模型 thinking 流式期间做"发光脉冲"动画（颜色循环渐变），传达"模型正在思考"的状态；流式结束或历史回放时恢复静态。

## 非目标

- 不改 ThinkingBlock 的展开/折叠交互
- 不改 pill 背景色（保持主题紫 `#722ed1`）
- 不改"思考"文字样式
- 不改 MessageBubble 或外层 MessageBubble 接口
- 不新增依赖

## 设计

### 接口扩展

`ThinkingBlock` 函数签名加 `streaming?: boolean` 入参：

```tsx
function ThinkingBlock({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
})
```

`streaming` 可选，保持向后兼容：未传时灯泡静态，行为与改动前完全一致。

### 透传路径

| 层级 | 位置 | 改动 |
|------|------|------|
| 父组件计算 streaming | `Agent.tsx:1817` | 已存在 `streaming = status === "streaming" && idx === messages.length - 1` |
| MessageBubble 接收 | `Agent.tsx:717-723` | 已存在 `streaming: boolean` |
| MessageBubble 透传 | `Agent.tsx:727` | `<ThinkingBlock ... />` 增加 `streaming={streaming}` |
| ThinkingBlock 使用 | `Agent.tsx:308` | 接收 prop 并应用到动画 |

四处都是布尔传递，不新增任何状态管理。

### 动画实现

ThinkingBlock 内部在返回 JSX 的根层用 React Fragment 包：

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
      <Collapse ... items={[{
        key: "thinking",
        label: (
          <div ...>
            <span style={{ /* 紫色 pill 样式保持不变 */ }}>
              <BulbOutlined className="zai-thinking-bulb" style={{ fontSize: 11 }} />
              思考
            </span>
            ...
          </div>
        ),
        ...
      }]} />
    </div>
  </>
);
```

### 关键决策

1. **行内 `<style>` 局部注入**：与项目现有 `zai-blink`（`index.css:88`）的声明方式分离，避免污染全局。仅当 `streaming=true` 才挂载，DOM 上自动随 streaming 切换插入/移除。
2. **改 `fill` 而非 `color`**：AntD `BulbOutlined` 的 SVG `<path>` 在源码里硬编码 `fill="#cacaca"`（base64 数据），CSS `color` 属性**不会**传导到 path 的 fill，必须用 `.zai-thinking-bulb svg path { animation: ... }` 把 keyframe 直接挂到 path 上，并在 keyframe 里改 `fill`。这是关键架构决策 — 用 `color` 动画是无效的（已通过截图对比验证）。
3. **`prefers-reduced-motion` 降级**：在同一个 `<style>` 内用嵌套 `@media` 让 keyframes 在 reduce 模式下 `fill: #cacaca`（与默认静态色一致），**动画与颜色同时关闭**。
4. **className 始终挂载**：`zai-thinking-bulb` className 无论 streaming 与否都存在，但 `<style>` 块仅 streaming 时挂载。`<style>` 不挂载时 CSS 选择器无匹配，灯泡回到默认 #cacaca 灰色，无残留样式。
5. **颜色范围**：灯泡 path 的 fill 在 `#f7d774 ↔ #ffe999` 之间循环（暗黄 ↔ 亮黄）。pill 背景、`思考` 文字、左侧紫罗兰边条全部不动。
6. **周期 1.4s `ease-in-out`**：比 `StreamingMarkdown` 末尾 `zai-blink` 的 1s `steps(1)` 慢半拍，避免与流式光标节奏重叠；`ease-in-out` 让脉冲更柔和，符合"思考"沉静语义。
7. **不变更 index.css**：不引入全局 keyframe，遵循项目模块化约定。

## 边界情况与行为

| 场景 | 行为 |
|------|------|
| `text=""`（falsy） | 现有 `if (!text) return null` 提前返回，不渲染灯泡 |
| 历史回放（非流式 / 未传 streaming） | 灯泡完全静态，与改动前一致 |
| 流式 → idle 切换 | `<style>` 卸载，灯泡回到白色，无残留样式 |
| 流式 → aborted / error 切换 | 同上，立即停动画 |
| `prefers-reduced-motion: reduce` | 动画不播放，颜色 inherit（白色），静态 |
| 用户开 devtools 暂停动画 | CSS 动画原生支持，无额外处理 |

## 测试

**不新增测试。** 动画是纯装饰性 CSS 变化，且现有 ThinkingBlock 也没有覆盖测试。添加 RTL 测试需要 mock 动画 API（jsdom 对 `@keyframes` 支持有限），性价比低。

## 验收标准

1. 发送任意消息，等模型开始 streaming
2. 观察 ThinkingBlock 折叠态：紫色 pill 上的灯泡颜色在 `#f7d774 ↔ #ffe999` 间柔和循环，周期 1.4s
3. 流式结束后灯泡恢复白色静态
4. 历史回放（点击过去 session）灯泡不闪烁
5. 浏览器开"减少动效"偏好后，灯泡完全静止、颜色为白色
6. 折叠/展开交互未受影响；pill 背景与"思考"文字未受影响

## 改动清单

| 文件 | 行 | 改动 |
|------|-----|------|
| `packages/zai/src/web/src/pages/Agent.tsx` | 308 | `ThinkingBlock` 签名加 `streaming?: boolean` |
| `packages/zai/src/web/src/pages/Agent.tsx` | 308 内部 | 返回 JSX 用 Fragment 包裹，新增条件 `<style>` 与 `<BulbOutlined>` 加 `className="zai-thinking-bulb"`（CSS 选择器把 animation 挂到 svg path 上）|
| `packages/zai/src/web/src/pages/Agent.tsx` | 727 | `<ThinkingBlock>` 增加 `streaming={streaming}` |

`index.css`、`MessageBubble` 外层结构、其他组件均不修改。