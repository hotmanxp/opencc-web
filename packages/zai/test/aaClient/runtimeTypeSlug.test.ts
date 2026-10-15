/**
 * Tests for AA runtimeType derivation.
 *
 * The contract these lock in is not cosmetic: AA persists runtime types in
 * its own database, so a type that changes between connector restarts orphans
 * every runtime instance created under the old name. Determinism and
 * cross-restart stability are load-bearing, not nice-to-have.
 */
import { describe, expect, it } from 'vitest';
import {
  buildRuntimeTypeMap,
  deriveRuntimeType,
  isLegalRuntimeType,
  LEGACY_RUNTIME_TYPES,
} from '../../src/server/services/aaClient/runtimeType.js';

describe('deriveRuntimeType', () => {
  it('derives a readable type from the instance name', () => {
    expect(deriveRuntimeType({ id: 'inst_e15a2312', name: 'opencc-web', cwd: '/Users/ethan/code/opencc-web' }))
      .toBe('zai-opencc-web');
    expect(deriveRuntimeType({ id: 'inst_a9dc9a81', name: 'LAN-Agent', cwd: '/Users/ethan/code/lan-agent' }))
      .toBe('zai-lan-agent');
  });

  it('lowercases and hyphenates names AA cannot use verbatim', () => {
    expect(deriveRuntimeType({ id: 'inst_1', name: 'Code-AA', cwd: '/Users/ethan/code' })).toBe('zai-code-aa');
    expect(deriveRuntimeType({ id: 'inst_2', name: 'My Project!', cwd: '/tmp/p' })).toBe('zai-my-project');
    expect(deriveRuntimeType({ id: 'inst_3', name: 'Café Client', cwd: '/tmp/c' })).toBe('zai-cafe-client');
  });

  it('falls back to the cwd basename when the name has no ASCII', () => {
    // A CJK name slugifies to nothing; the cwd is the only usable signal.
    expect(deriveRuntimeType({ id: 'inst_1', name: '微信助手', cwd: '/Users/ethan/weichat-agent' }))
      .toBe('zai-weichat-agent');
  });

  it('falls back to the cwd basename for an empty name', () => {
    expect(deriveRuntimeType({ id: 'inst_3', name: '', cwd: '/Users/ethan/code/some-repo' }))
      .toBe('zai-some-repo');
  });

  it('never produces a type starting with the reserved rti_ prefix', () => {
    // An instance literally named "rti_evil" must not be able to forge an
    // instance id — the zai- prefix makes that structurally impossible.
    const t = deriveRuntimeType({ id: 'inst_5', name: 'rti_evil', cwd: '/tmp/z' });
    expect(t.startsWith('rti_')).toBe(false);
    expect(t).toBe('zai-rti-evil');
  });

  it('clamps to AA 64-char limit', () => {
    const t = deriveRuntimeType({ id: 'inst_4', name: 'a'.repeat(80), cwd: '/tmp/y' });
    expect(t.length).toBeLessThanOrEqual(64);
    expect(isLegalRuntimeType(t)).toBe(true);
  });

  it('is deterministic across calls', () => {
    const src = { id: 'inst_x', name: 'Repeat Me', cwd: '/tmp/r' };
    expect(deriveRuntimeType(src)).toBe(deriveRuntimeType(src));
  });

  it('emits only types AA would accept', () => {
    const sources = [
      { id: 'inst_1', name: '微信助手', cwd: '/Users/ethan/weichat-agent' },
      { id: 'inst_2', name: 'Café', cwd: '/tmp/c' },
      { id: 'inst_3', name: '', cwd: '/tmp/empty-name' },
      { id: 'inst_4', name: 'a'.repeat(200), cwd: '/tmp/long' },
      { id: 'inst_5', name: 'rti_x', cwd: '/tmp/reserved' },
      { id: 'inst_6', name: '!!!', cwd: '/tmp/punct' },
    ];
    for (const src of sources) {
      expect(isLegalRuntimeType(deriveRuntimeType(src))).toBe(true);
    }
  });
});

