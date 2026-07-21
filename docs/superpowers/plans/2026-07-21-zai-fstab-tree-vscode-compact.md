# FsTab 文件树紧凑化(VSCode 风格)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `packages/zai/src/web/src/components/splitPane/FsTab.tsx` 左侧 antd `<Tree>` 视觉紧凑化为 VSCode Explorer 风格(行高 22px、缩进 8px、chevron 10px、icon 12px)。

**Architecture:** 纯 CSS 覆盖方案。不动 JSX,在 `packages/zai/src/web/src/index.css` 增加作用域限定在 `[data-testid="fs-tree"]` 下的 antd class 覆盖规则。antd `<Tree>` 内部已经渲染出 `.ant-tree-switcher` / `.ant-tree-indent-unit` / `.ant-tree-node-content-wrapper` / `.ant-tree-icon__customize` 等稳定 class,我们只覆盖这些 class 的尺寸。

**Tech Stack:** CSS3、antd@5.22 (`<Tree>` → `rc-tree` → `rc-virtual-list`)、React 18、TypeScript 5、vitest (测试)、`@testing-library/react`。

## Global Constraints

- **测试运行器**:`pnpm --filter @zn-ai/zai test` 跑 `vitest run`,匹配 `packages/zai/src/**/*.test.{ts,tsx}`。
- **Frontend 测试环境**:`@vitest-environment happy-dom` + `@testing-library/react`。
- **包名**:`@zn-ai/zai`。
- **不引入新依赖**:只用现有 antd class hooks 与 CSS。
- **作用域**:所有新规则必须以 `[data-testid="fs-tree"]` 为根,避免污染其他位置(若有)的 antd `<Tree>`。
- **行高**:22px。**缩进**:8px/级。**chevron**:10px。**icon**:12px。
- **GitTab 完全不动**(用户决策)。
- **JSX 完全不动**(仅样式改动)。

---

## File Structure

### 修改

| 路径 | 改动 |
|------|------|
| `packages/zai/src/web/src/index.css` | 在现有 `.ant-tree .ant-tree-node-content-wrapper:hover { ... }` 之后(line 79 之后)插入 ~25 行新 CSS。 |

### 不创建/不修改

- 不动任何 `.tsx` 文件
- 不动 `FsTab.tsx` / `FsTab.test.tsx` / `GitTab.tsx`
- 不动 package.json / package-lock

---

## Task 1: 应用 CSS 覆盖 + 回归 FsTab 测试 + 视觉验证

**Files:**
- Modify: `packages/zai/src/web/src/index.css:79` (immediately after the closing brace of `.ant-tree .ant-tree-node-content-wrapper:hover`)
- No test file changes — existing `FsTab.test.tsx` 8 cases must continue to pass

**Interfaces:**
- Consumes: 现有 `FsTab.tsx:185` 已经设了 `data-testid="fs-tree"` 属性,新 CSS 用它作作用域根。
- Produces: 浏览器渲染时,`.ant-tree` 在 `[data-testid="fs-tree"]` 子树里以 22px 行高、8px indent、10px chevron、12px icon 渲染。

### Step 1: Read current index.css end of `.ant-tree` block

```bash
sed -n '75,82p' packages/zai/src/web/src/index.css
```

预期输出:
```
75  .ant-alert-description { color: var(--text-secondary) !important; }
76
77  .ant-tree { background: transparent !important; color: var(--text-primary) !important; }
78  .ant-tree .ant-tree-node-content-wrapper:hover { background: var(--bg-card-hover) !important; }
79
80  .ant-list-item { border-bottom: 1px solid rgba(255,255,255,0.05) !important; }
```

定位:新代码插入在 line 79 之后(`.ant-tree ...:hover { ... }` 块结束后的空行后)。

### Step 2: Insert CSS block after line 79

读取当前文件 line 数,确认 line 79 是空行(line 78 是 `:hover` 块的结尾 `}`),然后在 line 79 之后插入:

