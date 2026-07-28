import { describe, expect, test } from 'bun:test';
import * as M from './WebSocketTransport.js';

describe('WebSocketTransport (import smoke)', () => {
  test('module loads without error', () => {
    expect(M).toBeDefined();
  });
});
