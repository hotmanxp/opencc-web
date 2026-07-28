import { describe, expect, test } from 'bun:test';
import * as M from './copy.js';

describe('copy (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
