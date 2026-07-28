import { describe, expect, test } from 'bun:test';
import * as M from './ValidatePlugin.js';

describe('ValidatePlugin (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
