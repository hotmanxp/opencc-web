// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): L2 state machine — CommandKeybindingsState.
 * Wraps vendor command-parse logic as standalone class. P0 only implements
 * /-prefixed command parsing; full keybinding matrix lands in P1.
 * See REPL.tsx:3457-3458 and useTypeahead.tsx for the vendor parse pattern.
 */

type ParseResult = { command: string; args: string } | null

type SetupCommandKeybindingsOpts = {
  onCommand?: (cmd: string, args: string) => void
  onKeybinding?: (key: string) => void
}

export class CommandKeybindingsState {
  private buffer: string = ''
  private opts: SetupCommandKeybindingsOpts

  constructor(opts: SetupCommandKeybindingsOpts = {}) {
    this.opts = opts
  }

  parse(input: string): ParseResult {
    const trimmed = input.trim()
    if (!trimmed.startsWith('/')) return null

    const spaceIdx = trimmed.indexOf(' ')
    const command = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)
    const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim()

    if (this.opts.onCommand) {
      this.opts.onCommand(command, args)
    }

    return { command, args }
  }

  reset(): void {
    this.buffer = ''
  }

  getBuffered(): string {
    return this.buffer
  }
}

export function setupCommandKeybindings(opts: SetupCommandKeybindingsOpts = {}): {
  state: CommandKeybindingsState
  teardown(): void
} {
  const state = new CommandKeybindingsState(opts)
  return {
    state,
    teardown() {
      state.reset()
    },
  }
}
