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
  preMuted: { background: "rgba(0,0,0,0.03)" },
  preSuccess: {
    background: "rgba(82,196,26,0.06)",
    borderLeft: "2px solid #52c41a",
    maxHeight: 360,
    overflow: "auto" as const,
  },
  preError: {
    background: "rgba(255,77,79,0.06)",
    borderLeft: "2px solid #ff4d4f",
    color: "#cf1322",
    maxHeight: 360,
    overflow: "auto" as const,
  },
  preWarn: {
    background: "rgba(250,173,20,0.06)",
    borderLeft: "2px solid #faad14",
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
