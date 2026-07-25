// packages/zai/src/web/src/components/toolRenderers/ansi.tsx
import React, { type ReactNode, type CSSProperties } from 'react'

/* ── 16-color palette (VS Code dark theme) ─────────────── */

const FG_16: string[] = [
  '#000000', // 30 black
  '#cd3131', // 31 red
  '#0dbc79', // 32 green
  '#e5e510', // 33 yellow
  '#2472c8', // 34 blue
  '#bc3fbc', // 35 magenta
  '#11a8cd', // 36 cyan
  '#e5e5e5', // 37 white
  '#666666', // 90 bright black
  '#f14c4c', // 91 bright red
  '#23d18b', // 92 bright green
  '#f5f543', // 93 bright yellow
  '#3b8eea', // 94 bright blue
  '#d670d6', // 95 bright magenta
  '#29b8db', // 96 bright cyan
  '#e5e5e5', // 97 bright white
]

const BG_16: string[] = [
  '#000000', '#7f0000', '#093b00', '#715c00',
  '#00188a', '#68217a', '#004552', '#a5a5a5',
  '#3d3d3d', '#cd3131', '#0dbc79', '#e5e510',
  '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
]

function fgColor(code: number): string | undefined {
  if (code >= 30 && code <= 37) return FG_16[code - 30]
  if (code >= 90 && code <= 97) return FG_16[code - 90 + 8]
  return undefined
}

function bgColor(code: number): string | undefined {
  if (code >= 40 && code <= 47) return BG_16[code - 40]
  if (code >= 100 && code <= 107) return BG_16[code - 100 + 8]
  return undefined
}

/* ── Style state ────────────────────────────────────────── */

interface SgrState {
  color?: string
  backgroundColor?: string
  fontWeight?: number
  opacity?: number
  fontStyle?: string
  textDecoration?: string
}

function isStateEmpty(s: SgrState): boolean {
  return (
    s.color === undefined &&
    s.backgroundColor === undefined &&
    s.fontWeight === undefined &&
    s.opacity === undefined &&
    s.fontStyle === undefined &&
    s.textDecoration === undefined
  )
}

function applySgr(params: number[], state: SgrState): SgrState {
  if (params.length === 0) return {}
  const next = { ...state }
  for (const p of params) {
    switch (p) {
      case 0: return {}
      case 1: next.fontWeight = 700; break
      case 2: next.opacity = 0.6; break
      case 3: next.fontStyle = 'italic'; break
      case 4: next.textDecoration = 'underline'; break
      case 22: delete next.fontWeight; delete next.opacity; break
      case 23: delete next.fontStyle; break
      case 24: delete next.textDecoration; break
      case 39: delete next.color; break
      case 49: delete next.backgroundColor; break
      default: {
        const fg = fgColor(p)
        if (fg !== undefined) { next.color = fg; break }
        const bg = bgColor(p)
        if (bg !== undefined) { next.backgroundColor = bg; break }
        break
      }
    }
  }
  return next
}

/* ── Regex: match CSI and OSC sequences ─────────────────── */

const ANSI_RE = /\x1b(?:\[[0-9;?]*[mABCDHfJK]|\][^\x07]*(?:\x07|\x1b\\))/g

/* ── Public API ─────────────────────────────────────────── */

export function parseAnsi(text: string): ReactNode[] {
  if (!text) return []

  const result: ReactNode[] = []
  let state: SgrState = {}
  let lastIdx = 0
  let key = 0

  for (const match of text.matchAll(ANSI_RE)) {
    const idx = match.index!
    const seq = match[0]

    // Flush plain text before this escape
    if (idx > lastIdx) {
      const chunk = text.slice(lastIdx, idx)
      if (isStateEmpty(state)) {
        result.push(chunk)
      } else {
        result.push(<span key={key++} style={state}>{chunk}</span>)
      }
    }

    // Process the escape sequence
    if (seq[1] === '[' && seq.endsWith('m')) {
      const paramStr = seq.slice(2, -1)
      const params = paramStr === '' ? [0] : paramStr.split(';').map(Number)
      state = applySgr(params, state)
    }
    // Non-SGR CSI or OSC → stripped (no state change)

    lastIdx = idx + seq.length
  }

  // Flush remaining text
  if (lastIdx < text.length) {
    const tail = text.slice(lastIdx)
    if (isStateEmpty(state)) {
      result.push(tail)
    } else {
      result.push(<span key={key++} style={state}>{tail}</span>)
    }
  }

  return result
}

export function AnsiText({ text }: { text: string }): JSX.Element {
  return <>{parseAnsi(text)}</>
}