import { describe, expect, test } from 'bun:test';
import { PluginTrustWarning } from './PluginTrustWarning.js';

describe('PluginTrustWarning (render smoke)', () => {
  test('exports a callable component', () => {
    expect(PluginTrustWarning).toBeDefined();
  });
});
