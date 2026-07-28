import { describe, expect, test } from 'bun:test';
import * as M from './PluginSettings.js';

describe('PluginSettings (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
