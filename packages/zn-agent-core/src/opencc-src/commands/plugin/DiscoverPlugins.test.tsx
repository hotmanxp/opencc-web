import { describe, expect, test } from 'bun:test';
import * as M from './DiscoverPlugins.js';

describe('DiscoverPlugins (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
