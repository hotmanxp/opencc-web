import { describe, expect, test } from 'bun:test';
import * as M from './setupPortable.ts';

describe('setupPortable (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
