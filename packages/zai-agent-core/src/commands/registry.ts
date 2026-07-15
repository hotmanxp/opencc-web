import type { Command } from './types.js'

export interface ResolvedCommand {
  command: Command
  args: string
}

export interface CommandRegistry {
  register(cmd: Command): void
  unregister(name: string): void
  get(name: string): Command | undefined
  all(): Command[]
  resolve(input: string): ResolvedCommand | null
}

class InMemoryRegistry implements CommandRegistry {
  private byPrimary = new Map<string, Command>()
  private byAlias = new Map<string, Command>()

  private key(name: string): string {
    return name.toLowerCase()
  }

  register(cmd: Command): void {
    const oldCmd = this.byPrimary.get(this.key(cmd.name))
    if (oldCmd && oldCmd !== cmd) {
      // 清理旧命令的 alias(只清指向旧实例的项,避免误删共享)
      if (oldCmd.aliases) {
        for (const a of oldCmd.aliases) {
          if (this.byAlias.get(this.key(a)) === oldCmd) {
            this.byAlias.delete(this.key(a))
          }
        }
      }
    }
    this.byPrimary.set(this.key(cmd.name), cmd)
    if (cmd.aliases) {
      for (const a of cmd.aliases) this.byAlias.set(this.key(a), cmd)
    }
  }

  unregister(name: string): void {
    const cmd = this.byPrimary.get(this.key(name))
    this.byPrimary.delete(this.key(name))
    if (cmd?.aliases) {
      for (const a of cmd.aliases) {
        if (this.byAlias.get(this.key(a)) === cmd) {
          this.byAlias.delete(this.key(a))
        }
      }
    }
  }

  get(name: string): Command | undefined {
    const k = this.key(name)
    return this.byPrimary.get(k) ?? this.byAlias.get(k)
  }

  all(): Command[] {
    return Array.from(this.byPrimary.values())
  }

  resolve(input: string): ResolvedCommand | null {
    const trimmed = input.trim()
    if (!trimmed.startsWith('/')) return null
    const rest = trimmed.slice(1)
    if (!rest) return null
    // First whitespace-separated token is the name; the rest is args.
    const sp = rest.search(/\s/)
    const name = sp === -1 ? rest : rest.slice(0, sp)
    const args = sp === -1 ? '' : rest.slice(sp + 1).trim()
    const cmd = this.get(name)
    if (!cmd) return null
    return { command: cmd, args }
  }
}

let _registry: CommandRegistry | null = null

export function getCommandRegistry(): CommandRegistry {
  if (!_registry) _registry = new InMemoryRegistry()
  return _registry
}

export function setCommandRegistry(r: CommandRegistry | null): void {
  _registry = r
}