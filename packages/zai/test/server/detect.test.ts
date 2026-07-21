import { describe, it, expect } from 'vitest';
import { getSystemInfo, getCliStatuses } from '../../src/server/services/detect.js';

describe('getSystemInfo', () => {
  it('returns current Node version and major', async () => {
    const info = await getSystemInfo();
    expect(info.nodeVersion).toMatch(/^v\d+\.\d+\.\d+/);
    expect(info.nodeMajor).toBeGreaterThanOrEqual(20);
  });

  it('returns npm version if installed', async () => {
    const info = await getSystemInfo();
    if (info.npmVersion) {
      expect(info.npmVersion).toMatch(/^\d+\./);
    }
  });

  it('returns npm prefix and registry', async () => {
    const info = await getSystemInfo();
    expect(info.npmPrefix).toBeTruthy();
    expect(info.npmRegistry).toBeTruthy();
  });
});

describe('getCliStatuses', () => {
  it('returns 5 entries with expected names', async () => {
    // getCliStatuses now shells out to `npm view` + `npm ls` for each CLI
    // (8 calls in parallel). Allow plenty of headroom for slow registries.
    const list = await getCliStatuses();
    const names = list.map((c) => c.name);
    expect(names).toContain('nova');
    expect(names).toContain('opencode');
    expect(names).toContain('opencc');
    expect(names).toContain('agent-login');
    expect(names).toContain('codegraph');
  }, 30000);

  it('each entry has installed boolean and optional path', async () => {
    const list = await getCliStatuses();
    for (const c of list) {
      expect(typeof c.installed).toBe('boolean');
      if (c.installed) {
        expect(c.path).toBeTruthy();
      }
      // New fields must always be present (nullable) so the frontend
      // doesn't have to defensively check `in`.
      expect(c).toHaveProperty('currentVersion');
      expect(c).toHaveProperty('latestVersion');
    }
  }, 30000);
});
