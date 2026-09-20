import { Button, type ButtonProps } from "antd";
import type { CSSProperties } from "react";

/**
 * 对话区 / 工具栏 icon-only 按钮的统一外壳(线条形)。
 *
 * 视觉:无边框、无常态底色、默认三级灰线条图标,hover 出浅底 + 提亮;激活态
 * (分享面板打开 / 分屏展开等)用品牌色图标 + 极淡品牌底色。与 `ModelPickerToolbarButton`
 * 那类手写 Tailwind 按钮同一观感,替换掉原先 antd 默认 outline 的描边方角按钮。
 *
 * 为什么保留 antd `Button` 而不是换纯 `<button>`:
 * 这些按钮依赖 antd 的 `loading`(转圈并禁用)、`disabled`、`htmlType`(表单内
 * 提交)、`size` 等语义,换纯标签要把这些逐个补回来。改走 `type="text"` 变体即可
 * —— 该变体本身就是「透明底 + 无边框 + hover 底色」。
 *
 * 为什么要用 Tailwind 的 `!` 变体压颜色:
 * antd 的 cssinjs 选择器(如 `.ant-btn-variant-text:not(:disabled):hover`)特异性
 * 远高于普通工具类,不加 `!` 会被盖掉。注意底色**不**加 `!` —— 常态/hover 底色
 * 交给 text 变体自己处理,只有激活态的底色才需要压过去(并同时给 hover 一份,
 * 否则 hover 时会被变体底色顶掉)。
 *
 * 尺寸 / 圆角走内联 style:这两项 antd 不按状态切换,内联优先级稳定且不参与
 * 与 cssinjs 的对抗。
 *
 * `size="small"`:不注入几何尺寸,交给 antd 的小号尺寸与调用方自己的定位类
 * (如 Agent 左栏那排 `absolute w-7 h-7`),只统一色调 —— 否则内联 32×32 会把
 * 调用方的定位覆盖掉。
 */

const ICON_BUTTON_CLASS =
  "!text-[var(--text-tertiary)] hover:!text-[var(--text-secondary)]";

const ICON_BUTTON_ACTIVE_CLASS =
  "!text-[var(--accent-start)] hover:!text-[var(--accent-start)] !bg-[rgba(249,115,22,0.14)] hover:!bg-[rgba(249,115,22,0.14)]";

const ICON_BUTTON_SIZE: CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 8,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

export interface IconButtonProps extends Omit<ButtonProps, "type" | "icon"> {
  icon: ButtonProps["icon"];
  /** 激活态(面板打开 / 分屏展开 / 本项被选中):品牌色图标 + 淡品牌底。 */
  active?: boolean;
}

export default function IconButton({
  icon,
  active = false,
  size,
  className,
  style,
  ...rest
}: IconButtonProps) {
  const cls = [ICON_BUTTON_CLASS, active ? ICON_BUTTON_ACTIVE_CLASS : "", className]
    .filter(Boolean)
    .join(" ");
  return (
    <Button
      type="text"
      size={size}
      icon={icon}
      className={cls}
      style={size === "small" ? style : { ...ICON_BUTTON_SIZE, ...style }}
      {...rest}
    />
  );
}