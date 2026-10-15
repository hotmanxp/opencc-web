/**
 * initAaClient() 的进程角色门禁。
 *
 * 锁死一条真实事故:子实例(def.aa=false)从 supervisor 继承了 root 的
 * `ZAI_AA_ENABLED=1`,而 isChild 判定要求 `ZAI_AA_PARENT_URL` —— 两个条件
 * 同时落空时子实例会退化成第二个 AA root,拿同一个 connectorId 去连 AA 云,
 * 被 403 拒掉并每 5s 重试到永远(现场 9399 weixin / 9987 opencc-web 各刷了
 * 13~15 次,终端被 error 对象连 cause 栈糊成 25 行一屏)。
 *
 * 契约:
 *   - `inst_` 前缀 = 子实例,**永远**不该自己开 AA WS
 *   - 没有 parent URL = supervisor 没给它下发 AA(def.aa=false)→ 完全不初始化
 *   - `__current__` / 无 ZAI_INSTANCE_ID = root,才允许开 WS
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  process.env.ZAI_AA_ENABLED = '1';
  delete process.env.ZAI_AA_PARENT_URL;
  delete process.env.ZAI_AA_PARENT_PORT;
  delete process.env.ZAI_INSTANCE_ID;
  // childEventReporter 在模块加载时读一次 ZAI_AA_PARENT_URL 存进 ROOT_URL,
  // 每个用例都要按当次 env 重新 import。
  vi.resetModules();
});

afterEach(() => {
  delete process.env.ZAI_AA_ENABLED;
  delete process.env.ZAI_AA_PARENT_URL;
  delete process.env.ZAI_AA_PARENT_PORT;
  delete process.env.ZAI_INSTANCE_ID;
  vi.restoreAllMocks();
});

describe('initAaClient 进程角色门禁', () => {
  it('inst_ 子实例没有 parent URL 时不初始化 AA(不退化成第二个 root)', async () => {
    process.env.ZAI_INSTANCE_ID = 'inst_abc123';
    const { initAaClient } = await import('../../src/server/services/aaClient/init.js');
    const { getAaConnection, resetAaConnectionForTests } = await import(
      '../../src/server/services/aaClient/connection.js'
    );
    resetAaConnectionForTests();

    expect(await initAaClient()).toBeNull();
    // 关键断言:连接对象压根没建 —— 一次 WS 握手都没发起,不可能拿到 403
    expect(getAaConnection()).toBeNull();
  });

  it('inst_ 子实例有 parent URL 时走 child 路径,同样不建 AA 连接', async () => {
    process.env.ZAI_INSTANCE_ID = 'inst_abc123';
    process.env.ZAI_AA_PARENT_URL = 'http://127.0.0.1:9201';
    const { initAaClient } = await import('../../src/server/services/aaClient/init.js');
    const { getAaConnection, resetAaConnectionForTests } = await import(
      '../../src/server/services/aaClient/connection.js'
    );
    resetAaConnectionForTests();

    const shutdown = await initAaClient();
    expect(typeof shutdown).toBe('function');
    expect(getAaConnection()).toBeNull();
    await shutdown?.();
  });

  it('没有 ZAI_AA_ENABLED 时整个 AA 桥不启动', async () => {
    delete process.env.ZAI_AA_ENABLED;
    process.env.ZAI_INSTANCE_ID = '__current__';
    const { initAaClient } = await import('../../src/server/services/aaClient/init.js');
    const { getAaConnection, resetAaConnectionForTests } = await import(
      '../../src/server/services/aaClient/connection.js'
    );
    resetAaConnectionForTests();

    expect(await initAaClient()).toBeNull();
    expect(getAaConnection()).toBeNull();
  });
});
