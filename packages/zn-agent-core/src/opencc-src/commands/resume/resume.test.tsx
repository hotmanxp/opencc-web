import { describe, expect, test } from 'bun:test';
import * as M from './resume.js';

describe('resume (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
