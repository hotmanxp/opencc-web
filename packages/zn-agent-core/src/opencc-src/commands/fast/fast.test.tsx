import { describe, expect, test } from 'bun:test';
import * as M from './fast.js';

describe('fast (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
