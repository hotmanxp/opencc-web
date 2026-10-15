/**
 * AA runtimeType derivation — one runtime type per zai InstanceDefinition.
 *
 * Before this module every zai instance was reported to AA as the same
 * runtimeType (`codex`, a placeholder chosen because AA's protocol-1.0 UI
 * rejected unknown names). AA renders one entry per runtime type, so five
 * workspaces showed up as "zai (Codex-compatible)", "… 2", "… 3" — and since
 * the type carried no identity, `portFromRuntime` had nothing but the
 * user-typed `cwd` to route on.
 *
 * Now each instance gets its own type (`zai-opencc-web`, `zai-lan-agent`), so:
 *   - the AA Web list is self-describing (no more guessing "… 2" = which repo),
 *   - `runtime.start` names its target exactly, with no cwd guessing.
 *
 * AA's constraints (server/agent_server/core/runtime_identity.py):
 *   - `validate_runtime_type` → regex `^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$`
 *   - `MAX_RUNTIME_TYPE_LENGTH = 64`
 *   - must not start with the reserved `rti_` prefix
 *   - `RuntimeDiscoveryResponse._validate_unique_runtime_types` rejects
 *     duplicate types within one `runtime.discover` response
 *
 * The `zai-` prefix satisfies the leading-lowercase rule on its own and makes
 * an `rti_`-leading type structurally impossible, so only the suffix needs
 * sanitising.
 *
 * STABILITY: AA persists runtime types in its own database. A type that
 * changes between connector restarts orphans the runtime instances created
 * under the old name, so `deriveRuntimeType` must stay a pure function of
 * persisted instance data (name / cwd / id) — never of ports, ordering, or
 * the current time.
 */

/** A zai instance as far as type derivation is concerned. */
export interface RuntimeTypeSource {
  id: string;
  name: string;
  cwd: string;
}

/** Mirrors AA's `MAX_RUNTIME_TYPE_LENGTH` (runtime_identity.py). */
const MAX_RUNTIME_TYPE_LENGTH = 64;

/** Fixed prefix — see module docblock for why it must stay `zai-`. */
const PREFIX = 'zai-';

/**
 * Runtime types zai published before per-instance types existed.
 *
 * AA sessions created against the old `codex` type keep `runtime='codex'` in
 * the server's `sessions` table, and `SessionCapabilityIndex` looks up
 * capabilities keyed by `(session.runtime, scope, sessionId, runtimeId)`.
 * Dropping `codex` from the announced capability set therefore breaks every
 * pre-existing session — it resolves to `source=None` → `supported=false` →
 * the client shows "当前运行时状态下不可发送消息".
 *
 * So this stays in the capability union (and in `runtime.discover` as an
 * unavailable legacy descriptor) for as long as AA holds such sessions.
 *
 * REMOVE WHEN: `GET /api/v2/connectors/{id}/runtime-types` shows no `codex`
 * row with live instances AND no session in AA's DB carries `runtime='codex'`.
 * Both the union entry and the legacy descriptor are removed by deleting this
 * constant — nothing else references the string.
 */
export const LEGACY_RUNTIME_TYPES: readonly string[] = ['codex'];

/**
 * Sanitise one path/name segment into the `[a-z0-9]+` alphabet AA's regex
 * allows between separators.
 *
 * Non-ASCII (Chinese names are common here) yields nothing usable, so callers
 * fall back to a different source rather than producing an empty segment.
 */
