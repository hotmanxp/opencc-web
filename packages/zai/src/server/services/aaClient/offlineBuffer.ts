/**
 * AA Offline Buffer — outbox-{port}.jsonl per child port.
 *
 * When the AA connection drops (network, server restart, auth expired),
 * outbound notifications can't be sent — they're lost unless we durably
 * queue them. This module:
 *
 *   1. Subscribes to AaConnection status transitions.
 *   2. When status flips to "reconnecting" / "closed", starts writing
 *      notifications to outbox-{port}.jsonl instead of attempting to send.
 *   3. When status flips back to "connected", drains the outbox in order,
 *      replaying each notification through the connection.
 *
 * Outbox scoping: ONE shared file per zai data dir. See the note below —
 * the earlier "per child" claim in this header was never implemented.
 *
 * zai patch (2026-10-17, cl-002):本文件此前有三处**互相矛盾**的注释,
 * 构成了这条缺陷的认知根源:
 *   - 这里的「Per-port scoping: each child has its own outbox so a backlog
 *     from one noisy child doesn't head-of-line-block another」
 *   - `init.ts`:「Each runtime_registry registration updates the active port
 *     to the most-recently-running child」
 *   - `connection.ts`:`sendNotification` 里「passing 0 here means let the
 *     buffer pick a representative port based on the most recent runtime
 *     registration」
 *
 * **实际行为**:生产只在 `init.ts:172` 调 `initOfflineBuffer(conn, 0)`,
 * 而 `setPort()`(见下)全仓零调用,所以 `port` 恒为 0 —— 没有「挑代表性端口」
 * 这回事,也没有 per-child 的文件拆分。
 *
 * 那么共用一个文件对不对?对 —— **单个 zai 进程只有一条 AA 连接**,
 * 它的待发队列本来就是一个有序列;`connection.ts` 里「AA server accepts
 * slight reordering across a reconnect window」那句论证是成立的。
 *
 * 真正的问题在**跨进程**:凡 argv 带 `--aa` 的进程(root 与各 child)各持
 * 一个 buffer 且 port 都是 0,于是都指向同一个 `outbox-0.jsonl`;而 `io`
 * 互斥是**进程内**的 Promise 链,跨进程为零。已修:`enforceSizeCap` 补上
 * 「重写前重读并合并并发新增」(`maybeDrain` 末尾早就有,当时漏了这条路径)。
 *
 * 若将来真要 per-child 拆分,`setPort()` 与三处注释都得一起改 ——
 * **别只改其中一处**,这正是本条缺陷的成因。
 *
 * Size cap: ZAI_AA_OUTBOX_MAX_MB (default 50MB) per port. When exceeded,
 * the oldest entries are dropped (FIFO trim) — better than failing
 * altogether.
 *
 * Idempotency: notifications aren't deduplicated here. The AA server's
 * timeline ingest (server/agent_server/services/timeline_ingest.py) uses
 * `id` as the dedup key, so the event adapter must set a stable id
 * (T6 follow-up ensures this). Replaying after reconnect is safe as long
 * as ids are stable.
 */
