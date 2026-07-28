import { describe, expect, test } from 'bun:test';
import * as M from './setupPortable.js';

describe('setupPortable (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
