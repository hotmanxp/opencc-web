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

function makeApp(cwd: string, cwdName: string, host = '127.0.0.1'): express.Express {
  const app = express();
  app.locals.instanceContext = { cwd, cwdName, host };
  app.use('/api', systemRouter);
  return app;
}

describe('GET /api/system — LAN share fields', () => {
  it('returns host field from instanceContext', async () => {
    process.env.ZAI_PORT = '9123';
    const res = await request(makeApp('/tmp/project', 'project', '0.0.0.0'))
      .get('/api/system');
    expect(res.status).toBe(200);
    expect(res.body.host).toBe('0.0.0.0');
    expect(res.body.port).toBe(9123);
    expect(Array.isArray(res.body.ips)).toBe(true);
    for (const ip of res.body.ips) {
      expect(ip).not.toContain('127.0.0.1');
      expect(ip).not.toContain(':');
    }
    delete process.env.ZAI_PORT;
  });

  it('returns default host=127.0.0.1 when not --lan', async () => {
    delete process.env.ZAI_PORT;
    const res = await request(makeApp('/tmp', 'tmp'))
      .get('/api/system');
    expect(res.status).toBe(200);
    expect(res.body.host).toBe('127.0.0.1');
    expect(res.body.port).toBe(0); // 无 env 时 port=0
  });
});