import { describe, expect, test } from 'bun:test';
import * as M from './thinkback.js';

describe('thinkback (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
