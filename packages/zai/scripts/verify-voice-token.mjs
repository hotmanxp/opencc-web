// 一次性验证脚本：真实挂载 voiceRouter，起在临时端口，curl getASRToken。
import express from 'express';
import voiceRouter from '../src/server/routes/voice.js';

const app = express();
app.use('/api', voiceRouter);
const server = app.listen(9956, '127.0.0.1', () => {
  console.log('listening 9956');
});
setTimeout(() => {
  fetch('http://127.0.0.1:9956/api/voice/getASRToken')
    .then(async (r) => {
      const j = await r.json();
      // 脱敏输出
      const mask = (s) => (typeof s === 'string' && s.length > 24 ? `<${s.length} chars>` : s);
      console.log('HTTP', r.status);
      console.log(JSON.stringify({
        ok: j.ok,
        dialect: j.dialect,
        endpoint: j.endpoint,
        accessToken: mask(j.accessToken),
        refreshToken: mask(j.refreshToken),
        uid: j.uid,
        nickname: j.nickname,
        expiresAt: j.expiresAt,
        error: j.error,
      }, null, 2));
      server.close();
      process.exit(0);
    })
    .catch((e) => { console.error('fetch fail:', e.message); server.close(); process.exit(1); });
}, 500);
