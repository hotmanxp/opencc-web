// @ts-nocheck
import { afterEach, describe, expect, mock, test } from 'bun:test'

// Mock persistence BEFORE importing the module under test (top-level await required).
await mock.module('../../utils/tickets/persistence.js', () => ({
  readTicketList: mock(async () => []),
  pushTicketEntry: mock(async (_id: string) => [_id]),
}))

const { call } = await import('./setTicket.js')
const { clearTicketId, getTicketId, setTicketId } = await import('../../state/setTicketStore.js')

function makeOnDone() {
  return mock((_result: unknown, _options?: unknown) => {})
}

describe('setTicket call()', () => {
  afterEach(() => {
    clearTicketId()
  })

  test('set: valid id stores and reports success via onDone', async () => {
    const onDone = makeOnDone()
    await call(onDone, undefined, 'HRMSV3-ZN-WEBSITE#668')
    expect(getTicketId()).toBe('HRMSV3-ZN-WEBSITE#668')
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone.mock.calls[0][0]).toContain('HRMSV3-ZN-WEBSITE#668')
  })

  test('set: success message mentions /clear for mid-conversation', async () => {
    const onDone = makeOnDone()
    await call(onDone, undefined, 'HRMSV3-ZN-WEBSITE#668')
    const text = onDone.mock.calls[0][0] as string
    expect(text).toContain('/clear')
  })

  test('set: attaches english system-reminder meta message containing the id', async () => {
    const onDone = makeOnDone()
    await call(onDone, undefined, 'ZN-INTERNATIONAL#801')
    const options = onDone.mock.calls[0][1] as { metaMessages?: string[] }
    expect(options.metaMessages).toBeArrayOfSize(1)
    const meta = options.metaMessages![0]
    expect(meta).toContain('<system-reminder>')
    expect(meta).toContain('ZN-INTERNATIONAL#801')
    expect(meta).toContain('/set-ticket clear')
    expect(meta).toContain('ZN-INTERNATIONAL#801 feat(login): xxx')
  })

  test('set: invalid id rejects and does not store', async () => {
    const onDone = makeOnDone()
    await call(onDone, undefined, 'badformat')
    expect(getTicketId()).toBeNull()
    expect(onDone.mock.calls[0][0]).toContain('无效的 ticket id')
  })

  test('clear: clears session id and emits english meta', async () => {
    setTicketId('PROJ#1')
    const onDone = makeOnDone()
    await call(onDone, undefined, 'clear')
    expect(getTicketId()).toBeNull()
    const options = onDone.mock.calls[0][1] as { metaMessages?: string[] }
    expect(options.metaMessages![0]).toContain('cleared')
  })

  test('no-arg + non-TTY: emits text listing recent ids', async () => {
    const { readTicketList } = await import('../../utils/tickets/persistence.js')
    ;(readTicketList as ReturnType<typeof mock>).mockImplementation(async () => ['A', 'B', 'C'])

    const original = process.stdout.isTTY
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
    try {
      const onDone = makeOnDone()
      await call(onDone, undefined, '')
      const text = onDone.mock.calls[0][0] as string
      expect(text).toContain('A')
      expect(text).toContain('B')
      expect(text).toContain('C')
      expect(text).toContain('/set-ticket <id>')
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: original, configurable: true })
    }
  })

  test('no-arg + TTY: returns non-null React tree (interactive picker)', async () => {
    const { readTicketList } = await import('../../utils/tickets/persistence.js')
    ;(readTicketList as ReturnType<typeof mock>).mockImplementation(async () => ['X', 'Y'])

    const original = process.stdout.isTTY
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    try {
      const onDone = makeOnDone()
      const tree = await call(onDone, undefined, '')
      // Interactive picker: returns JSX, NOT text onDone. REPL setToolJSX
      // mounts the tree; onDone fires when user submits a selection.
      expect(tree).not.toBeNull()
      expect(onDone).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: original, configurable: true })
    }
  })

  test('no-arg + TTY: wires Esc cancel via TicketSelector.onCancelled', async () => {
    // The Select component renders Esc handling via the `select:cancel`
    // keybinding → `state.onCancel()` → `props.onCancel`. We can't mount
    // the full picker in bun:test (Select depends on Ink's useInput
    // provider context), but we can statically verify the wiring: call()
    // returns a TicketSelector element whose `onCancelled` prop, when
    // invoked, routes through onDone with the cancel message. The live
    // Select's onCancel calls this exact prop on Esc.
    const { readTicketList } = await import('../../utils/tickets/persistence.js')
    ;(readTicketList as ReturnType<typeof mock>).mockImplementation(async () => ['X', 'Y'])

    const original = process.stdout.isTTY
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    try {
      const onDone = makeOnDone()
      const tree = await call(onDone, undefined, '')
      expect(tree).not.toBeNull()

      // Walk the (single-level) element tree. call() returns exactly one
      // TicketSelector element; pull its onCancelled prop and fire it —
      // that is the callback Select.onCancel triggers on Esc.
      const el = tree as {
        type: { name?: string }
        props: { onCancelled?: () => void }
      }
      expect(el.type.name).toBe('TicketSelector')
      expect(el.props.onCancelled).toBeFunction()
      el.props.onCancelled!()

      expect(onDone).toHaveBeenCalledTimes(1)
      const text = onDone.mock.calls[0][0] as string
      expect(text).toContain('已取消')
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: original, configurable: true })
    }
  })
})
