# FsTab 文件树紧凑化(对齐 VSCode Explorer)设计

## 背景与目标

`packages/zai/src/web/src/components/splitPane/FsTab.tsx` 左侧目录树使用 antd `<Tree>` 渲染,默认样式较松散:

- `padding: 0 8px` 的 switcher 单元格 + 默认 24px 缩进(每级)
- 26px 行高
- 14-16px chevron 字号
- 16-18px folder/file icon

深度目录(如 `packages/zai/src/web/src/components/splitPane/`)横向占用宽,纵向行数偏多。用户希望样式对齐 **VSCode Explorer**:

- 行高 22px
- 每级缩进 ~8px
- chevron 10px(SVG / `switcher__open` 旋转)
- 文件/文件夹 icon 12px
- 无多层缩进引导线(与 VSCode 浅色主题默认行为一致)
- 选中/悬停态保持当前高亮色但更紧凑

## 范围

### 修改
- `packages/zai/src/web/src/index.css`:增加 `[data-testid="fs-tree"]` 作用域下的 tree 紧凑化规则(约 25 行)
- 不动任何 `.tsx` 文件

### 不动
- `FsTab.tsx` 的 React 逻辑(懒加载 `loadData`、`expandedKeys`、选中态、刷新按钮)
- `GitTab.tsx`(本身是平铺列表,不存在层级问题)
- `FsTab.test.tsx` 8 个 case(仅 CSS 变化,DOM 结构与 `data-testid="fs-tree"` 不变)

## 实现

### 改动 1:`index.css` 追加 block

在现有 `.ant-tree { ... } / .ant-tree .ant-tree-node-content-wrapper:hover { ... }` 之后追加:

```css
/* FsTab 目录树紧凑化(对齐 VSCode Explorer)
   作用域限定,不污染其他位置可能出现的 antd <Tree> */
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

### 改动 2:无

JSX 不动。

## 验证

1. **现有测试**:`packages/zai` 运行 `pnpm test -- FsTab` 应 8 个 case 全部通过(无 DOM/逻辑变化)。
2. **回归断言**:`FsTab.test.tsx` 中 `expect(tree.style.overflow).toBe('hidden')` 与 `minHeight:0` 这些列容器层断言继续有效 — 我们仅在列内部 `.ant-tree-*` 层叠样式。
3. **手工视觉验证**:`pnpm dev` 打开 `FsTab`,展开 `packages/zai/src/web/src/components/splitPane/`,对比 VSCode Explorer 同目录下视觉:
   - 行高 / 列宽明显变紧凑
   - chevron 变小
   - 文件夹/文件 icon 缩小到 12px
   - 选中态橙色高亮仍生效
4. **缩放验证**:浏览器拖窄左侧面板到 ~200px 宽,验证至少能看到 5-6 层级目录名,无横向溢出截断问题。

## 风险

- **antd class 名变化**:依赖 `.ant-tree-switcher` / `.ant-tree-indent-unit` 等 antd@5 稳定类名。若 antd 升大版本需复核,本次不变。
- **作用域用属性选择器**:`[data-testid="fs-tree"]` 已存在(`FsTab.tsx:185`),无新耦合。
- **虚拟滚动**:`<Tree height={treeHeight}>` 内部 `rc-virtual-list` 计算行高基于 DOM,22px 行高让可视区多容纳约 18% 行,符合目标。

## 已知限制

- 不引入缩进层级引导线(树状连接线)— VSCode 浅色主题也默认不画,功能上无收益。
- 不调整 FsTab 右侧文件预览(`fs-preview`)区域,该区域已紧凑(12px 字号、`oneDark` Prism)。
