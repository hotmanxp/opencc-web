import { describe, expect, test, beforeEach, mock, afterEach } from 'bun:test';
import * as M from './effort.js';
import { executeEffort, setEffortValue } from './effort.js';
import { resetUltracodeReminderState } from '../../utils/ultracodeReminder.js';

// Complete mock of `settings.js` — must include EVERY export the production
// code (directly or transitively) imports, otherwise a downstream test file
// that loads `effort.tsx` (which imports `AppStateStore → settings.js`) will
// fail with `Export named 'X' not found in module .../settings/settings.ts`.
//
// bun's `mock.module()` registers globally for the entire test process; the
// partial mock leaks across test files and is not cleared by `mock.restore()`.
function makeCompleteSettingsMock(overrides: Record<string, unknown> = {}) {
  return {
    getInitialSettings: () => ({}),
    getSettingsForSource: () => null,
    getSettingsWithErrors: () => ({ settings: {}, errors: [] }),
    getSettings_DEPRECATED: () => ({}),
    updateSettingsForSource: () => ({ error: null }),
    getSettingsWithSources: () => ({ effective: {}, sources: [] }),
    getSettingsFilePathForSource: () => undefined,
    getRelativeSettingsFilePathForSource: () => '',
    getSettingsRootPathForSource: () => '/',
    hasAutoModeOptIn: () => false,
    hasSkipDangerousModePermissionPrompt: () => false,
    hasAllowBypassPermissionsMode: () => false,
    getUseAutoModeDuringPlan: () => true,
    getAutoModeConfig: () => undefined,
    rawSettingsContainsKey: () => false,
    getManagedFileSettingsPresence: () => ({ hasBase: false, hasDropIns: false }),
    getPolicySettingsOrigin: () => null,
    loadManagedFileSettings: () => ({ settings: null, errors: [] }),
    parseSettingsFile: () => ({ settings: null, errors: [] }),
    getManagedSettingsKeysForLogging: () => [],
    settingsMergeCustomizer: () => undefined,
    ...overrides,
  };
}

