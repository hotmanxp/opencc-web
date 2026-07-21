import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import systemRouter from '../../src/server/routes/system.js';

vi.mock('../../src/server/services/detect.js', () => ({
  getSystemInfo: async () => ({
    nodeVersion: 'v20.0.0',
    nodeMajor: 20,
    npmVersion: '10.0.0',
    npmPrefix: '/usr/local',
    npmRegistry: 'https://registry.npmjs.org/',
    npmBinInPath: true,
    platform: 'darwin',
  }),
}));

function makeApp(cwd: string, cwdName: string): express.Express {
  const app = express();
  app.locals.instanceContext = { cwd, cwdName };
  app.use('/api', systemRouter);
  return app;
}

describe('GET /api/system', () => {
  it('returns instance cwd and cwdName', async () => {
    const res = await request(makeApp('/tmp/project', 'project'))
      .get('/api/system');
    expect(res.status).toBe(200);
    expect(res.body.cwd).toBe('/tmp/project');
    expect(res.body.cwdName).toBe('project');
    expect(res.body.nodeVersion).toBe('v20.0.0');
  });

  it('returns correct cwdName for root path fallback', async () => {
    const res = await request(makeApp('/', '/'))
      .get('/api/system');
    expect(res.status).toBe(200);
    expect(res.body.cwd).toBe('/');
    expect(res.body.cwdName).toBe('/');
  });
});
