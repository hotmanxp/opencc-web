import { describe, expect, test } from 'bun:test';
import * as M from './bridge.js';

describe('bridge (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
