import * as React from 'react'
import { useEffect, useState } from 'react'

import { type MiniMaxUsageRow } from '../../services/api/minimaxUsage.js'

const RESET_COUNTDOWN_REFRESH_MS = 30_000
const PROGRESS_BAR_WIDTH = 18

type MiniMaxUsageLimitBarProps = {
  label: string
  usedPercent: number
  resetsAt?: string
  extraSubtext?: string
  maxWidth: number
  nowMs: number
}

function formatCountdownDuration(ms: number): string {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60_000))
  const days = Math.floor(totalMinutes / 1_440)
  const hours = Math.floor((totalMinutes % 1_440) / 60)
  const minutes = totalMinutes % 60

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  }

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }

  return `${minutes}m`
}

function formatResetCountdown(
  resetsAt: string | undefined,
  nowMs: number,
): string | undefined {
  if (!resetsAt) return undefined

  const resetMs = Date.parse(resetsAt)
  if (!Number.isFinite(resetMs)) return undefined

  const remainingMs = resetMs - nowMs
  if (remainingMs <= 0) {
    return 'Resetting now'
  }

  return `Resets in ${formatCountdownDuration(remainingMs)}`
}

function MiniMaxUsageLimitBar({
  label,
  usedPercent,
  resetsAt,
  extraSubtext,
  maxWidth,
  nowMs,
}: MiniMaxUsageLimitBarProps): React.ReactNode | null {
  return null;
}

function MiniMaxUsageTextRow({
  label,
  value,
}: Extract<MiniMaxUsageRow, { kind: 'text' }>): React.ReactNode | null {
  return null;
}

export function MiniMaxUsage(): React.ReactNode | null {
  return null;
}
