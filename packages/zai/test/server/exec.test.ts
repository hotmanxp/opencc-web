import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import execRouter from '../../src/server/routes/exec.js';

const app = express();
app.use(express.json());
app.use('/api', execRouter);

describe('POST /api/exec', () => {
  it('runs an allowed command and streams output', async () => {
    const res = await request(app)
      .post('/api/exec')
      .send({ cmd: 'echo', args: ['hello'] });
    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"start"');
    expect(res.text).toContain('hello');
    expect(res.text).toContain('"type":"exit"');
  });

  it('rejects disallowed commands', async () => {
    const res = await request(app)
      .post('/api/exec')
      .send({ cmd: 'rm', args: ['-rf', '/'] });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('command not allowed');
  });

  it('rejects missing cmd', async () => {
    const res = await request(app)
      .post('/api/exec')
      .send({ args: ['hello'] });
    expect(res.status).toBe(400);
  });

  it('defaults args to empty array', async () => {
    const res = await request(app)
      .post('/api/exec')
      .send({ cmd: 'pwd' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"exit"');
  });
});