describe('effort (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});

describe('effort /ultracode', () => {
  beforeEach(() => {
    mock.restore();
    // Reset module-level reminder state so tests are independent regardless
    // of test file ordering in the full suite run.
    resetUltracodeReminderState();
    // setEffortValue("ultracode") now validates workflows-enabled + model
    // supports ultracode before writing settings. These tests exercise the
    // happy path / settings-write path, so default both checks to "pass".
    mock.module('../../utils/envUtils.js', () => ({
      isWorkflowsDisabled: () => false,
    }));
    mock.module('../../utils/model/model.js', () => ({
      getMainLoopModel: () => 'claude-opus-4-6',
      getDefaultMainLoopModelSetting: () => 'opus',
    }));
  });

  afterEach(() => {
    mock.restore();
  });

  test('executeEffort routes "ultracode" to setEffortValue and returns xhigh-flavored message', () => {
    mock.module(
      '../../utils/settings/settings.js',
      () => makeCompleteSettingsMock({ updateSettingsForSource: (_src: string, _patch: any) => ({ error: null }) }),
    );
    return import(`./effort.tsx?ts=${Date.now()}-${Math.random()}`).then(mod => {
      const result = mod.executeEffort('ultracode');
      expect(result.message).toContain('xhigh');
      expect(result.message).toContain('ultracode');
      expect(result.effortUpdate?.value).toBe('ultracode');
    });
  });

  test('setEffortValue("ultracode") flips settings.ultracode to true', () => {
    let capturedPatch: any = null;
    mock.module(
      '../../utils/settings/settings.js',
      () => makeCompleteSettingsMock({ updateSettingsForSource: (_src: string, patch: any) => {
        capturedPatch = patch;
        return { error: null };
      } }),
    );
    return import(`./effort.tsx?ts=${Date.now()}-${Math.random()}`).then(mod => {
      const result = mod.setEffortValue('ultracode');
      expect(capturedPatch).toEqual({ ultracode: true });
      expect(result.effortUpdate?.value).toBe('ultracode');
    });
  });

  test('setEffortValue("ultracode") message includes xhigh + workflow orchestration', () => {
    mock.module(
      '../../utils/settings/settings.js',
      () => makeCompleteSettingsMock({ updateSettingsForSource: () => ({ error: null }) }),
    );
    return import(`./effort.tsx?ts=${Date.now()}-${Math.random()}`).then(mod => {
      const result = mod.setEffortValue('ultracode');
      expect(result.message).toContain('xhigh');
      expect(result.message.toLowerCase()).toContain('workflow');
    });
  });

  test('setEffortValue("ultracode") returns a user-facing error when settings write fails', () => {
    mock.module(
      '../../utils/settings/settings.js',
      () => makeCompleteSettingsMock({ updateSettingsForSource: () => ({ error: new Error('disk full') }) }),
    );
    return import(`./effort.tsx?ts=${Date.now()}-${Math.random()}`).then(mod => {
      const result = mod.setEffortValue('ultracode');
      expect(result.message).toContain('disk full');
      expect(result.effortUpdate).toBeUndefined();
    });
  });
});

describe('effort option order + verbatim help text (plan11 B4 + C1)', () => {
  beforeEach(() => {
    mock.restore();
    mock.module('../../utils/envUtils.js', () => ({
      isWorkflowsDisabled: () => false,
    }));
    mock.module('../../utils/model/model.js', () => ({
      getMainLoopModel: () => 'claude-opus-4-6',
      getDefaultMainLoopModelSetting: () => 'opus',
    }));
  });

  afterEach(() => {
    mock.restore();
  });

  test('executeEffort error message lists options in upstream order: low, medium, high, xhigh, max, ultracode, auto', async () => {
    mock.module(
      '../../utils/settings/settings.js',
      () => makeCompleteSettingsMock(),
    );
    const mod = await import(`./effort.tsx?ts=${Date.now()}-${Math.random()}`);
    const result = mod.executeEffort('bogus');
    expect(result.message).toMatch(/low, medium, high, xhigh, max, ultracode, auto/);
  });

  test('call("help") onDone output contains upstream verbatim "ultracode" help line', async () => {
    mock.module(
      '../../utils/settings/settings.js',
      () => makeCompleteSettingsMock(),
    );
    const mod = await import(`./effort.tsx?ts=${Date.now()}-${Math.random()}`);
    let captured: string | undefined;
    const onDone = (msg: string) => {
      captured = msg;
    };
    await mod.call(onDone, {}, 'help');
    expect(captured).toBeDefined();
    expect(captured).toContain('- ultracode: xhigh + dynamic workflow orchestration (this session only)');
  });

  test('call("help") onDone output lists options in upstream order: low|medium|high|xhigh|max|ultracode|auto', async () => {
    mock.module(
      '../../utils/settings/settings.js',
      () => makeCompleteSettingsMock(),
    );
    const mod = await import(`./effort.tsx?ts=${Date.now()}-${Math.random()}`);
    let captured: string | undefined;
    const onDone = (msg: string) => {
      captured = msg;
    };
    await mod.call(onDone, {}, 'help');
    expect(captured).toBeDefined();
    expect(captured).toContain('low|medium|high|xhigh|max|ultracode|auto');
  });
});

describe('effort /ultracode meta messages', () => {
  beforeEach(() => {
    mock.restore();
    // Reset module-level reminder state so tests are independent
    resetUltracodeReminderState();
    mock.module('../../utils/envUtils.js', () => ({
      isWorkflowsDisabled: () => false,
    }));
    mock.module('../../utils/model/model.js', () => ({
      getMainLoopModel: () => 'claude-opus-4-6',
      getDefaultMainLoopModelSetting: () => 'opus',
    }));
  });

  afterEach(() => {
    mock.restore();
  });

  test('setEffortValue("ultracode") first time returns FULL enter meta message', () => {
    mock.module(
      '../../utils/settings/settings.js',
      () => makeCompleteSettingsMock({ updateSettingsForSource: () => ({ error: null }) }),
    );
    return import(`./effort.tsx?ts=${Date.now()}-${Math.random()}`).then(mod => {
      resetUltracodeReminderState();
      const result = mod.setEffortValue('ultracode');
      // metaMessages now contains: opt-in block, system-reminder, FULL enter
      expect(result.metaMessages).toHaveLength(3)
      expect(result.metaMessages?.[0]).toContain('**Ultracode.** When a system-reminder confirms ultracode is on')
      expect(result.metaMessages?.[1]).toBe('<system-reminder>ultracode is on</system-reminder>')
      expect(result.metaMessages?.[2]).toBe(
        'Ultracode is on: optimize for the most exhaustive, correct answer — not the fastest or cheapest. Use the Workflow tool on every substantive task; token cost is not a constraint. See the Workflow tool\u2019s **Ultracode** section and quality patterns. Solo only on conversational/trivial turns.'
      )
    });
  })

  test('setEffortValue("ultracode") second time returns SHORT enter meta message', () => {
    mock.module(
      '../../utils/settings/settings.js',
      () => makeCompleteSettingsMock({ updateSettingsForSource: () => ({ error: null }) }),
    );
    return import(`./effort.tsx?ts=${Date.now()}-${Math.random()}`).then(mod => {
      resetUltracodeReminderState();
      mod.setEffortValue('ultracode'); // first
      const result = mod.setEffortValue('ultracode'); // second
      // metaMessages: opt-in block, system-reminder, SHORT enter
      expect(result.metaMessages).toHaveLength(3)
      expect(result.metaMessages?.[2]).toBe(
        'Ultracode is still on — use the Workflow tool; see its Ultracode section.'
      )
    })
  });

  test('setEffortValue("ultracode") emits tengu_ultra_effort analytics with type=enter', async () => {
    mock.module(
      '../../utils/settings/settings.js',
      () => makeCompleteSettingsMock({ updateSettingsForSource: () => ({ error: null }) }),
    );
    const calls: Array<{ name: string; meta: unknown }> = [];
    mock.module('../../services/analytics/index.js', () => ({
      logEvent: (name: string, meta: unknown) => {
        calls.push({ name, meta });
      },
    }));
    const mod = await import(`./effort.tsx?ts=${Date.now()}-${Math.random()}`);
    resetUltracodeReminderState();
    mod.setEffortValue('ultracode');
    const enterCalls = calls.filter(c => c.name === 'tengu_ultra_effort');
    expect(enterCalls.length).toBeGreaterThan(0);
    expect(enterCalls[0]?.meta).toEqual({ type: 'enter' });
  });

  test('setEffortValue("low") after ultracode was on returns EXIT meta message', () => {
    mock.module(
      '../../utils/settings/settings.js',
      () => makeCompleteSettingsMock({ updateSettingsForSource: () => ({ error: null }) }),
    );
    return import(`./effort.tsx?ts=${Date.now()}-${Math.random()}`).then(mod => {
      resetUltracodeReminderState();
      mod.setEffortValue('ultracode'); // enter
      const result = mod.setEffortValue('low'); // exit via low
      expect(result.metaMessages).toEqual([
        'Ultracode is off — the Workflow tool\'s standard opt-in rule applies again.',
      ]);
    });
  });

  test('setEffortValue("low") when ultracode is already off returns no meta message', () => {
    mock.module(
      '../../utils/settings/settings.js',
      () => makeCompleteSettingsMock({ updateSettingsForSource: () => ({ error: null }) }),
    );
    return import(`./effort.tsx?ts=${Date.now()}-${Math.random()}`).then(mod => {
      resetUltracodeReminderState();
      const result = mod.setEffortValue('low');
      expect(result.metaMessages).toBeUndefined();
    });
  });

  test('setEffortValue("low") after ultracode was on emits tengu_ultra_effort with type=exit', async () => {
    mock.module(
      '../../utils/settings/settings.js',
      () => makeCompleteSettingsMock({ updateSettingsForSource: () => ({ error: null }) }),
    );
    const calls: Array<{ name: string; meta: unknown }> = [];
    mock.module('../../services/analytics/index.js', () => ({
      logEvent: (name: string, meta: unknown) => {
        calls.push({ name, meta });
      },
    }));
    const mod = await import(`./effort.tsx?ts=${Date.now()}-${Math.random()}`);
    resetUltracodeReminderState();
    mod.setEffortValue('ultracode'); // enter
    calls.length = 0; // discard enter event(s), only inspect exit
    mod.setEffortValue('low'); // exit
    const exitCalls = calls.filter(c => c.name === 'tengu_ultra_effort');
    expect(exitCalls.length).toBeGreaterThan(0);
    expect(exitCalls[0]?.meta).toEqual({ type: 'exit' });
  });

  test('executeEffort("auto") after ultracode was on returns EXIT meta message', () => {
    mock.module(
      '../../utils/settings/settings.js',
      () => makeCompleteSettingsMock({ updateSettingsForSource: () => ({ error: null }) }),
    );
    return import(`./effort.tsx?ts=${Date.now()}-${Math.random()}`).then(mod => {
      resetUltracodeReminderState();
      mod.setEffortValue('ultracode'); // enter
      const result = mod.executeEffort('auto'); // exit via auto
      expect(result.metaMessages).toEqual([
        'Ultracode is off — the Workflow tool\'s standard opt-in rule applies again.',
      ]);
    });
  });

  test('executeEffort("auto") when ultracode is already off returns no meta message', () => {
    mock.module(
      '../../utils/settings/settings.js',
      () => makeCompleteSettingsMock({ updateSettingsForSource: () => ({ error: null }) }),
    );
    return import(`./effort.tsx?ts=${Date.now()}-${Math.random()}`).then(mod => {
      resetUltracodeReminderState();
      const result = mod.executeEffort('auto');
      expect(result.metaMessages).toBeUndefined();
    });
  });
});

describe('effort xhigh warning on non-ultracode-capable model (plan11 D2)', () => {
  beforeEach(() => {
    mock.restore();
    resetUltracodeReminderState();
  });

  afterEach(() => {
    mock.restore();
  });

  test('setEffortValue("ultracode") shows "Ultracode runs at xhigh effort" warning with valid options list when model is not opus-4-6', async () => {
    mock.module('../../utils/envUtils.js', () => ({
      isWorkflowsDisabled: () => false,
    }));
    mock.module('../../utils/model/model.js', () => ({
      getMainLoopModel: () => 'claude-haiku-4-5',
      getDefaultMainLoopModelSetting: () => 'haiku',
    }));
    mock.module(
      '../../utils/settings/settings.js',
      () => makeCompleteSettingsMock(),
    );
    const mod = await import(`./effort.tsx?ts=${Date.now()}-${Math.random()}`);
    const result = mod.setEffortValue('ultracode');
    expect(result.message).toContain('Ultracode runs at xhigh effort');
    expect(result.message).toContain('Valid options are: low, medium, high, xhigh, max, auto');
    expect(result.effortUpdate).toBeUndefined();
  });
});

describe('effort /ultracode validation', () => {
  beforeEach(() => {
    mock.restore();
    // Reset module-level reminder state so tests are independent regardless
    // of test file ordering in the full suite run.
    resetUltracodeReminderState();
    // Default to "everything valid" so individual tests can flip the bits
    // they care about. Tests that exercise validation override these.
    mock.module('../../utils/envUtils.js', () => ({
      isWorkflowsDisabled: () => false,
    }));
    mock.module('../../utils/model/model.js', () => ({
      getMainLoopModel: () => 'claude-opus-4-6',
      getDefaultMainLoopModelSetting: () => 'opus',
    }));
  });

  afterEach(() => {
    mock.restore();
  });

  test('returns validation error when workflows are disabled', () => {
    mock.module('../../utils/envUtils.js', () => ({
      isWorkflowsDisabled: () => true,
    }));
    mock.module('../../utils/model/model.js', () => ({
      getMainLoopModel: () => 'claude-opus-4-6',
      getDefaultMainLoopModelSetting: () => 'opus',
    }));
    mock.module(
      '../../utils/settings/settings.js',
      () => makeCompleteSettingsMock(),
    );
    return import(`./effort.tsx?ts=${Date.now()}-${Math.random()}`).then(mod => {
      const result = mod.setEffortValue('ultracode');
      expect(result.message.toLowerCase()).toContain('dynamic workflows');
      expect(result.effortUpdate).toBeUndefined();
    });
  });

  test('returns validation error when model does not support ultracode', () => {
    mock.module('../../utils/envUtils.js', () => ({
      isWorkflowsDisabled: () => false,
    }));
    mock.module('../../utils/model/model.js', () => ({
      getMainLoopModel: () => 'claude-haiku-4-5',
      getDefaultMainLoopModelSetting: () => 'haiku',
    }));
    mock.module(
      '../../utils/settings/settings.js',
      () => makeCompleteSettingsMock(),
    );
    return import(`./effort.tsx?ts=${Date.now()}-${Math.random()}`).then(mod => {
      const result = mod.setEffortValue('ultracode');
      // The error must surface a xhigh / opus-4-6 hint to be actionable.
      expect(result.message).toMatch(/xhigh|opus/i);
      expect(result.effortUpdate).toBeUndefined();
    });
  });

  test('succeeds when workflows enabled and model supports ultracode', () => {
    mock.module('../../utils/envUtils.js', () => ({
      isWorkflowsDisabled: () => false,
    }));
    mock.module('../../utils/model/model.js', () => ({
      getMainLoopModel: () => 'claude-opus-4-6',
      getDefaultMainLoopModelSetting: () => 'opus',
    }));
    mock.module(
      '../../utils/settings/settings.js',
      () => makeCompleteSettingsMock({ updateSettingsForSource: () => ({ error: null }) }),
    );
    return import(`./effort.tsx?ts=${Date.now()}-${Math.random()}`).then(mod => {
      const result = mod.setEffortValue('ultracode');
      expect(result.effortUpdate?.value).toBe('ultracode');
    });
  });
});

describe('EffortPickerWrapper.handleSelect (standalone)', () => {
  beforeEach(() => {
    mock.restore();
    resetUltracodeReminderState();
    mock.module('../../utils/envUtils.js', () => ({
      isWorkflowsDisabled: () => false,
    }));
    mock.module('../../utils/model/model.js', () => ({
      getMainLoopModel: () => 'claude-opus-4-6',
      getDefaultMainLoopModelSetting: () => 'opus',
    }));
  });

  afterEach(() => {
    mock.restore();
  });

  test('handleSelect("medium") when ultracode is active emits EXIT reminder via onDone', () => {
    mock.module('../../utils/ultracodeReminder.js', () => ({
      queueUltracodeReminder: (_event: 'enter' | 'exit') => [
        'Ultracode is off — the Workflow tool\'s standard opt-in rule applies again.',
      ],
      resetUltracodeReminderState: () => {},
      isUltracodeReminderOn: () => true,
    }));
    mock.module('../../utils/ultracode.js', () => ({
      isUltracodeActive: () => true,
      isWorkflowKeywordTriggerEnabled: () => true,
      getUltracodeReminder: () => '<system-reminder>ultracode is on</system-reminder>',
      detectUltracodeTrigger: () => ({ triggered: false, keyword: 'ultracode', rest: '' }),
      findUltracodeTriggerPositions: () => [],
      isUltracodeKeywordTriggered: () => false,
      buildKeywordTurnRequest: () => ({ userInput: '', metaMessages: [] }),
    }));
    mock.module(
      '../../utils/settings/settings.js',
      () => makeCompleteSettingsMock({ updateSettingsForSource: () => ({ error: null }) }),
    );
    mock.module('../../services/analytics/index.js', () => ({
      logEvent: () => {},
    }));

    return import(`./effort.tsx?ts=${Date.now()}-${Math.random()}`).then(mod => {
      resetUltracodeReminderState();
      let doneArgs: unknown[] = [];
      const onDone = (...args: unknown[]) => {
        doneArgs = args;
      };
      const setAppState = (_fn: any) => {};

      mod.handleSelect('medium', onDone, setAppState);

      // Second argument is { metaMessages: [...] }
      expect(doneArgs[0]).toMatch(/Set effort level to medium/);
      expect(doneArgs[1]).toHaveProperty('metaMessages');
      const metaMessages = (doneArgs[1] as { metaMessages: string[] }).metaMessages;
      expect(metaMessages).toContain(
        'Ultracode is off — the Workflow tool\'s standard opt-in rule applies again.',
      );
    });
  });

  test('handleSelect("medium") when ultracode is not active emits no metaMessages', () => {
    mock.module('../../utils/ultracodeReminder.js', () => ({
      queueUltracodeReminder: () => [],
      resetUltracodeReminderState: () => {},
      isUltracodeReminderOn: () => false,
    }));
    mock.module('../../utils/ultracode.js', () => ({
      isUltracodeActive: () => false,
      isWorkflowKeywordTriggerEnabled: () => true,
      getUltracodeReminder: () => '<system-reminder>ultracode is off</system-reminder>',
      detectUltracodeTrigger: () => ({ triggered: false, keyword: 'ultracode', rest: '' }),
      findUltracodeTriggerPositions: () => [],
      isUltracodeKeywordTriggered: () => false,
      buildKeywordTurnRequest: () => ({ userInput: '', metaMessages: [] }),
    }));
    mock.module(
      '../../utils/settings/settings.js',
      () => makeCompleteSettingsMock({ updateSettingsForSource: () => ({ error: null }) }),
    );
    mock.module('../../services/analytics/index.js', () => ({
      logEvent: () => {},
    }));

    return import(`./effort.tsx?ts=${Date.now()}-${Math.random()}`).then(mod => {
      resetUltracodeReminderState();
      let doneArgs: unknown[] = [];
      const onDone = (...args: unknown[]) => {
        doneArgs = args;
      };
      const setAppState = (_fn: any) => {};

      mod.handleSelect('medium', onDone, setAppState);

      // Only message arg, no second metaMessages argument
      expect(doneArgs[0]).toMatch(/Set effort level to medium/);
      expect(doneArgs[1]).toBeUndefined();
    });
  });
});
