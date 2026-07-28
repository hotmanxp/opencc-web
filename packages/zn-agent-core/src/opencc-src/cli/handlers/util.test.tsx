import { describe, expect, test } from 'bun:test';
import * as M from './util.js';

describe('util (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
