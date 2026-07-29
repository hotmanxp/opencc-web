import { describe, expect, test } from 'bun:test';
import * as M from './LSPServerInstance.ts';

describe('LSPServerInstance (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
