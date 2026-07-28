import { describe, expect, test } from 'bun:test';
import * as M from './plan.js';

describe('plan (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
