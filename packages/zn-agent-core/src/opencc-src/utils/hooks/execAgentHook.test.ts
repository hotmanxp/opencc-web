import { describe, expect, test } from 'bun:test';
import * as M from './execAgentHook.ts';

describe('execAgentHook (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
