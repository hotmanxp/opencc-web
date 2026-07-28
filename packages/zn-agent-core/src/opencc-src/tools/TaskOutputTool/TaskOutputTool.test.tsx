import { describe, expect, test } from 'bun:test';
import * as M from './TaskOutputTool.js';

describe('TaskOutputTool (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
