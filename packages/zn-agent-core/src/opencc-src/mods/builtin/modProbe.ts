/**
 * Slot probe — a built-in mod that subscribes to every event and reports which
 * ones the host actually fired.
 *
 * This exists because the failure it guards against cannot be caught by any
 * other means in this codebase. An event name in the table is a constant; a
 * dispatch that never runs is also silence. Unit tests pass either way — the
 * one that registers a handler proves the *chain* works, not that the host
 * ever calls it. So the only honest check is a subscriber that waits.
 *
 * Usage: run a normal session, then `/mod-probe`. Anything listed as never
 * fired has a name and no trigger, whatever the table says about it.
 *
 * The probe never rewrites an event. Every handler records the call and calls
 * `next(e)` unchanged, so having it loaded cannot alter behaviour — which is
 * also why it is safe to ship as an ordinary built-in rather than a test-only
 * hook.
 */

import type { ModContext } from '../engine.js'
import {
  MOD_EVENTS,
  UNAVAILABLE_EVENTS,
  type ModEventName,
} from '../protocol.js'

/** Fired at least once since the mod loaded. */
const fired = new Map<string, number>()

/**
 * Subscribed but never seen. Kept as a set the probe fills at registration
 * time, so the report distinguishes "I am not listening" from "the host never
 * called it" — a distinction that is the entire point of the exercise.
 */
const subscribed = new Set<string>()

const refused: Array<[string, string]> = []

export const modProbeBuiltinMod = {
  name: 'mod-probe',
  version: '1.0.0',
  // Off unless asked for: this mod subscribes to all 109 events, so loading it
  // makes every host dispatch site take the slow path forever. Enable it in
  // `/plugins`, run a session, then `/mod-probe`.
  optIn: true,
  description:
    'Subscribes to every mod event and reports which ones the host actually fired. Run a session, then /mod-probe.',
  register(ctx: ModContext): void {
    for (const event of MOD_EVENTS) {
      const unavailable = UNAVAILABLE_EVENTS[event]
      if (unavailable !== undefined) {
        refused.push([event, unavailable])
        continue
      }
      if (event === 'ui.render') {
        // Synchronous chain with its own handler shape.
        //
        // The count has to be bumped here, in the handler. Seeding the key at
        // registration time looks harmless but makes `fired.has('ui.render')`
        // true from the first second — the report then credits a shell with a
        // live slot. That is the exact failure this tool exists to catch, so
        // it must not commit one itself.
        ctx.on('ui.render', (_e, next) => {
          fired.set('ui.render', (fired.get('ui.render') ?? 0) + 1)
          // `ui.render`'s next takes the rewritten text, not the event — it is
          // a pure text transform, which is why it is a separate chain.
          return next()
        })
        subscribed.add('ui.render')
        continue
      }
      try {
        ctx.on(event as ModEventName, (e: Record<string, unknown>, next) => {
          fired.set(event, (fired.get(event) ?? 0) + 1)
          return next(e)
        })
        subscribed.add(event)
      } catch (error) {
        refused.push([
          event,
          error instanceof Error ? error.message : String(error),
        ])
      }
    }

    ctx.registerCommand({
      name: 'mod-probe',
      description: 'Which mod events this host actually fired',
      type: 'local',
      handler: () => renderReport(),
    })

    ctx.ui.log(
      `mod-probe: listening on ${subscribed.size} of ${MOD_EVENTS.length} events (${refused.length} refused)`,
    )
  },
}

function renderReport(): string {
  const live = MOD_EVENTS.filter(e => fired.has(e))
  const quiet = [...subscribed].filter(e => !fired.has(e)).sort()
  const lines: string[] = [
    `Event slots: ${live.length} fired, ${quiet.length} subscribed-but-never-fired, ` +
      `${refused.length} refused — of ${MOD_EVENTS.length}.`,
    '',
  ]

  if (live.length > 0) {
    lines.push('FIRED:')
    for (const event of live.sort()) {
      lines.push(`  ${event} ×${fired.get(event)}`)
    }
    lines.push('')
  }

  if (quiet.length > 0) {
    lines.push('NEVER FIRED (a name with no trigger):')
    for (let i = 0; i < quiet.length; i += 4) {
      lines.push('  ' + quiet.slice(i, i + 4).map(e => e.padEnd(24)).join(''))
    }
    lines.push('')
  }

  if (refused.length > 0) {
    lines.push('REFUSED BY NAME:')
    for (const [event, why] of refused.sort()) {
      lines.push(`  ${event}: ${why}`)
    }
  }

  return lines.join('\n')
}

/** For tests: what fired since load. */
export function __probeHitsForTesting(): ReadonlyMap<string, number> {
  return fired
}

export function __resetProbeForTesting(): void {
  fired.clear()
  subscribed.clear()
  refused.length = 0
}