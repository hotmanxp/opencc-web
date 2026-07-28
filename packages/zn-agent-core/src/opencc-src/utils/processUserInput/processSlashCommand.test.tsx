import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { processSlashCommand } from './processSlashCommand.js';
import * as stackedSkillModule from './processStackedSkillInvocation.js';
import type { SplitStackedSkillInvocationInput } from './processStackedSkillInvocation.js';
import * as userPromptExpansionModule from '../../hooks/userPromptExpansion.js';
import * as commandsModule from '../../commands.js';
import type { Command } from '../../types/command.js';
import type { AttachmentMessage } from '../../types/message.js';

// ---------- fixtures ----------
const stubCmd = (name: string): Command =>
  ({ name, type: 'local', description: name } as unknown as Command);

const buildContext = (commands: Command[]) =>
  ({
    options: {
      commands,
      tools: [],
      isNonInteractiveSession: true,
      getToolPermissionContext: () => Promise.resolve({} as never),
      mainLoopModel: 'sonnet',
      mcpTools: [],
    },
    messages: [],
    abortController: new AbortController(),
    getAppState: () => ({
      mcp: { clients: [] },
    }) as never,
    setAppState: () => {},
    setResponseLength: () => {},
    setToolJSX: () => {},
    refreshTools: () => [],
    agentId: undefined,
    agentType: undefined,
  }) as never;

