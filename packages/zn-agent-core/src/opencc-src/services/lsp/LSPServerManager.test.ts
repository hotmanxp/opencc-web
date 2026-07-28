import { describe, expect, test } from 'bun:test';
import * as M from './LSPServerManager.js';

describe('LSPServerManager (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
