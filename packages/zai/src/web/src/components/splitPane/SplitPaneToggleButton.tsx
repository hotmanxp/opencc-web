import { Button, Tooltip } from "antd";
import { MenuUnfoldOutlined } from "@ant-design/icons";
import { STORAGE_KEYS, useLocalStorageState } from "./shared.js";
import { toolbarIconButtonStyle, TOOLBAR_ACTIVE_COLOR } from "../toolbarStyles.js";

/**
 * 右侧分屏 toggle 按钮 — 原先内嵌在 AgentInputBox 工具栏里,2026-09-02 起
 * 抽成独立组件:分屏是 /agent 页面(SplitPane)专属能力,Desktop 浮窗、
 * MobileAgent 等复用 AgentConversation 的场景没有分屏,不该显示这个按钮。
 * 由 Agent.tsx 通过 AgentConversation/AgentInputBox 的 toolbarRightSlot
 * 插槽挂载。
 *
 * 数据源 STORAGE_KEYS.open 与 SplitPane + 左侧栏 toggle 共享,任意一处写 →
 * 全局同步(useLocalStorageState 自带 same-tab 'zai-localstorage-sync' 事件)。
 * open 时用品牌色高亮,关闭时与同行其他按钮颜色一致。
 */
export default function SplitPaneToggleButton() {
  const [splitPaneOpen, setSplitPaneOpen] = useLocalStorageState<boolean>(
    STORAGE_KEYS.open,
    false,
  );

  return (
    <Tooltip title="切换右侧分屏" placement="top">
      <Button
        icon={<MenuUnfoldOutlined />}
        data-testid="split-pane-toggle-inputbox"
        aria-pressed={splitPaneOpen}
        onClick={() => setSplitPaneOpen(!splitPaneOpen)}
        style={{
          ...toolbarIconButtonStyle,
          ...(splitPaneOpen && {
            color: TOOLBAR_ACTIVE_COLOR,
            borderColor: TOOLBAR_ACTIVE_COLOR,
          }),
        }}
      />
    </Tooltip>
  );
}