describe('buildRuntimeTypeMap', () => {
  it('gives every instance a unique type', () => {
    const sources = [
      { id: 'inst_e15a2312', name: 'opencc-web', cwd: '/Users/ethan/code/opencc-web' },
      { id: 'inst_9e9d8d7f', name: 'weixin-bot', cwd: '/Users/ethan/weichat-agent' },
      { id: 'inst_a9dc9a81', name: 'LAN-Agent', cwd: '/Users/ethan/code/lan-agent' },
      { id: 'inst_cc1f644f', name: 'Code-AA', cwd: '/Users/ethan/code' },
      { id: 'inst_1580ca54', name: 'opencc-aa', cwd: '/Users/ethan/code/opencc' },
    ];
    const map = buildRuntimeTypeMap(sources);
    expect(map.size).toBe(sources.length);
    expect(new Set(map.values()).size).toBe(sources.length);
    for (const type of map.values()) expect(isLegalRuntimeType(type)).toBe(true);
  });

  it('disambiguates instances that share a name', () => {
    // AA rejects duplicate runtimeTypes in one discover response
    // (device_runtime.py::_validate_unique_runtime_types).
    const sources = [
      { id: 'inst_aaa111', name: 'app', cwd: '/tmp/a' },
      { id: 'inst_bbb222', name: 'app', cwd: '/tmp/b' },
      { id: 'inst_ccc333', name: 'app', cwd: '/tmp/c' },
    ];
    const map = buildRuntimeTypeMap(sources);
    const types = [...map.values()];
    expect(new Set(types).size).toBe(3);
    for (const type of types) expect(isLegalRuntimeType(type)).toBe(true);
  });

  it('keeps existing types stable when an unrelated instance is added', () => {
    // The regression this guards: AA has already persisted these types, so
    // adding a new zai instance must not rename any existing one.
    const before = [
      { id: 'inst_aaa111', name: 'app', cwd: '/tmp/a' },
      { id: 'inst_bbb222', name: 'app', cwd: '/tmp/b' },
    ];
    const after = [...before, { id: 'inst_zzz999', name: 'brand-new', cwd: '/tmp/n' }];
    const m1 = buildRuntimeTypeMap(before);
    const m2 = buildRuntimeTypeMap(after);
    for (const src of before) {
      expect(m2.get(src.id)).toBe(m1.get(src.id));
    }
  });

  it('keeps types stable when an unrelated instance is inserted', () => {
    // Sorts by id, so insertion order in instances.json cannot shift suffixes.
    const a = { id: 'inst_aaa111', name: 'app', cwd: '/tmp/a' };
    const b = { id: 'inst_bbb222', name: 'app', cwd: '/tmp/b' };
    const c = { id: 'inst_ccc333', name: 'other', cwd: '/tmp/c' };
    const m1 = buildRuntimeTypeMap([a, c, b]);
    const m2 = buildRuntimeTypeMap([b, a, c]);
    expect(m1.get(a.id)).toBe(m2.get(a.id));
    expect(m1.get(b.id)).toBe(m2.get(b.id));
  });

  it('returns an empty map for no instances', () => {
    expect(buildRuntimeTypeMap([]).size).toBe(0);
  });
});

describe('isLegalRuntimeType', () => {
  it('mirrors AA validate_runtime_type', () => {
    expect(isLegalRuntimeType('zai-opencc-web')).toBe(true);
    expect(isLegalRuntimeType('codex')).toBe(true);
    expect(isLegalRuntimeType('a')).toBe(true);
    expect(isLegalRuntimeType('a.b_c-d')).toBe(true);

    expect(isLegalRuntimeType('')).toBe(false);
    expect(isLegalRuntimeType('Zai')).toBe(false);          // uppercase
    expect(isLegalRuntimeType('-zai')).toBe(false);         // leading separator
    expect(isLegalRuntimeType('rti_abc')).toBe(false);      // reserved prefix
    expect(isLegalRuntimeType('a'.repeat(65))).toBe(false); // over max_length
  });
});

describe('LEGACY_RUNTIME_TYPES', () => {
  it('still carries a legal type', () => {
    // The legacy entry keeps pre-existing AA sessions (runtime='codex') able
    // to resolve capabilities; see the module docblock for removal criteria.
    for (const t of LEGACY_RUNTIME_TYPES) expect(isLegalRuntimeType(t)).toBe(true);
    expect(LEGACY_RUNTIME_TYPES).toContain('codex');
  });
});
