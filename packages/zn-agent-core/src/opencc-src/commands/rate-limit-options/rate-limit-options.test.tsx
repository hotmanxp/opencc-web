import { describe, expect, test } from 'bun:test';
import * as M from './rate-limit-options.js';

describe('rate-limit-options (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
