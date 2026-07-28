import { describe, expect, test } from 'bun:test';
import type { Command } from '../../types/command.js';
import {
  STACKED_SKILL_LIMIT,
  splitStackedSkillInvocation,
} from './processStackedSkillInvocation.js';

const stubCmd = (name: string): Command =>
  ({ name, type: 'local', description: name } as unknown as Command);

const lookup = (...names: string[]) => {
  const set = new Set(names);
  return (n: string) => (set.has(n) ? stubCmd(n) : undefined);
};

describe('splitStackedSkillInvocation', () => {
  test('single /foo returns [foo] with empty trailing', () => {
    const r = splitStackedSkillInvocation({
      primaryCommandName: 'foo',
      primaryArgs: '',
      resolveCommand: lookup('foo'),
    });
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0].name).toBe('foo');
    expect(r.trailingArgs).toBe('');
    expect(r.capped).toBe(false);
  });

  test('single /foo with trailing args keeps args intact', () => {
    const r = splitStackedSkillInvocation({
      primaryCommandName: 'foo',
      primaryArgs: 'bar baz',
      resolveCommand: lookup('foo'),
    });
    expect(r.commands.map((c) => c.name)).toEqual(['foo']);
    expect(r.trailingArgs).toBe('bar baz');
  });

  test('stacked /foo /bar with trailing returns two commands', () => {
    const r = splitStackedSkillInvocation({
      primaryCommandName: 'foo',
      primaryArgs: '/bar baz',
      resolveCommand: lookup('foo', 'bar'),
    });
    expect(r.commands.map((c) => c.name)).toEqual(['foo', 'bar']);
    expect(r.trailingArgs).toBe('baz');
  });

  test('unknown token stops the stack (longest-prefix fallback)', () => {
    const r = splitStackedSkillInvocation({
      primaryCommandName: 'foo',
      primaryArgs: '/unknown /bar baz',
      resolveCommand: lookup('foo', 'bar'),
    });
    expect(r.commands.map((c) => c.name)).toEqual(['foo']);
    expect(r.trailingArgs).toBe('/unknown /bar baz');
  });

  test('cap of 5 reached: 6th token remains in trailing with capped=true', () => {
    const r = splitStackedSkillInvocation({
      primaryCommandName: 'a',
      primaryArgs: '/b /c /d /e /f bar',
      resolveCommand: lookup('a', 'b', 'c', 'd', 'e'),  // 'f' unknown
      // Note: even if 'f' were known, STACKED_SKILL_LIMIT caps at 5.
    });
    expect(r.commands.map((c) => c.name)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(r.trailingArgs).toBe('/f bar');
    expect(r.capped).toBe(true);
    expect(STACKED_SKILL_LIMIT).toBe(5);
  });

  test('cap of 5 with all known commands: capped and rest passes through as args', () => {
    const r = splitStackedSkillInvocation({
      primaryCommandName: 'a',
      primaryArgs: '/b /c /d /e /f bar',
      resolveCommand: lookup('a', 'b', 'c', 'd', 'e', 'f'),
    });
    expect(r.commands.map((c) => c.name)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(r.trailingArgs).toBe('/f bar');
    expect(r.capped).toBe(true);
  });

  test('unknown primary returns empty stack (legacy path)', () => {
    const r = splitStackedSkillInvocation({
      primaryCommandName: 'unknown',
      primaryArgs: 'rest',
      resolveCommand: lookup('known'),
    });
    expect(r.commands).toEqual([]);
    expect(r.trailingArgs).toBe('rest');
    expect(r.capped).toBe(false);
  });
});
