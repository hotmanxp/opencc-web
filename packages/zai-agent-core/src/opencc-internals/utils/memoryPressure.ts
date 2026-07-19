// @ts-nocheck
/**
 * Memory Pressure Monitor
 *
 * Watches process RSS and triggers cleanup actions at configurable thresholds.
 * Designed to prevent OOM when running multiple OpenCC sessions.
 */

import { logForDebugging } from './debug.js'
import { validateBoundedIntEnvVar } from './envValidation.js'

const MEMORY_PRESSURE_COOLDOWN_DEFAULT_MS = 300_000 // 5 min
const MEMORY_PRESSURE_COOLDOWN_UPPER_MS = 1_800_000 // 30 min cap

export type MemoryPressureLevel = 'normal' | 'elevated' | 'critical'

export interface MemoryPressureConfig {
  elevatedThresholdMB: number
  criticalThresholdMB: number
  checkIntervalMs: number
  perSessionBudgetMB: number
}

const DEFAULT_CONFIG: MemoryPressureConfig = {
  elevatedThresholdMB: 0,
  criticalThresholdMB: 0,
  checkIntervalMs: 30_000,
  perSessionBudgetMB: Number.parseInt(
    process.env.OPENCC_MAX_MEMORY_MB ?? '1536',
    10,
  ),
}

let currentLevel: MemoryPressureLevel = 'normal'
let pressureListeners: Array<(level: MemoryPressureLevel) => void> = []
let monitorInterval: ReturnType<typeof setInterval> | null = null
let compactionRequested = false
// Timestamp of the last `compactionRequested = true` write. Used by the
// monitor to rate-limit re-arming: at most once per cooldown per pressure
// event. Reset to null when the pressure level drops to 'normal' so a
// fresh rise re-arms immediately.
let lastCompactionRequestAtMs: number | null = null

// Resolved at monitor-start time. Env var: OPENCC_MEMORY_PRESSURE_COOLDOWN_MS.
let memoryPressureCooldownMs = MEMORY_PRESSURE_COOLDOWN_DEFAULT_MS
// Resolved at monitor-start time. Read by the (module-level) tick function.
let resolvedElevatedThreshold = 0
let resolvedCriticalThreshold = 0

// Registry of caches that can be pruned under critical memory pressure.
// Caches register themselves at init; the monitor prunes them all when
// RSS crosses the critical threshold.
const prunableCaches: Array<{ clear(): void }> = []

/**
 * Register a cache for automatic pruning under critical memory pressure.
 * Safe to call multiple times with the same cache (idempotent).
 */
export function registerPrunableCache(cache: { clear(): void }): void {
  if (!prunableCaches.includes(cache)) {
    prunableCaches.push(cache)
  }
}

/**
 * Clear all registered prunable caches. Called automatically when memory
 * pressure reaches 'critical'. Also callable directly for manual cache
 * eviction.
 */
export function pruneRegisteredCaches(): void {
  for (const cache of prunableCaches) {
    try {
      cache.clear()
    } catch {
      // best-effort — cache may already be empty
    }
  }
}

export function getMemoryPressureLevel(): MemoryPressureLevel {
  return currentLevel
}

export function onMemoryPressure(
  callback: (level: MemoryPressureLevel) => void,
): () => void {
  pressureListeners.push(callback)
  return () => {
    pressureListeners = pressureListeners.filter(l => l !== callback)
  }
}

export function startMemoryPressureMonitor(
  config: Partial<MemoryPressureConfig> = {},
): void {
  if (monitorInterval) return

  const resolved = { ...DEFAULT_CONFIG, ...config }

  if (resolved.elevatedThresholdMB === 0) {
    resolved.elevatedThresholdMB = Math.floor(
      resolved.perSessionBudgetMB * 0.8,
    )
  }
  if (resolved.criticalThresholdMB === 0) {
    resolved.criticalThresholdMB = Math.floor(
      resolved.perSessionBudgetMB * 0.9,
    )
  }
  resolvedElevatedThreshold = resolved.elevatedThresholdMB
  resolvedCriticalThreshold = resolved.criticalThresholdMB

  logForDebugging(
    `[MemoryPressure] Monitor started: elevated=${resolved.elevatedThresholdMB}MB, critical=${resolved.criticalThresholdMB}MB, interval=${resolved.checkIntervalMs}ms`,
  )

  memoryPressureCooldownMs = validateBoundedIntEnvVar(
    'OPENCC_MEMORY_PRESSURE_COOLDOWN_MS',
    process.env.OPENCC_MEMORY_PRESSURE_COOLDOWN_MS,
    MEMORY_PRESSURE_COOLDOWN_DEFAULT_MS,
    MEMORY_PRESSURE_COOLDOWN_UPPER_MS,
  ).effective

  monitorInterval = setInterval(tick, resolved.checkIntervalMs)

  // Don't keep process alive just for monitoring
  ;(monitorInterval as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.()
}

function tick(): void {
  const rss = process.memoryUsage().rss / 1024 / 1024
  const previousLevel = currentLevel

  if (rss >= resolvedCriticalThreshold) {
    currentLevel = 'critical'
  } else if (rss >= resolvedElevatedThreshold) {
    currentLevel = 'elevated'
  } else {
    currentLevel = 'normal'
  }

  if (currentLevel !== previousLevel) {
    logForDebugging(
      `[MemoryPressure] Level changed: ${previousLevel} -> ${currentLevel} (RSS: ${rss.toFixed(0)}MB)`,
    )
    if (currentLevel === 'critical') {
      logForDebugging('[MemoryPressure] Critical — pruning registered caches')
      pruneRegisteredCaches()
    }
    // Reset cooldown timer ONLY on a return to normal. A downshift within
    // the pressure region (critical→elevated) does not reset — the previous
    // armed request is still the "current" pressure event, and re-arming
    // immediately would defeat the cooldown. A fresh rise (normal→elevated)
    // also doesn't reset here because the timer is already null after the
    // return-to-normal transition.
    if (currentLevel === 'normal') {
      lastCompactionRequestAtMs = null
    }
    for (const listener of pressureListeners) {
      try {
        listener(currentLevel)
      } catch {
        // Don't let listener errors crash the monitor
      }
    }
  }

  // Re-arm compaction request only when pressure is elevated/critical AND
  // the cooldown has elapsed since the last re-arm in the current pressure
  // event. consumeCompactionRequest() is one-shot, so the cooldown is what
  // prevents every-turn re-compaction when RSS stays high.
  if (currentLevel !== 'normal') {
    const now = Date.now()
    if (
      lastCompactionRequestAtMs === null ||
      now - lastCompactionRequestAtMs >= memoryPressureCooldownMs
    ) {
      compactionRequested = true
      lastCompactionRequestAtMs = now
      logForDebugging(
        `[MemoryPressure] Re-arming compaction request (RSS=${rss.toFixed(0)}MB, level=${currentLevel})`,
      )
    }
  }
}

// Test-only hook: invoke the monitor tick body once without waiting for the
// setInterval to fire. Used by src/utils/memoryPressure.test.ts to drive
// the cooldown deterministically.
export function __tickMemoryMonitorForTest(): void {
  tick()
}

/**
 * Returns true if memory pressure triggered a compaction request since last check.
 * Consumes the flag (resets to false).
 */
export function consumeCompactionRequest(): boolean {
  if (compactionRequested) {
    compactionRequested = false
    return true
  }
  return false
}

export function stopMemoryPressureMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval)
    monitorInterval = null
  }
  currentLevel = 'normal'
  pressureListeners = []
}
