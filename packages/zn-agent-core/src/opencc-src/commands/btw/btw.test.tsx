import { describe, expect, test } from 'bun:test';
import * as M from './btw.js';

describe('btw (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
