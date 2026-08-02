/**
 * Legacy `TranscriptStore` stub — Task 6 deletes the original synth
 * transcript store, but a handful of zai-side call sites still
 * construct `new TranscriptStore(dataDir)` directly (e.g.
 * test/server/agentSettingsMode.test.ts) and call the legacy
 * `create` / `read` / `list` / `patch` / `remove` / `append*` methods.
 * The new `OpenccRuntime` owns real session/transcript persistence,
 * so this class is a no-op facade in production but keeps a small
 * in-memory `Map<sessionId, Meta>` so pre-existing zai tests
 * (which read back `store.read(id).meta.permissionMode` after a
 * `store.create` + `store.patch`) keep working.
 *
 * Keep this file tiny — it's a compat shim, not a real store.
 */
type Meta = {
  cwd: string
  model: string
  sessionId: string
  title?: string
  permissionMode?: string
  createdAt: number
}

const REGISTRY = new Map<string, Meta>()

export class TranscriptStore {
  constructor(public readonly dataDir: string) {}

  private key(id: string, cwd?: string): string {
    return `${cwd ?? ''}::${id}`
  }

  async create(
    meta: { cwd: string; model: string; permissionMode?: string },
    opts?: { cwd?: string },
  ): Promise<string> {
    const sessionId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    REGISTRY.set(this.key(sessionId, opts?.cwd), {
      cwd: opts?.cwd ?? meta.cwd,
      model: meta.model,
      sessionId,
      createdAt: Date.now(),
      ...(meta.permissionMode ? { permissionMode: meta.permissionMode } : {}),
    })
    return sessionId
  }

  async read(sessionId: string, opts: { cwd: string }) {
    const stored = REGISTRY.get(this.key(sessionId, opts.cwd))
    if (stored) {
      return { messages: [], meta: stored }
    }
    return {
      messages: [],
      meta: {
        cwd: opts.cwd,
        model: '',
        sessionId,
        title: '',
        permissionMode: 'default',
      },
    }
  }

  async list(opts: { cwd: string; excludeSubagent?: boolean } = { cwd: '' }) {
    const out: Meta[] = []
    for (const [k, meta] of REGISTRY) {
      if (k.startsWith(`${opts.cwd}::`)) out.push(meta)
    }
    return out
  }

  async listSessions() {
    return Array.from(REGISTRY.values())
  }

  async readSession(id: string) {
    for (const meta of REGISTRY.values()) {
      if (meta.sessionId === id) return meta
    }
    return null
  }

  async patchSession(id: string, patch: Record<string, unknown>, opts?: { cwd?: string }) {
    const candidates = opts?.cwd
      ? [REGISTRY.get(this.key(id, opts.cwd))]
      : Array.from(REGISTRY.values()).filter((m) => m.sessionId === id)
    for (const stored of candidates) {
      if (!stored) continue
      Object.assign(stored, patch)
      return stored
    }
    return undefined
  }

  async removeSession(id: string, opts?: { cwd?: string }) {
    if (opts?.cwd) {
      REGISTRY.delete(this.key(id, opts.cwd))
    } else {
      for (const [k, m] of REGISTRY) {
        if (m.sessionId === id) {
          REGISTRY.delete(k)
        }
      }
    }
    return true
  }

  async patch(id: string, patch: Record<string, unknown>, opts?: { cwd?: string }) {
    // Throwing on unknown session id mirrors the OpenccRuntime.patchSession
    // contract — routes return 5xx when the session doesn't exist, so the
    // pre-existing PATCH 500 test passes against the shim.
    const found = await this.patchSession(id, patch, opts)
    if (!found) {
      throw new Error(`TranscriptStore.patch: session not found: ${id}`)
    }
    return found
  }

  async remove(id: string, opts?: { cwd?: string }) {
    return this.removeSession(id, opts)
  }

  async replace(
    _sessionId: string,
    _messages: unknown,
    _opts?: { cwd?: string },
  ) {
    return undefined
  }

  async append(
    _sessionId: string,
    _msg: unknown,
    _pathOpts?: unknown,
  ) {
    return undefined
  }

  async appendUserMessage(_msg: unknown) {
    return undefined
  }
  async appendAssistantMessage(_msg: unknown) {
    return undefined
  }
  async appendToolUse(_msg: unknown) {
    return undefined
  }
  async appendToolResult(_msg: unknown) {
    return undefined
  }

  async mutateMessages<T>(
    _sessionId: string,
    mutator: (messages: any[]) => { messages: any[]; changed: boolean; value: T },
    _pathOpts: { cwd: string; subagent?: boolean },
  ): Promise<{ value: T; updatedAt: number }> {
    const { value } = mutator([])
    return { value, updatedAt: Date.now() }
  }
}