function slugifySegment(segment: string): string {
  return segment
    .toLowerCase()
    .normalize('NFKD')
    // Strip combining marks so accented Latin ("Café" → "cafe") survives;
    // CJK has no decomposition and is dropped here by the class filter below.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Last meaningful path segment of a cwd, used when the name is unusable. */
function cwdBasename(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * Derive the base slug (no prefix, no disambiguator) for an instance.
 *
 * Preference order: instance name → cwd basename → instance id. Each is
 * tried because a user can legitimately have a CJK name ("微信助手") that
 * slugifies to nothing, while the cwd is always ASCII-ish.
 */
function baseSlug(src: RuntimeTypeSource): string {
  const fromName = slugifySegment(src.name);
  if (fromName) return fromName;
  const fromCwd = slugifySegment(cwdBasename(src.cwd));
  if (fromCwd) return fromCwd;
  return slugifySegment(src.id);
}

/**
 * Short, stable disambiguator for a colliding instance.
 *
 * Instance ids look like `inst_cc1f644f`; the `inst_` prefix is redundant
 * next to `zai-` and costs 5 of our 64 characters, so it is dropped.
 */
function disambiguator(src: RuntimeTypeSource): string {
  return slugifySegment(src.id.replace(/^inst[_-]?/i, '')) || 'x';
}

/**
 * Fit `zai-<body>` inside AA's 64-char budget, keeping the disambiguator
 * intact when one is present.
 *
 * Truncation is a last resort — real slugs are far shorter — but the budget is
 * hard (pydantic `max_length=64` rejects the whole discover response), so an
 * over-long workspace name must not be able to take the connector offline.
 */
function clamp(slug: string, disambiguated: boolean): string {
  if (PREFIX.length + slug.length <= MAX_RUNTIME_TYPE_LENGTH) return PREFIX + slug;
  const budget = MAX_RUNTIME_TYPE_LENGTH - PREFIX.length;
  if (!disambiguated) return PREFIX + slug.slice(0, budget);
  // Reserve room for `-<disambiguator>`; a slug too long to hold both keeps
  // the head of the slug and a short hash-free tail of the id instead.
  const tail = `-${disambiguator({ id: slug, name: '', cwd: '' })}`;
  if (tail.length < budget) return PREFIX + slug.slice(0, budget - tail.length) + tail;
  return PREFIX + slug.slice(0, budget);
}

/**
 * Build the AA runtime type for one instance, with no collision handling.
 *
 * Use `buildRuntimeTypeMap` when reporting more than one instance — AA
 * rejects a `runtime.discover` response containing duplicate types.
 */
export function deriveRuntimeType(src: RuntimeTypeSource): string {
  const base = baseSlug(src);
  return clamp(base || 'workspace', false);
}

/**
 * Map every instance to a unique runtime type.
 *
 * Order is by instance id so the disambiguator assignment is stable when two
 * instances share a name: adding a third instance must not change the types
 * already handed to AA. Instances are returned in the input order (the caller
 * controls descriptor order); only the suffix assignment is normalised.
 */
export function buildRuntimeTypeMap(sources: readonly RuntimeTypeSource[]): Map<string, string> {
  const map = new Map<string, string>();
  const byId = [...sources].sort((a, b) => a.id.localeCompare(b.id));
  const used = new Map<string, string>(); // slug → first instance id using it

  for (const src of byId) {
    const base = baseSlug(src) || 'workspace';
    const owner = used.get(base);
    if (owner === undefined) {
      used.set(base, src.id);
      map.set(src.id, clamp(base, false));
      continue;
    }
    // Collision: extend with the id. If even that collides (two instances
    // sharing both name and id, which the store forbids), append a counter.
    let candidate = clamp(`${base}-${disambiguator(src)}`, true);
    let n = 2;
    while (used.has(candidate)) {
      candidate = clamp(`${base}-${disambiguator(src)}-${n}`, true);
      n += 1;
    }
    used.set(candidate, src.id);
    map.set(src.id, candidate);
  }
  return map;
}

/**
 * Mirror of AA's `validate_runtime_type`, used to guard values we did not
 * derive ourselves (e.g. a type echoed back by AA in an RPC param).
 */
export function isLegalRuntimeType(value: string): boolean {
  if (value.length === 0 || value.length > MAX_RUNTIME_TYPE_LENGTH) return false;
  if (value.startsWith('rti_')) return false;
  return /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value);
}