import { appendFile, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { aaOutboxPath, ensureAaDir } from '../paths.js';
import type { AaConnection, AaConnectionStatus } from './connection.js';

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const MAX_BYTES = Number(process.env.ZAI_AA_OUTBOX_MAX_MB ?? 50) * 1024 * 1024;

export class OfflineBuffer {
  private readonly conn: AaConnection;
  private port: number;
  private statusListenerInstalled = false;
  private draining = false;
  /**
   * zai patch (2026-10-16, tc-001): outbox 的**全部**读写都经这把互斥。
   *
   * 只修 `maybeDrain` 的「整体清空 → 只删已发送前缀」还不够:drain 末尾的
   * `writeFile` 与并发的 `enqueue` 的 `appendFile` 之间没有互斥时,
   * 晚于重写落盘的条目照样被覆盖。实测(临时探针,把 append 强行排在
   * writeFile 之后)确实复现。修法是让 enqueue 与 drain 排队,而不是
   * 各自直写同一个文件。
   *
   * 注意 `draining` 标志只挡**重入 drain**,不挡 enqueue —— 两者语义不同。
   */
  private io: Promise<unknown> = Promise.resolve();

  /** 把一段 outbox I/O 排队串行化,返回其结果。 */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.io.then(fn, fn);
    // 队列本身不因单个任务失败而中毒
    this.io = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  constructor(conn: AaConnection, port: number) {
    this.conn = conn;
    this.port = port;
  }

  /**
   * zai patch (2026-10-17, cl-002):**全仓零调用**。生产只在
   * `initOfflineBuffer(conn, 0)` 构造,`port` 因此恒为 0。
   *
   * 此前 `init.ts` 的注释声称「每次 runtime_registry 注册会更新 active
   * port」,本方法正是那个从未发生的更新的入口 —— 它从写下来那天起就没有
   * 任何调用方。保留它是因为 per-child 拆分仍是合理的后续方向,但**在有人
   * 真正调用它之前,别把它当成正在生效的隔离机制**。
   */
  setPort(port: number): void {
    this.port = port;
  }

  start(): void {
    if (this.statusListenerInstalled) return;
    this.conn.getStatus(); // touch to ensure singleton is alive
    // Poll-based status check (eventBus-style subscription would be cleaner
    // but AaConnection doesn't expose one — its status is a getter).
    const interval = setInterval(() => this.maybeDrain(), 1_000);
    interval.unref?.();
    this.statusListenerInstalled = true;
  }

  stop(): void {
    this.statusListenerInstalled = false;
  }

  /**
   * Enqueue a notification for delivery. Caller decides whether to call
   * this or send directly — typically the event adapter checks
   * connection status and routes here when disconnected.
   *
   * Format on disk: one JSON object per line (JSONL).
   *   { method: 'session.state.updated', payload: {...}, enqueuedAt: ISO }
   */
  async enqueue(method: string, payload: unknown): Promise<void> {
    // zai patch (2026-10-16, tc-001):与 maybeDrain 共用同一把互斥,否则
    // drain 末尾的整文件重写会覆盖掉并发 append 的条目。
    return this.serialize(async () => {
      await ensureAaDir();
      const path = aaOutboxPath(this.port);
      const line = JSON.stringify({
        method,
        payload,
        enqueuedAt: new Date().toISOString(),
      }) + '\n';
      await appendFile(path, line, 'utf-8');
      await this.enforceSizeCap(path);
    });
  }

  /** Force a drain attempt. Returns the number of notifications replayed. */
  async maybeDrain(): Promise<number> {
    if (this.draining) return 0;
    if (this.conn.getStatus().state !== 'connected') return 0;
    this.draining = true;
    try {
      // zai patch (2026-10-16, tc-001): 整个 drain 与 enqueue 共用同一把互斥。
      // 检查 `existsSync` 也要放进互斥内 —— 放外面的话,检查通过后到真正读
      // 文件之前仍可能被 enqueue 插入,而下面的整文件重写会把它抹掉。
      return await this.serialize(async () => {
        const path = aaOutboxPath(this.port);
        if (!existsSync(path)) return 0;

        const text = await readFile(path, 'utf-8');
        const lines = text.split('\n').filter((l) => l.trim().length > 0);
        if (lines.length === 0) return 0;

        // zai patch (2026-10-16, tc-001): 此前发完全部条目后 `writeFile(path, '')`
        // **整体清空**,而紧邻的注释声称「sendNotification 静默丢弃时下次 tick
        // 会重读并重新入队」—— 文件已清空,重读无从发生,注释与代码直接矛盾。
        //
        // 两条都真会丢数据的路径:
        //   1. 补发中途掉线:`sendNotification` 内部发现未连接会走 queueOffline
        //      把条目 append 回**同一个文件**,随后整体清空把它连同重入队那份
        //      一起抹掉(不依赖外部并发)。
        //   2. 并发 enqueue:drain 读文件期间新条目被 append,同样被清空。
        //
        // 改为行级事务:逐条发,只在**确认送达**时推进游标;凡未送达的一律留在
        // remaining 里重写回文件。截断发生在 mid-drain 时,已送达的前缀被移除,
        // 未送达的后缀原样留在文件里等下次 tick。
        let replayed = 0;
        const remaining: string[] = [];
        let deliveredAll = true;
        for (const line of lines) {
          // 断开后不再继续发 —— 剩下的全部留到下次 tick,避免「发了一半就断」
          // 造成前缀已删、后缀丢失的窗口。
          if (deliveredAll && this.conn.getStatus().state === 'connected') {
            try {
              const entry = JSON.parse(line) as { method: string; payload: unknown };
              this.conn.sendNotification(entry.method, entry.payload);
              replayed++;
              // sendNotification 对未连接是「静默转投 queueOffline」而非抛错,
              // 所以必须复查状态:一旦它已翻转,这条其实没送达,退回 remaining。
              if (this.conn.getStatus().state === 'connected') continue;
            } catch {
              // Corrupt line — drop it instead of blocking the queue.
              console.warn('[aa.offlineBuffer] dropping corrupt outbox line');
              continue;
            }
          }
          deliveredAll = false;
          remaining.push(line);
        }

        // 只重写「还没送出去的部分」,而不是清空整个文件。
        //
        // 但互斥**挡不住**一种写入:`sendNotification` 对未连接的条目会走
        // `void this.queueOffline(...)` 转投回同一文件,而 queueOffline 内部
        // 又 import 本模块调 enqueue —— 那次 enqueue 排在我们的 rewrite
        // **之后**(它在 sendNotification 里被 fire-and-forget 触发,此时
        // 互斥已被本 drain 持有)。所以「读完快照 → 发完 → 按快照重写」在
        // 掉线重投这条生产路径上仍会丢条目。
        //
        // 正确做法:重写前**重新读一次**当前文件,把本次 drain 期间新增的
        // 行(未送达的重投、以及任何漏网的 append)原样保留在后面。
        // 已送达的是 `lines` 的一个**前缀**,重读时按内容前缀剥离即可。
        const latest = existsSync(path)
          ? await readFile(path, 'utf-8')
          : '';
        const latestLines = latest.split('\n').filter((l) => l.trim().length > 0);
        const stillThere = new Set(lines);
        const appended = latestLines.filter((l) => !stillThere.has(l));

        const kept = [...remaining, ...appended];
        // 末尾补 '\n' 以维持 JSONL 逐行可切分的约定。
        await writeFile(path, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf-8');
        return replayed;
      });
    } catch (err) {
      console.warn('[aa.offlineBuffer] drain failed:', err);
      return 0;
    } finally {
      this.draining = false;
    }
  }

  private async enforceSizeCap(path: string): Promise<void> {
    try {
      const stats = await stat(path);
      if (stats.size <= MAX_BYTES) return;
      // Truncate to last MAX_BYTES worth of lines. Read, slice, rewrite.
      const text = await readFile(path, 'utf-8');
      const lines = text.split('\n');
      // Walk from the end until size fits.
      let keptSize = 0;
      let keepFrom = lines.length;
      for (let i = lines.length - 1; i >= 0; i--) {
        keptSize += lines[i]!.length + 1;
        if (keptSize > MAX_BYTES) {
          keepFrom = i + 1;
          break;
        }
      }
      const trimmed = lines.slice(keepFrom);
      // zai patch (2026-10-17, cl-002):重写前**重新读一次**,把本次裁剪
      // 期间由**别的进程**追加的行原样保留在后面 —— 与 `maybeDrain` 末尾
      // 同一模式(tc-001 修复时已在那里建立,这条路径当时漏了)。
      //
      // 为什么需要:凡 argv 带 `--aa` 的 zai 进程(root 与各 child,见
      // `instanceSupervisor` 的「子进程 env 说开 AA ⟺ argv 有 --aa」不变式)
      // 各自持有一个 OfflineBuffer,port 恒为 0,于是**都指向同一个
      // `$ZAI_DATA_DIR/aa/outbox-0.jsonl`**;而 `io` 互斥是**进程内**的
      // Promise 链,跨进程为零。不重读的话,别的进程在这个 read→write 窗口
      // 里 append 的通知会被整块抹掉 —— 而 FIFO 裁剪本意只是丢最老的。
      //
      // 保留下来可能又超限:那是预期的,下一轮 enqueue 再次触发 cap 时会
      // 重新裁剪。与 `maybeDrain` 的行为一致。
      const latest = existsSync(path) ? await readFile(path, 'utf-8') : '';
      const latestLines = latest.split('\n').filter((l) => l.trim().length > 0);
      const stillThere = new Set(lines);
      const appended = latestLines.filter((l) => !stillThere.has(l));
      const out = [...trimmed, ...appended];
      await writeFile(path, out.length > 0 ? `${out.join('\n')}\n` : '', 'utf-8');
      console.warn(
        `[aa.offlineBuffer] port ${this.port} outbox exceeded ${MAX_BYTES} bytes; ` +
        `dropped ${lines.length - keepFrom} oldest entries` +
        (appended.length ? ` (+${appended.length} concurrent, kept)` : ''),
      );
    } catch {
      // stat failed (file gone?) — nothing to do
    }
  }
}

let singleton: OfflineBuffer | null = null;

export function initOfflineBuffer(conn: AaConnection, port: number): OfflineBuffer {
  if (singleton) singleton.stop();
  singleton = new OfflineBuffer(conn, port);
  singleton.start();
  return singleton;
}

export function getOfflineBuffer(): OfflineBuffer | null {
  return singleton;
}

export function resetOfflineBufferForTests(): void {
  if (singleton) singleton.stop();
  singleton = null;
}

// Re-export AaConnectionStatus for callers that don't want to import
// from connection directly.
export type { AaConnectionStatus };
