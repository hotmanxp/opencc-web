import { ServerEvent } from '../../shared/events.js'

type Subscriber = (event: ServerEvent) => void

const CAPACITY = 256
let counter = 0
const nextId = () => `evt_${Date.now().toString(36)}_${(++counter).toString(36)}`

// Indexed-mapping input type: distributes ServerEvent variants by `type` discriminator
// so inline object literals narrow correctly without excess property checks rejecting
// variant-specific fields. eventId/ts remain optional (filled in by emit).
export type ServerEventInput = {
  [K in ServerEvent as K['type']]: Omit<K, 'eventId' | 'ts'> & { eventId?: string; ts?: number }
}[ServerEvent['type']]

export class ServerEventBus {
  private subs = new Set<Subscriber>()
  private history: ServerEvent[] = []

  emit(event: ServerEventInput) {
    const full: ServerEvent = {
      ...event,
      eventId: event.eventId ?? nextId(),
      ts: event.ts ?? Date.now(),
    } as ServerEvent
    this.history.push(full)
    if (this.history.length > CAPACITY) this.history.shift()
    for (const sub of this.subs) {
      try {
        sub(full)
      } catch (err) {
        console.error('[eventBus] subscriber threw', err)
      }
    }
  }

  getHistoryAfter(lastEventId?: string): ServerEvent[] {
    if (lastEventId === undefined) return []
    const idx = this.history.findIndex((e) => e.eventId === lastEventId)
    if (idx < 0) return [...this.history]
    return this.history.slice(idx + 1)
  }

  subscribe(sub: Subscriber): () => void {
    this.subs.add(sub)
    return () => {
      this.subs.delete(sub)
    }
  }
}

export const eventBus = new ServerEventBus()