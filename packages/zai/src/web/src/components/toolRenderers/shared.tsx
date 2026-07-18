import React from "react"
import { Typography } from "antd"
import { STYLE } from "./styles.js"

const { Text } = Typography

export function pick(
  input: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    if (input[k] !== undefined) out[k] = input[k]
  }
  return out
}

export function stringFromOutput(out: unknown): string {
  if (out === undefined) return ""
  if (out === null) return "null"
  if (typeof out === "string") return out
  return JSON.stringify(out, null, 2)
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text type="secondary" style={STYLE.label}>
      {children}
    </Text>
  )
}

export function PreBlock({
  children,
  variant = "muted",
}: {
  children: React.ReactNode
  variant?: "muted" | "success" | "error" | "warn"
}) {
  const variantStyle =
    variant === "success"
      ? STYLE.preSuccess
      : variant === "error"
        ? STYLE.preError
        : variant === "warn"
          ? STYLE.preWarn
          : STYLE.preMuted
  return <pre style={{ ...STYLE.preBase, ...variantStyle }}>{children}</pre>
}

export function DetailsSection({
  summary,
  children,
}: {
  summary: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <details style={{ marginTop: 6 }}>
      <summary
        style={{
          fontSize: 11,
          color: "rgba(0,0,0,0.55)",
          cursor: "pointer",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {summary}
      </summary>
      <PreBlock>{children}</PreBlock>
    </details>
  )
}
