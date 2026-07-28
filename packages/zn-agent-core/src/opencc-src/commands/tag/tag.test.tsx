import { describe, expect, test } from 'bun:test';
import * as M from './tag.js';

describe('tag (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