// ---------- tests ----------
describe('processSlashCommand — stacked skill loading (Task 3 wiring)', () => {
  let findCommandSpy: ReturnType<typeof spyOn>;
  let splitSpy: ReturnType<typeof spyOn>;
  let hookSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    findCommandSpy = spyOn(commandsModule, 'findCommand').mockImplementation(
      (name: string) => stubCmd(name),
    );
    splitSpy = spyOn(stackedSkillModule, 'splitStackedSkillInvocation');
    hookSpy = spyOn(userPromptExpansionModule, 'invokeUserPromptExpansionHook');
  });

  afterEach(() => {
    findCommandSpy.mockRestore();
    splitSpy.mockRestore();
    hookSpy.mockRestore();
  });

  test('wires splitStackedSkillInvocation at top of processSlashCommand', async () => {
    splitSpy.mockImplementation((input: SplitStackedSkillInvocationInput) => ({
      commands: [stubCmd(input.primaryCommandName)],
      trailingArgs: input.primaryArgs,
      capped: false,
    }));

    const result = await processSlashCommand(
      '/foo bar',
      [],
      [],
      [] as AttachmentMessage[],
      buildContext([stubCmd('foo')]),
      () => {},
      '00000000-0000-4000-8000-000000000099',
    );

    expect(splitSpy).toHaveBeenCalledTimes(1);
    expect(result.messages.length).toBeGreaterThan(0);
  });

  test('single /foo falls through to legacy path (no stacked helper invoked)', async () => {
    splitSpy.mockImplementation((input: SplitStackedSkillInvocationInput) => ({
      commands: [stubCmd(input.primaryCommandName)],
      trailingArgs: input.primaryArgs,
      capped: false,
    }));

    // Mock the actual command execution by stubbing the local-command mod.
    // Since legacy path goes through getMessagesForSlashCommand which calls
    // command.load().then(mod => mod.call(...)), we provide a local command
    // whose load() resolves to a mod whose call() emits a single message.
    const fooCmd: Command = {
      name: 'foo',
      type: 'local',
      description: 'foo',
      load: () => Promise.resolve({ call: () => Promise.resolve({ type: 'text', value: 'foo-out' }) }) as never,
    } as unknown as Command;

    const result = await processSlashCommand(
      '/foo',
      [],
      [],
      [] as AttachmentMessage[],
      buildContext([fooCmd]),
      () => {},
      '00000000-0000-4000-8000-000000000100',
    );

    // splitSpy WAS called once (the wiring always calls the scanner).
    expect(splitSpy).toHaveBeenCalledTimes(1);
    // stacked.commands.length === 1 AND not capped ⇒ legacy path runs.
    expect(splitSpy.mock.calls[0]![0]).toEqual({
      primaryCommandName: 'foo',
      primaryArgs: '',
      resolveCommand: expect.any(Function) as never,
    });
    // Legacy path should produce messages (via the local-command path).
    expect(result.messages.length).toBeGreaterThan(0);
    // The hook should NOT be invoked (it's only invoked in the stacked path).
    expect(hookSpy).not.toHaveBeenCalled();
  });

  test('/foo /bar stack of length 2 dispatches to processStackedSkillInvocation', async () => {
    // Force the scanner to return a 2-length stack + trailing args.
    splitSpy.mockImplementation((input: SplitStackedSkillInvocationInput) => {
      // Scanner is mocked, so we hard-code the stacked result for "/foo /bar baz".
      if (input.primaryCommandName === 'foo' && input.primaryArgs === '/bar baz') {
        return {
          commands: [stubCmd('foo'), stubCmd('bar')],
          trailingArgs: 'baz',
          capped: false,
        };
      }
      return {
        commands: [stubCmd(input.primaryCommandName)],
        trailingArgs: input.primaryArgs,
        capped: false,
      };
    });

    const result = await processSlashCommand(
      '/foo /bar baz',
      [],
      [],
      [] as AttachmentMessage[],
      buildContext([stubCmd('foo'), stubCmd('bar')]),
      () => {},
      '00000000-0000-4000-8000-000000000101',
    );

    expect(splitSpy).toHaveBeenCalledTimes(1);
    // The hook stub returns undefined (allow) for every command.
    expect(hookSpy).toHaveBeenCalledTimes(2);
    // Stack result should be returned.
    expect(Array.isArray(result.messages)).toBe(true);
  });

  test('/unknown preserves legacy "Unknown skill" error path', async () => {
    // Spy findCommand to return undefined for the unknown command, simulating
    // the real `hasCommand` check failing (which uses findCommand internally).
    findCommandSpy.mockRestore();
    findCommandSpy = spyOn(commandsModule, 'findCommand').mockReturnValue(undefined);

    const result = await processSlashCommand(
      '/unknown',
      [],
      [],
      [] as AttachmentMessage[],
      buildContext([stubCmd('foo')]),
      () => {},
      '00000000-0000-4000-8000-000000000102',
    );

    // Unknown command: scanner returns empty stack (legacy fallback).
    expect(splitSpy).toHaveBeenCalledTimes(1);
    // The result message should contain the unknown-skill error.
    const resultText = (result.messages as { message?: { content?: unknown } }[])
      .map((m) => m.message?.content)
      .filter((c): c is string => typeof c === 'string')
      .join('\n');
    expect(resultText).toContain('Unknown skill: unknown');
  });

  test('invokeUserPromptExpansionHook returning {blocked:true} pushes a warning', async () => {
    splitSpy.mockImplementation(() => ({
      commands: [stubCmd('foo'), stubCmd('bar')],
      trailingArgs: 'baz',
      capped: false,
    }));
    hookSpy.mockImplementation(async () => ({ blocked: true, reason: 'policy-violation' }));

    const result = await processSlashCommand(
      '/foo /bar baz',
      [],
      [],
      [] as AttachmentMessage[],
      buildContext([stubCmd('foo'), stubCmd('bar')]),
      () => {},
      '00000000-0000-4000-8000-000000000103',
    );

    // Two stacked commands => hook invoked twice.
    expect(hookSpy).toHaveBeenCalledTimes(2);
    // Each invocation should produce a system warning message.
    const warningMessages = (result.messages as { content?: unknown; level?: string }[]).filter(
      (m) => m.level === 'warning',
    );
    expect(warningMessages.length).toBeGreaterThanOrEqual(2);
    const allWarnings = warningMessages.map((m) => String(m.content ?? '')).join('\n');
    expect(allWarnings).toContain('foo');
    expect(allWarnings).toContain('bar');
    expect(allWarnings).toContain('policy-violation');
  });
});