```css
/* FsTab 目录树紧凑化(对齐 VSCode Explorer)
   作用域限定在 data-testid="fs-tree" 子树,不污染其他位置可能出现的 antd <Tree> */
[data-testid="fs-tree"] .ant-tree-node-content-wrapper,
[data-testid="fs-tree"] .ant-tree-switcher {
  height: 22px;
  line-height: 22px;
}

[data-testid="fs-tree"] .ant-tree-switcher {
  width: 16px;
  margin-right: 2px;
}

[data-testid="fs-tree"] .ant-tree-indent-unit { width: 8px; }

[data-testid="fs-tree"] .ant-tree-switcher .ant-tree-switcher-icon,
[data-testid="fs-tree"] .ant-tree-switcher__close,
[data-testid="fs-tree"] .ant-tree-switcher__open {
  font-size: 10px;
  width: 10px;
  height: 10px;
}

[data-testid="fs-tree"] .ant-tree-node-content-wrapper {
  padding: 0 4px;
  border-radius: 3px;
}

[data-testid="fs-tree"] .ant-tree-iconElec,
[data-testid="fs-tree"] .ant-tree-icon__customize {
  font-size: 12px;
  margin-right: 3px;
}

[data-testid="fs-tree"] .ant-tree-node-selected {
  background: rgba(255, 102, 0, 0.18) !important;
}
```

### Step 3: 验证插入位置

```bash
sed -n '77,108p' packages/zai/src/web/src/index.css
```

预期结果:line 77-78 是原有 `.ant-tree` 两行,line 79 是空行,line 80 起是新增的 `/* FsTab 目录树紧凑化 ...` 注释块,直到 `}` 结束。后续接原有的 `.ant-list-item` 规则。

### Step 4: 运行 FsTab 测试回归

```bash
pnpm --filter @zn-ai/zai test -- FsTab
```

预期输出:8 个 case 全部 PASS(包括 `mounts fs-tree as a fixed-height column`、`uses fs-preview-code test-id for .ts files` 等)。CSS 改动不改变 DOM 结构,所有 `expect(tree.style.overflow).toBe('hidden')` 等断言依旧通过。

**若失败**:首先 `cat packages/zai/src/web/src/index.css | grep -n "fs-tree"` 确认 CSS 块插入位置正确;然后 `pnpm --filter @zn-ai/zai test -- FsTab --reporter=verbose` 看具体失败 case。CSS 改动不应让现有断言失败。

### Step 5: 运行全量前端测试确认无外溢

```bash
pnpm --filter @zn-ai/zai test
```

预期输出:全部 suite 通过。作用域 `[data-testid="fs-tree"]` 严格限制,FsTab 是唯一用这个 testid 的组件,其他 suite 不受影响。

### Step 6: 运行 typecheck

```bash
pnpm --filter @zn-ai/zai typecheck
```

预期输出:无 TS 错误。CSS 文件不参与类型检查,通过即可。

### Step 7: Commit

```bash
git add packages/zai/src/web/src/index.css
git commit -m "style(zai): FsTab 文件树紧凑化为 VSCode Explorer 风格"
```

### Step 8: 手工视觉验证(用户执行)

```bash
pnpm --filter @zn-ai/zai dev
```

打开浏览器 → 进入任意会话 → 右侧打开 Files tab(若已折叠)→ 刷新按钮触发一次列表 → 逐级展开 `packages/zai/src/web/src/components/splitPane/`,对照 VSCode Explorer 同目录视觉:

- 行高明显比之前矮(22px vs 原 ~26px)
- 每级缩进显著变窄(8px vs 原 24px)
- 折叠箭头变小
- FolderOutlined / FileOutlined icon 变小
- 选中态橙色高亮仍生效
- 深目录(如 `packages/zai/src/web/src/components/splitPane/`)左右不再撑爆列宽

无视觉问题即为 PASS。

---

## Self-Review

**1. Spec coverage:**
- "22px 行高" → Step 2 `.ant-tree-node-content-wrapper, .ant-tree-switcher { height: 22px; line-height: 22px; }`
- "8px 缩进/级" → Step 2 `.ant-tree-indent-unit { width: 8px; }`
- "10px chevron" → Step 2 `.ant-tree-switcher .ant-tree-switcher-icon, .ant-tree-switcher__close, .ant-tree-switcher__open { font-size: 10px; width: 10px; height: 10px; }`
- "12px icon" → Step 2 `.ant-tree-iconElec, .ant-tree-icon__customize { font-size: 12px; margin-right: 3px; }`
- "作用域限定 fs-tree" → 全部 selector 以 `[data-testid="fs-tree"]` 为根
- "不动 JSX / 不动 GitTab" → 任务清单只列 index.css
- "不引入依赖" → 没有 package.json 改动
- "现有 8 个测试仍 pass" → Step 4 显式验证
- "视觉回归" → Step 8

无 gap。

**2. Placeholder scan:** 无 "TBD"/"TODO"/"类似 Task N"/"添加适当错误处理"。每个步骤都有具体代码或具体命令。

**3. Type consistency:** 不涉及 TS 类型,只有 CSS。`data-testid="fs-tree"` 与 `FsTab.tsx:185` 实际字符串完全一致。
