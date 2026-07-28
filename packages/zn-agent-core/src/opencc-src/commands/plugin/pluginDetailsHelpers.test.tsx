import { describe, expect, test } from 'bun:test';
import * as M from './pluginDetailsHelpers.js';

describe('pluginDetailsHelpers (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
