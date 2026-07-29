import { describe, expect, test } from 'bun:test';
import * as M from './NotebookEditTool.ts';

describe('NotebookEditTool (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
