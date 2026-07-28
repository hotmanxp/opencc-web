import { describe, expect, test } from 'bun:test';
import * as M from './directConnectManager.js';

describe('directConnectManager (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
