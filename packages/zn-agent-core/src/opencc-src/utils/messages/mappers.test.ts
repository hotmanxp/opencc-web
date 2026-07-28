import { describe, expect, test } from 'bun:test';
import * as M from './mappers.js';

describe('mappers (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
