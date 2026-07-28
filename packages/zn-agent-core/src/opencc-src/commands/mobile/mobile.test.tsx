import { describe, expect, test } from 'bun:test';
import * as M from './mobile.js';

describe('mobile (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
