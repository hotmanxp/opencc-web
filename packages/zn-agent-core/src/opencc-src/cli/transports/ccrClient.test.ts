import { describe, expect, test } from 'bun:test';
import * as M from './ccrClient.js';

describe('ccrClient (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
