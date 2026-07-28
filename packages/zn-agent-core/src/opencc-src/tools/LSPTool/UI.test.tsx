import { describe, expect, test } from 'bun:test';
import * as M from './UI.js';

describe('UI (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
