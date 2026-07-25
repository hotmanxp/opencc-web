import type { CSSProperties } from "react";

/**
 * 状态栏右侧工具栏图标按钮共享样式 — 让 share / settings / repair / 图片上传 /
 * 对话信息 / 折叠 transcript / 分屏切换 / model / mode 等所有 icon-only 按钮视觉
 * 风格保持一致:
 *
 *   - 全部用 antd 默认 outline 按钮(`type="default"`): 圆角、淡边框, 与截图风格
 *     对齐.
 *   - 固定 32×32, 圆角 8, 保证一排按钮大小一致.
 *   - 默认色 `rgba(255,255,255,0.45)`, 与状态行普通文字一致.
 *   - 激活态(share 打开 / 分屏展开)在消费侧覆盖 `color` + `borderColor` 字段为
 *     品牌色 `#ff6600`, 图标和边框同色.
 *   - `flexShrink:0` 防止窄屏下被 spacer 挤到 0 宽.
 *
 * 调整这一组按钮的视觉时, 改这里一处即可.
 */
export const toolbarIconButtonStyle: CSSProperties = {
  width: 32,
  height: 32,
  color: "rgba(255,255,255,0.45)",
  borderRadius: 8,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

/** 激活态共用色(share 打开 / 分屏展开时), 图标和边框都用此色. */
export const TOOLBAR_ACTIVE_COLOR = "#ff6600";
