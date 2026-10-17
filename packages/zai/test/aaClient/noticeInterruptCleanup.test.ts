/**
 * 回归测试 — AA 中断后 notice 卡片必须自动回收 (oc-003)。
 *
 * 缺陷:`session.interrupt` 只把 interrupt 转发给子进程,**不清理**
 * noticeStore 里该 zai 会话下挂着的 notice。回收只发生在
 * `handleInteractionRespond`(`resolveNotice`),而那条路要靠用户在 AA 侧
 * 真的点一下卡片才会走到 —— 于是「用户中断了会话 → 卡片还挂着 → 用户
 * 误点 → 一个已经没有 pending ask 的 toolUseId 被 forward 给子进程」。
 *
 * 另有一条独立的泄漏:`noticeStore` 是纯 Map,注册后除了被 respond 命中
 * 以外**永不回收**,没有任何 TTL —— 子进程侧那个 ask 若因为超时/重启/
 * 网络失败而消失,卡片就永远停在那里等一个永远不会来的回答。
 *
 * 修法:① `resolveNoticesForZaiSession(zaiSid)` 供 interrupt 路径调用;
 * ② `noticeStore` 加 TTL,读取时惰性过期。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Exec = (params: unknown) => Promise<unknown>;

const CHILD_PORT = 9451;
const AA_SESSION = 'sess-aa-1';
const ZAI_SESSION = 'sess-zai-1';

let dataDir: string;
const forwarded: { action: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'zai-aa-notice-'));
  process.env.ZAI_DATA_DIR = dataDir;
  process.env.ZAI_AA_ENABLED = '1';
  forwarded.length = 0;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.ZAI_DATA_DIR;
  delete process.env.ZAI_AA_ENABLED;
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** 装一个能跑通 resolveChildPort 的 ReverseDispatch,返回各 handler 表。 */
async function makeDispatch(): Promise<{ handlers: Map<string, Exec>; noticeStore: typeof import('../../src/server/services/aaClient/noticeStore.js') }> {
  const { ReverseDispatch } = await import('../../src/server/services/aaClient/reverseDispatch.js');
  const { initRuntimeRegistry } = await import('../../src/server/services/aaClient/runtimeRegistry.js');
  const noticeStore = await import('../../src/server/services/aaClient/noticeStore.js');
  noticeStore.resetNoticesForTests();

  const registry = initRuntimeRegistry({ sendNotification: () => undefined } as never);
  const handlers = new Map<string, Exec>();
  const conn = {
    onRequest: (m: string, h: Exec) => handlers.set(m, h),
    authenticate: async () => 'token',
    sendNotification: () => undefined,
  };
  const rd = new ReverseDispatch({
    conn: conn as never,
    registry: registry as never,
    serverUrl: 'https://aa.test',
    connectorId: 'conn_test',
  });
  // resolveChildPort TCP-probes the child; nothing listens here — stub the
  // probe (same pattern as protocolContract.test.ts / runtimeStartRouting.test.ts).
  (rd as unknown as { isPortListening: (p: number) => Promise<boolean> }).isPortListening =
    async () => true;
  rd.install();

  const { initSessionMap } = await import('../../src/server/services/aaClient/sessionMap.js');
  const sessionMap = initSessionMap();
  await sessionMap.put(CHILD_PORT, {
    aaSessionId: AA_SESSION,
    runtimeId: 'rti_test',
    zaiSessionId: ZAI_SESSION,
    createdAt: '2026-09-27T00:00:00.000Z',
    metadata: {},
  });
  (registry as unknown as { mappings: Record<string, unknown> }).mappings = {
    [String(CHILD_PORT)]: {
      runtimeId: 'rti_test',
      instanceId: 'inst_test',
      name: 'AA Test Project',
      port: CHILD_PORT,
      cwd: '/tmp/aa-test-cwd',
      registeredAt: '2026-09-27T00:00:00.000Z',
    },
  };

  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      action: string;
      zaiSessionId: string;
      payload: Record<string, unknown>;
    };
    forwarded.push({ action: body.action, body: body.payload });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  return { handlers, noticeStore };
}

function notice(id: string, zaiSid = ZAI_SESSION, aaSid = AA_SESSION) {
  return {
    notice: { noticeId: id, sessionId: aaSid, interactionType: 'permission_request' },
    childPort: CHILD_PORT,
    zaiSessionId: zaiSid,
    toolUseId: `toolu_${id}`,
  };
}

describe('oc-003: session.interrupt 必须回收该会话挂着的 notice', () => {
  it('中断后 noticeStore 里该 zai 会话的 notice 全部消失', async () => {
    const { handlers, noticeStore } = await makeDispatch();
    const interrupt = handlers.get('session.interrupt');
    expect(interrupt, 'session.interrupt must be installed').toBeTypeOf('function');

    noticeStore.registerNotice(notice('n1'));
    noticeStore.registerNotice(notice('n2'));
    expect(noticeStore.listNoticesForSession(AA_SESSION)).toHaveLength(2);

    await interrupt!({ sessionId: AA_SESSION, root: 'conn_test' });

    // 转发本身照旧发生(不能因为清理把功能改没了)
    expect(forwarded.map((f) => f.action)).toEqual(['interrupt']);

    // 判据:卡片不再挂着。没有这一步,用户只能靠误点才回收它。
    expect(noticeStore.listNoticesForSession(AA_SESSION)).toEqual([]);
    expect(noticeStore.getNotice('n1')).toBeNull();
    expect(noticeStore.getNotice('n2')).toBeNull();
  });

  it('中断只清自己会话的 notice,别的会话不受影响', async () => {
    const { handlers, noticeStore } = await makeDispatch();
    const interrupt = handlers.get('session.interrupt')!;

    noticeStore.registerNotice(notice('mine'));
    // 另一个 AA 会话 / 另一个 zai 会话上的卡片必须原样留着
    noticeStore.registerNotice({
      ...notice('other-aa', 'sess-zai-2', 'sess-aa-2'),
    });

    await interrupt({ sessionId: AA_SESSION, root: 'conn_test' });

    expect(noticeStore.getNotice('mine')).toBeNull();
    expect(noticeStore.getNotice('other-aa')).not.toBeNull();
  });
});

describe('oc-003: noticeStore 的 TTL 兜底', () => {
  it('超过 TTL 未被回答的 notice 不再被 listNoticesForSession 返回', async () => {
    const { noticeStore } = await makeDispatch();
    const nowSpy = vi.spyOn(Date, 'now');

    nowSpy.mockReturnValue(1_000_000);
    noticeStore.registerNotice(notice('old'));
    expect(noticeStore.listNoticesForSession(AA_SESSION)).toHaveLength(1);

    // 未到 TTL:仍在
    nowSpy.mockReturnValue(1_000_000 + noticeStore.NOTICE_TTL_MS - 1_000);
    expect(noticeStore.listNoticesForSession(AA_SESSION)).toHaveLength(1);

    // 过 TTL:惰性过期,不再回吐(否则 AA 会一直向一个已经没有 pending
    // ask 的 toolUseId 要回答)
    nowSpy.mockReturnValue(1_000_000 + noticeStore.NOTICE_TTL_MS + 1);
    expect(noticeStore.listNoticesForSession(AA_SESSION)).toEqual([]);
    expect(noticeStore.getNotice('old')).toBeNull();

    nowSpy.mockRestore();
  });
});
