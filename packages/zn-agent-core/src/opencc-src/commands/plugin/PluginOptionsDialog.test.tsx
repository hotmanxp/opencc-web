import { describe, expect, test } from 'bun:test';
import * as M from './PluginOptionsDialog.js';

describe('PluginOptionsDialog (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
