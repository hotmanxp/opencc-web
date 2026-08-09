export const CODE_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"

export const STYLE = {
  preBase: {
    fontSize: 12,
    margin: "4px 0 0 0",
    padding: "8px 10px",
    borderRadius: 4,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
    fontFamily: CODE_FONT_FAMILY,
  },
  preMuted: { background: "var(--bg-faint-02)" },
  // 语义色用 CSS 变量, light 主题下 light 浅色背景 + dark 边框形成稳定对比;
  // dark 主题下 AntD 算法将 -bg 转换成深色, 边框保留饱和色. 消除"亮色下偏黄"的视觉问题.
  preSuccess: {
    background: "var(--success-bg, rgba(82,196,26,0.06))",
    borderLeft: "2px solid var(--success, #52c41a)",
    maxHeight: 360,
    overflow: "auto" as const,
  },
  preError: {
    background: "var(--error-bg, rgba(255,77,79,0.06))",
    borderLeft: "2px solid var(--error, #ff4d4f)",
    color: "#cf1322",
    maxHeight: 360,
    overflow: "auto" as const,
  },
  preWarn: {
    background: "var(--warning-bg, rgba(250,173,20,0.06))",
    borderLeft: "2px solid var(--warning, #faad14)",
    maxHeight: 360,
    overflow: "auto" as const,
  },
  label: {
    fontSize: 11,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    marginTop: 8,
    display: "block" as const,
  },
} as const
