# 移动端会话信息弹框居中完整显示

**日期**: 2026-07-26
**作者**: brainstorming 流程产出
**状态**: 设计待实现

## 背景

`ConversationInfoButton` 在工具栏最右端用 antd `Popover`(`placement="topRight"`)展示当前会话元信息: Session ID / 标题 / 首条消息时间 / 最后更新 / 对话轮次 / 消息数 / 状态。卡片 `width: 360px`。

移动端(屏幕宽度 < 768px,见 `useIsMobile.ts:15` 的 `MOBILE_BREAKPOINT = 768`)问题:
- `placement="topRight"` 锚定到工具栏最右端的 [i] 按钮。屏幕 < 768px 时按钮几乎贴近右边缘,导致 Popover 在视口右侧溢出/裁切,Session ID 等长字符串首尾被遮。
- 卡片固定 360px,扣掉 32px 安全边距后仍超出 iPhone SE (375px) 等窄屏。
- 用户的预期: 移动端看到的是"居中、完整"的弹框,而不是锚定在右上角的裁切窗口。

## 目标

`ConversationInfoButton` 在移动端(< 768px)以**居中、完整**的方式展示会话信息卡片,关闭行为保留(mask 点击关闭 + ESC)。桌面端行为零变化。

## 非目标

- 不动 `ConversationInfoCard.tsx` 的渲染内容与字段。
- 不动 `useConversationInfo.ts` 的数据来源与计算。
- 不重构为通用 `<ConversationInfoDialog>` 抽象(单点使用,YAGNI)。
- 不动 `MobileSessionDrawer`、其他 Popover/Modal。

## 设计

### 1. 改动点

单文件改动: `packages/zai/src/web/src/components/ConversationInfoButton.tsx`。

新增依赖:
- `useAppStore` 读 `isMobile`(已在 `useIsMobile` 顶层挂过,通过 media query 同步到 store)。
- antd `Modal`(已经在 `SettingsDrawer.test.tsx` 等多处使用,无新依赖)。

### 2. 渲染分支

```
isMobile === true  → <Modal centered width="min(360px, calc(100vw - 32px))" ...>
isMobile === false → <Popover placement="topRight" ...>  (现状)
isMobile === undefined (初次渲染) → 回退 Popover, 避免桌面初始态闪
```

### 3. Modal 配置

| 属性 | 值 | 理由 |
|---|---|---|
| `open` | 受控 `open` 状态 | trigger Button `onClick` 翻转 |
| `onCancel` | `setOpen(false)` | ESC + mask 点击 |
| `centered` | `true` | 视口居中 |
| `width` | `'min(360px, calc(100vw - 32px))'` | 桌面宽度不变,窄屏自适应 |
| `footer` | `null` | 无确认/取消按钮 |
| `maskClosable` | `true` | 点遮罩关闭 |
| `destroyOnClose` | `true` | 关闭后销毁,下次打开重新挂载(避免 Description 内部状态遗留) |
| `title` | `'会话信息'` | 显式标题,移动端可读性 |

> **实现备注**: 实施时 antd 5.22+ 把 `destroyOnClose` 标为 `@deprecated`,实际代码用其非弃用别名 `destroyOnHidden`(语义完全一致,在 `node_modules/antd/es/modal/interface.d.ts:47` 仍可见)。提交时若用 `destroyOnHidden` 视为等价实现。

### 4. 共用内容

Modal 与 Popover 都把 `<ConversationInfoCard info={info} />` 作为 body,外层 `<div onClick={(e) => e.stopPropagation()}>` 保留现有防冒泡语义。`useConversationInfo()` 仍只调用一次。

### 5. Trigger Button

桌面沿用 `<Button icon={<InfoCircleOutlined />} style={toolbarIconButtonStyle} />`;移动端同一按钮(同一 toolbar 入口),`onClick` 切换本地 `open` state(替代 Popover 自带 `trigger="click"`)。

新增 `data-testid="conversation-info-trigger"`,移动 Modal 加 `data-testid="mobile-conversation-info-modal"`。

## 数据流

```
ConversationInfoButton (mount)
  ├─ useConversationInfo() → info (快照)
  └─ useAppStore((s) => s.isMobile) → 分支
       ├─ isMobile=true  → <Modal open={open} ...>{<ConversationInfoCard info={info}/>}</Modal>
       └─ isMobile=false → <Popover ...>{<ConversationInfoCard info={info}/>}</Popover>
```

无新增 store 字段、无新增事件。

## 错误处理 / 边界

- `isMobile === undefined`: 首次渲染(SSR / hydration 边界)回退 Popover。后续 effect 同步后会自动重渲染到 Modal。
- `info.sessionId === null`: `ConversationInfoCard` 已处理,返回"暂无活跃会话"占位文案;Modal 内同样成立。
- 横竖屏切换: media query 自动更新 `isMobile`,组件重渲染,弹框状态由用户主动控制(切到竖屏不会自动重开)。

## 测试

新增 `packages/zai/src/web/src/components/ConversationInfoButton.test.tsx`(vitest + RTL + antd ConfigProvider 包装,与 `SettingsDrawer.test.tsx` 风格一致):

| 用例 | 断言 |
|---|---|
| `renders Popover on desktop` | `isMobile=false` → 点击 trigger 后 `getByText('Session ID')` 可见 |
| `renders Modal on mobile` | `isMobile=true` → 挂载即看到 Modal 与卡片内容 |
| `mobile mask closes Modal` | `isMobile=true` → 触发 Modal `onCancel` 后卡片消失 |
| `card content parity` | 两分支都渲染 `info.title`、`info.turnCount`、`info.messageCount` 等关键字段 |
| `trigger toggle` | 移动端连续两次点击 trigger,Modal `open` 状态正确翻转 |

Mock 边界:
- `vi.mock('../hooks/useConversationInfo.js', ...)` 返回固定 `info` fixture。
- `vi.mock('../store/useAppStore.js', ...)` 暴露可控 `isMobile`。

不动的测试:
- `useConversationInfo.ts` / `ConversationInfoCard.tsx` 现有单测保持原状。

## 风险与权衡

- **antd Modal body 滚动锁定**: 默认行为,关闭后还原,无需额外配置。
- **isMobile 闪**: 桌面首次加载 `isMobile=undefined` 走 Popover,随后切到真实分支;视觉上不可察觉(用户没机会在 1ms 内开弹框)。
- **Modal vs Popover 行为差异**: Popover 点击 trigger 区域外自动关闭;Modal 走 mask/ESC。已确认用户接受"mask 点击可关闭"(见 brainstorming 第 2 问)。

## 验证清单

- [ ] `pnpm -C packages/zai test src/web/src/components/ConversationInfoButton` 全绿
- [ ] `pnpm -C packages/zai typecheck` 无错
- [ ] Chrome DevTools 设备模拟 iPhone SE / Pixel 5 / iPad mini: 点击 [i] 看到居中卡片,Session ID 不被裁切
- [ ] 桌面端 (1280×800) 截图对比: Popover 行为无回归

## 后续(不在本 spec)

- 多个信息弹框(任务详情、命令历史等)若也需移动端居中,届时抽 `<CenteredDialog>` 通用抽象。
- 把 `ConversationInfoCard` 内的 `width: 360px` 改为响应式(`min(360px, calc(100vw - 32px))`)以适应横屏窄边。