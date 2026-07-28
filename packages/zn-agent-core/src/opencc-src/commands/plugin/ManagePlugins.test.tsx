import { describe, expect, test } from 'bun:test';
import * as M from './ManagePlugins.js';

describe('ManagePlugins (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
