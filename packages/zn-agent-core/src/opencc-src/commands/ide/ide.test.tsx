import { describe, expect, test } from 'bun:test';
import * as M from './ide.js';

describe('ide (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
