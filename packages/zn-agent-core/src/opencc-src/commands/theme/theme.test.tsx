import { describe, expect, test } from 'bun:test';
import { call } from './theme.js';

describe('theme (render smoke)', () => {
  test('exports a callable component', () => {
    expect(call).toBeDefined();
  });
});
