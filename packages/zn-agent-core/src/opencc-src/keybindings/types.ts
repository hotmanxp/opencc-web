// Keybindings types
export type KeybindingBlock = {
  context: string
  bindings: Record<string, string | null>
}

export type Chord = ParsedKeystroke[]

export type ParsedKeystroke = {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  super: boolean
}

export type ParsedBinding = {
  chord: Chord
  action: string | null
  context: string
}

export type KeybindingContextName = string
