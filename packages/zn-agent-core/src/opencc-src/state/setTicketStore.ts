import { createStore, type Store } from './store.js'

type SetTicketState = {
  id: string | null
}

const store: Store<SetTicketState> = createStore<SetTicketState>({ id: null })

export const setTicketStore = store

export function getTicketId(): string | null {
  return store.getState().id
}

export function setTicketId(id: string): void {
  store.setState(() => ({ id }))
}

export function clearTicketId(): void {
  store.setState(() => ({ id: null }))
}
