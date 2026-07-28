import { describe, expect, test } from 'bun:test';
import { call } from './session.js';

describe('session (render smoke)', () => {
  test('exports a callable component', () => {
    expect(call).toBeDefined();
  });
});
