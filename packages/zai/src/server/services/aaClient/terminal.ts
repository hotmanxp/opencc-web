/**
 * AA (Agents Anywhere) 远程终端 —— connector 侧实现。
 *
 * ## 为什么需要这一层
 *
 * AA 的远程终端走 `terminals-v2` 通道:客户端(手机 lan-agent / AA Web)先
 * `POST /connectors/{cid}/terminals-v2?root=…`,再开
 * `WS /connectors/{cid}/terminals-v2/{tid}/stream` 收发字节。AA 服务端把建终端
 * 那一步**转成 connector 侧的 WS RPC** 发过来(`terminal.create`),字节流则走
 * 另一条独立的 relay WebSocket。zai 此前一个 `terminal.*` 方法都没实现,手机侧
 * 表现为 `no handler for terminal.create`。
 *
 * 方法清单对齐官方 connector 的 `connector/connector/server/local_rpc.py`,
 * 出入参形状对齐 `connector/local/terminal.py` + `local/terminal_records.py`,
 * relay 帧协议对齐 `connector/server/terminal_relay.py`。
 *
 * ## 三个不能踩的约束
 *
 * 1. **`terminal.relay.connect` 必须回连一条独立 WS**,不能只在主 WS 上回 RPC。
 *    服务端 `TerminalRelayService.ensure()` 发出该 RPC 后只等
 *    `broker.wait_connector(terminal_id, timeout=10)` —— 它等的是我们主动连上
 *    `wss://<host>/api/v2/connector/terminals/{id}/relay?token=…`。不回连就直接
 *    `terminal relay did not connect`,手机侧终端空白。
 * 2. **PTY 必须跑在 root 进程**。AA 终端是 connector 级的
 *    (`sessionId = browse_{connectorId}`,server/services/terminal.py:50),不属于
 *    任何 zai 会话,所以直接用 root 的 `getTerminalService()`,不走 `forwardToChild`
 *    —— 那是一次性 HTTP POST,承载不了双向字节流。
 * 3. **错误码必须走 `terminalError(code, msg)`**。`connection.ts` 的 handleRequest
 *    读 `err.code` 填进 RPC `error.code`;`AaServerError` 没有 `code` 字段,会被
 *    填成 `AaServerError` 字面量。服务端只对 `terminal_not_found` 做 404 特判,
 *    其余 code 一律 502。
 */

import WebSocket from 'ws';
import { basename } from 'node:path';
import type { TerminalShell } from '../../../shared/terminal.js';
import { getTerminalService } from '../terminal/TerminalService.js';
import type { PtySession } from '../terminal/PtySession.js';
import {
  TerminalClosedError,
  TerminalNotFoundError,
  TerminalShellUnavailableError,
  ptyAvailability,
} from '../terminal/PtySession.js';
import { resolveShellPath, resolveDefaultShell, which } from '../terminal/shells.js';
import { logHttp } from '../accessLog.js';

// ─── 协议形状 ────────────────────────────────────────────────────────────

/** `terminal.create` 的 params(服务端已把 cwd resolve 成绝对路径)。 */
export interface AaTerminalCreateParams {
  terminalId?: string;
  sessionId?: string;
  root?: string;
  cwd?: string;
  shell?: string | null;
  command?: string | null;
  args?: string[];
  cols?: number;
  rows?: number;
  label?: string | null;
  persistent?: boolean;
  outputTransport?: string;
  /**
   * AA 侧的命名 profile 与环境变量。**刻意忽略**:
   * - `profile` 只影响默认 shell 的选择,而客户端的 shell 字段已经更具体;
   * - `env` 与 zai 自己的约定冲突 —— `PtySession` 透传完整登录环境正是为了
   *   nvm/pyenv/PATH(见 PtySession.ts::ptyEnv),让远端传进来的局部 env 覆盖
   *   它只会把用户的 shell 环境弄坏。
   */
  profile?: string | null;
  env?: Record<string, string> | null;
}

/** AA 的 terminal view(`terminal_records.py::terminal_view` 的形状)。 */
export interface AaTerminalView {
  terminalId: string;
  sessionId: string;
  label: string;
  purpose: 'user';
  pid: number | null;
  cwd: string;
  shell: string;
  closed: boolean;
  status: 'running' | 'exited';
  exitCode: number | null;
  cols: number;
  rows: number;
  scrollbackBytes: number;
  scrollbackSeq: number;
  persistent: boolean;
  createdAt: string;
}

// ─── 错误 ────────────────────────────────────────────────────────────────

/** 与 reverseDispatch 的 `aaError` 同形:`connection.ts` 读 `err.code` 填 RPC error。 */
function terminalError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const notFound = (id: string): Error =>
  terminalError('terminal_not_found', `terminal not found: ${id}`);

/** 把 zai 自己的终端异常翻译成 AA 认识的 code。 */
function translate(err: unknown, id: string): Error {
  if (err instanceof TerminalNotFoundError) return notFound(id);
  if (err instanceof TerminalShellUnavailableError) {
    return terminalError('invalid_config', `shell is not available: ${err.message}`);
  }
  if (err instanceof TerminalClosedError) return terminalError('terminal_closed', err.message);
  return err instanceof Error ? err : new Error(String(err));
}

function clampDim(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(500, Math.floor(n)));
}

/**
 * `command` + `args` → 一个起指定程序的 profile。
 *
 * 与登录 shell 不同,这里**不**加 `-i`:AA 发 `sh -c '…'` 或 `htop` 时,补一个
 * 交互参数会把命令变成它的第一个位置参数(`sh -i -c '…'` 尚可,`htop -i` 则直接
 * 报错)。官方 connector 的 `_default_argv` 只在**没给 command** 时才加 `-l`。
 */
function resolveCommandProfile(command: string, args: string[] | undefined): TerminalShell | null {
  const path = which(command);
  if (!path) return null;
  return { path, name: basename(command), args: [...(args ?? [])] };
}

/**
 * `shell` 字段 → profile。先走候选白名单(带 `-i`,读用户 rc),不在清单里再退回
 * `which` + 同样的交互式参数 —— AA 可能发一个本机装了但不在 SHELL_CANDINATES
 * 里的 shell。
 */
function resolveShellProfile(requested: string): TerminalShell | null {
  const known = resolveShellPath(requested);
  if (known) return known;
  const path = which(requested);
  if (!path) return null;
  return { path, name: basename(requested), args: ['-i'] };
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_LABEL = 'Shell';

// ─── 注册表 ──────────────────────────────────────────────────────────────

/** 每个 terminal 一条 AA 侧记录(PTY 之外的元数据 + 活跃 relay)。 */
interface AaTerminalRecord {
  id: string;
  sessionId: string;
  label: string;
  persistent: boolean;
  createdAt: string;
  relay: AaTerminalRelay | null;
}

/**
 * AA 终端注册表。
 *
 * owner key 用 `aa-terminal:<connectorId>` —— 与 zai 真实会话的 sessionId 命名
 * 空间隔离,`TerminalService` 的每 owner 8 终端上限也因此天然生效;进程退出时
 * `runtimeLifecycle.closeServer` 的 `disposeAll()` 覆盖到这些 PTY。
 */
export class AaTerminalRegistry {
  private readonly records = new Map<string, AaTerminalRecord>();
  readonly owner: string;
  private disposed = false;

  constructor(
    private readonly connectorId: string,
    private readonly serverUrl: string,
  ) {
    this.owner = `aa-terminal:${connectorId}`;
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────

  create(params: AaTerminalCreateParams): AaTerminalView {
    const id = (params.terminalId ?? '').trim();
    if (!id) throw terminalError('invalid_config', 'terminal.create: terminalId is required');
    if (this.disposed) throw terminalError('terminal_closed', 'terminal service is shutting down');
    // 幂等:AA 重试 create 时返回既有终端,不重复起 PTY。
    const existing = this.records.get(id);
    if (existing) return this.view(existing);

    const availability = ptyAvailability();
    if (!availability.available) {
      throw terminalError('terminal_unavailable', availability.reason ?? 'PTY 不可用');
    }

    // cwd:服务端已经 resolve 过(workspace.py::resolve_workspace_path),这里只兜底。
    const cwd = (params.cwd ?? params.root ?? '').trim() || process.cwd();
    const cols = clampDim(params.cols, DEFAULT_COLS);
    const rows = clampDim(params.rows, DEFAULT_ROWS);

    // shell 解析:AA 给 `shell`(可执行文件名/路径)或 `command`+`args`(起一个
    // 特定程序)。两者都可能是 SHELL_CANDIDATES 之外的二进制,所以最终走
    // `shellProfile` 这条受信通道,绕开 TerminalService 的候选白名单。
    const command = (params.command ?? '').trim();
    const requestedShell = (params.shell ?? '').trim();
    const profile = command
      ? resolveCommandProfile(command, params.args)
      : requestedShell
        ? resolveShellProfile(requestedShell)
        : resolveDefaultShell();
    if (!profile) {
      const what = command || requestedShell || '(系统默认 shell)';
      throw terminalError('invalid_config', `shell is not available: ${what}`);
    }

    const info = getTerminalService().createWithProfile(
      { sessionId: this.owner, id, cols, rows, cwd },
      profile,
    );
    // 打开原始字节流记录(relay 推帧要用)。普通分屏 tab 不开,免得每个终端
    // 白留最多 512KB base64。shell 此刻还没吐提示符,所以不会漏首屏。
    this.session(id)?.enableRawStream();

    const record: AaTerminalRecord = {
      id,
      sessionId: params.sessionId ?? this.owner,
      label: (params.label ?? '').trim() || info.title || DEFAULT_LABEL,
      persistent: params.persistent === true,
      createdAt: new Date().toISOString(),
      relay: null,
    };
    this.records.set(id, record);
    return this.view(record);
  }

  list(sessionId?: string): AaTerminalView[] {
    const out: AaTerminalView[] = [];
    for (const record of this.records.values()) {
      if (sessionId !== undefined && record.sessionId !== sessionId) continue;
      out.push(this.view(record));
    }
    return out;
  }

  rename(terminalId: string, label: string): AaTerminalView {
    const record = this.require(terminalId);
    const next = label.trim();
    if (!next) throw terminalError('invalid_config', 'label is required');
    getTerminalService().rename(this.owner, terminalId, next);
    record.label = next;
    return this.view(record);
  }

  setPersistent(terminalId: string, persistent: boolean): AaTerminalView {
    const record = this.require(terminalId);
    record.persistent = persistent;
    return this.view(record);
  }

  write(terminalId: string, dataBase64: string): { terminalId: string; bytesWritten: number } {
    this.require(terminalId);
    const data = Buffer.from(dataBase64, 'base64').toString('utf8');
    try {
      getTerminalService().write(this.owner, terminalId, data);
    } catch (err) {
      throw translate(err, terminalId);
    }
    return { terminalId, bytesWritten: Buffer.byteLength(data, 'utf8') };
  }

  async resize(
    terminalId: string,
    cols: number,
    rows: number,
  ): Promise<{ terminalId: string; cols: number; rows: number }> {
    this.require(terminalId);
    const nextCols = clampDim(cols, DEFAULT_COLS);
    const nextRows = clampDim(rows, DEFAULT_ROWS);
    try {
      await getTerminalService().resize(this.owner, terminalId, nextCols, nextRows);
    } catch (err) {
      throw translate(err, terminalId);
    }
    return { terminalId, cols: nextCols, rows: nextRows };
  }

  async close(terminalId: string): Promise<{ terminalId: string; closed: true }> {
    const record = this.records.get(terminalId);
    // AA 重复 DELETE 是幂等的:官方实现对未知 id 也回 `{closed:true}`。
    if (!record) return { terminalId, closed: true };
    record.relay?.stop();
    this.records.delete(terminalId);
    try {
      await getTerminalService().close(this.owner, terminalId);
    } catch (err) {
      if (!(err instanceof TerminalNotFoundError)) throw translate(err, terminalId);
    }
    return { terminalId, closed: true };
  }

  /** AA 连接断开 / 进程退出时收掉全部 relay 与 PTY。 */
  async disposeAll(): Promise<void> {
    this.disposed = true;
    for (const record of this.records.values()) record.relay?.stop();
    this.records.clear();
    await getTerminalService().disposeSession(this.owner);
  }

  // ── relay 接入点(供 AaTerminalRelay 与 reverseDispatch 调用) ───────────

  session(terminalId: string): PtySession | null {
    try {
      return getTerminalService().get(this.owner, terminalId);
    } catch {
      return null;
    }
  }

  relayOf(terminalId: string): AaTerminalRelay | null {
    return this.records.get(terminalId)?.relay ?? null;
  }

  /** 当前 view(未知 id 返回 null);relay 的 `snapshot` 响应要带它。 */
  viewOf(terminalId: string): AaTerminalView | null {
    const record = this.records.get(terminalId);
    return record ? this.view(record) : null;
  }

  /**
   * 为一个终端建 relay 并登记为当前活跃 relay(替换掉旧的)。
   *
   * 登记是必须的:`relayOf` 靠它做幂等判断,`close`/`disposeAll` 靠它停掉
   * 旧 socket —— 否则换 token 时上一条 relay 会变成没人管的野连接。
   */
  buildRelay(terminalId: string, token: string): AaTerminalRelay {
    const relay = new AaTerminalRelay(terminalId, token, this.serverUrl, this);
    const record = this.records.get(terminalId);
    if (record) record.relay?.stop();
    if (record) record.relay = relay;
    return relay;
  }

  private require(terminalId: string): AaTerminalRecord {
    const record = this.records.get(terminalId);
    if (!record) throw notFound(terminalId);
    return record;
  }

  private view(record: AaTerminalRecord): AaTerminalView {
    // PTY 可能已被回收(bulk GC / disposeSession);仍回一个 exited 的 view,
    // 让服务端把这条记录收敛掉,而不是收到异常。
    const session = this.session(record.id);
    const raw = session?.rawSnapshot(0, false);
    const running = session !== null && session.info.state === 'running';
    return {
      terminalId: record.id,
      sessionId: record.sessionId,
      label: record.label,
      purpose: 'user',
      // 官方 terminal_view 对已关闭的终端回 `pid: None`
      // (terminal_records.py:10) —— pid 已经不复存在,留着会让客户端显示一个
      // 指向死进程的「运行中」终端。
      pid: running ? (session?.pid ?? null) : null,
      cwd: session?.info.cwd ?? '',
      shell: session?.info.shell.path ?? '',
      closed: !running,
      status: running ? 'running' : 'exited',
      exitCode: session?.info.exitCode ?? null,
      cols: session?.info.cols ?? DEFAULT_COLS,
      rows: session?.info.rows ?? DEFAULT_ROWS,
      scrollbackBytes: raw?.scrollbackBytes ?? 0,
      scrollbackSeq: raw?.seq ?? 0,
      persistent: record.persistent,
      createdAt: record.createdAt,
    };
  }
}

// ─── relay 客户端 ────────────────────────────────────────────────────────

const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS = 5_000;
/** 无新输出时的兜底轮询间隔 —— 退出的记录也要靠它把 `exit` 帧发出去。 */
const PUMP_IDLE_MS = 1_000;

/** relay 帧(与 server/api/connector_ingress.py:808 的对端帧一一对应)。 */
interface RelayFrame {
  type: string;
  [key: string]: unknown;
}

/**
 * 一条 terminal 一条 relay WebSocket。
 *
 * 生命周期对齐官方 `TerminalRelayRunner`:传输层失败**不**杀 PTY(那是
 * `terminal.close` 的职责),只重连 relay;1008/4401/4404 是服务端的终态裁决
 * (token 无效 / 终端不存在),直接退出不再重试。
 */
export class AaTerminalRelay {
  private socket: WebSocket | null = null;
  private stopped = false;
  private reconnectDelay = RECONNECT_INITIAL_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pumpTimer: NodeJS.Timeout | null = null;
  private lastSeq = 0;
  private exitSent = false;
  private started = false;

  constructor(
    private readonly terminalId: string,
    private readonly token: string,
    private readonly serverUrl: string,
    private readonly registry: AaTerminalRegistry,
  ) {}

  /** 建立 relay 连接。幂等:重复调用不重连。 */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    try {
      this.socket?.close(1000, 'closed by connector');
    } catch {
      /* 已关闭 */
    }
    this.socket = null;
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.reconnectTimer = null;
    this.pumpTimer = null;
  }

  private relayUrl(): string {
    const url = new URL(this.serverUrl);
    const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const id = encodeURIComponent(this.terminalId);
    return `${scheme}//${url.host}/api/v2/connector/terminals/${id}/relay?token=${encodeURIComponent(this.token)}`;
  }

  private connect(): void {
    if (this.stopped) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.relayUrl(), { maxPayload: 4 * 1024 * 1024 });
    } catch (err) {
      logHttp(`[aa.terminal] relay connect threw for ${this.terminalId}: ${String(err)}`, 'warn');
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.on('message', (data) => this.onMessage(data.toString()));
    socket.on('error', (err) => {
      logHttp(`[aa.terminal] relay socket error for ${this.terminalId}: ${err.message}`, 'warn');
    });
    socket.on('close', (code) => {
      if (this.socket === socket) this.socket = null;
      this.clearTimers();
      if (this.stopped) return;
      if (code === 1008 || code === 4401 || code === 4404) {
        // 服务端终态裁决:token 无效或 terminal 不存在,重连没有意义。
        logHttp(
          `[aa.terminal] relay closed terminally code=${code} for ${this.terminalId}; not reconnecting`,
          'warn',
        );
        this.stopped = true;
        return;
      }
      logHttp(`[aa.terminal] relay closed code=${code} for ${this.terminalId}; reconnecting`, 'warn');
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private send(frame: RelayFrame): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(frame));
    } catch (err) {
      logHttp(`[aa.terminal] relay send failed: ${String(err)}`, 'warn');
    }
  }

  private onMessage(raw: string): void {
    let frame: RelayFrame;
    try {
      frame = JSON.parse(raw) as RelayFrame;
    } catch {
      return;
    }
    const requestId = typeof frame.requestId === 'string' ? frame.requestId : '';
    switch (frame.type) {
      case 'start':
        this.onStart(frame);
        return;
      case 'input':
        void this.respond(requestId, () =>
          this.registry.write(this.terminalId, String(frame.data ?? '')),
        );
        return;
      case 'resize':
        void this.respond(requestId, () =>
          this.registry.resize(
            this.terminalId,
            clampDim(frame.cols, DEFAULT_COLS),
            clampDim(frame.rows, DEFAULT_ROWS),
          ),
        );
        return;
      case 'snapshot':
        void this.respond(requestId, () => {
          const session = this.registry.session(this.terminalId);
          if (!session) throw notFound(this.terminalId);
          // **必须回全量 scrollback**(includeScrollback = true)。
          //
          // AA 服务端的 stream 端点只读 `dataBase64` 来发那一帧 replay,
          // **完全不看 `outputs`**(api/connector_terminal.py:555)。这里传 false
          // 等于把已缓冲的输出全丢掉:手机收到一个空 replay,而 shell 打完提示符
          // 就静默待命,屏幕永远一片黑。官方 connector 同样不传 include_scrollback
          // (terminal_relay.py:183),靠的正是默认值 True。
          const snap = session.rawSnapshot(Number(frame.fromSeq ?? 0), true);
          // `terminal` 不能省:服务端靠它判断这个终端是不是已经退出,决定要不要
          // 补发 exit 帧(connector_terminal.py:572-583)。缺了它,attach 到一个
          // 已死的终端时客户端会一直挂着。
          return {
            terminal: this.registry.viewOf(this.terminalId),
            baseSeq: snap.baseSeq,
            seq: snap.seq,
            outputs: snap.outputs,
            dataBase64: snap.dataBase64,
          };
        });
        return;
      case 'close':
        void this.respond(requestId, () => this.registry.close(this.terminalId));
        return;
      default:
        return;
    }
  }

  private async respond(requestId: string, run: () => unknown): Promise<void> {
    try {
      const result = await run();
      this.send({ type: 'response', requestId, ok: true, result });
    } catch (err) {
      const code = (err as { code?: string }).code === 'terminal_not_found' ? 404 : 422;
      this.send({
        type: 'response',
        requestId,
        ok: false,
        error: { code, message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  private onStart(frame: RelayFrame): void {
    const session = this.registry.session(this.terminalId);
    if (!session) {
      // 服务端认为这个 terminal 存在、我们没有 —— 断开,否则空转。
      logHttp(`[aa.terminal] relay start for unknown terminal ${this.terminalId}; closing`, 'warn');
      this.stop();
      return;
    }
    // 尺寸以 start 帧为准:create 时 AA 记的 cols/rows 可能与实际 spawn 的不同。
    const cols = clampDim(frame.cols, session.info.cols);
    const rows = clampDim(frame.rows, session.info.rows);
    if (cols !== session.info.cols || rows !== session.info.rows) {
      void this.registry.resize(this.terminalId, cols, rows).catch(() => undefined);
    }
    this.reconnectDelay = RECONNECT_INITIAL_MS;
    // 重连要重新宣告一次终态:官方每条连接各自推导 `exited`
    // (terminal_relay.py:110),否则重连到已退出的 PTY 上,客户端永远等不到
    // 那个 exit 帧。
    this.exitSent = false;
    logHttp(
      `[aa.terminal] relay start terminal=${this.terminalId} pid=${session.pid ?? 'null'} ` +
        `state=${session.info.state} cols=${session.info.cols} rows=${session.info.rows}`,
      'debug',
    );
    this.send({ type: 'ready', pid: session.pid ?? null });
    this.pump();
  }

  /**
   * 把 PTY 新增的原始字节转成 `output` 帧推给服务端。
   *
   * 没有走 `PtySession.follow()`:那条路给的是 headless 屏幕帧,而 AA 客户端按
   * `seq` 去重(丢弃 `seq <= lastSeq`),必须推**原始字节 + 单调 seq**。
   *
   * 连上后的第一拍发**全量 `replay`**(客户端据此重置并重写整屏),之后只发
   * `seq > lastSeq` 的增量;只有环形缓冲把客户端要的起点挤掉了才退回 `replay`。
   * `lastSeq` 跨重连保留 —— 服务端 broker 与浏览器都各自记着最后 seq,归零反而
   * 会让服务端拒收(它按 `seq <= last_seq` 丢弃)。
   */
  private pump(): void {
    let first = true;
    const tick = (): void => {
      if (this.stopped || this.socket?.readyState !== WebSocket.OPEN) return;
      const session = this.registry.session(this.terminalId);
      if (!session) {
        // 记录已经没了 —— 用 reason:"closed" 让服务端把 broker 里的这条也
        // 收掉(ingress.py:868-870 只在 closed 时 remove)。
        if (!this.exitSent) {
          this.exitSent = true;
          this.send({ type: 'exit', exitCode: null, reason: 'closed' });
        }
        this.stop();
        return;
      }
      const gapped = this.lastSeq < session.rawSnapshot(this.lastSeq, false).baseSeq;
      if (first || gapped) {
        const full = session.rawSnapshot(this.lastSeq, true);
        this.send({ type: 'replay', seq: full.seq, data: full.dataBase64 });
        this.lastSeq = full.seq;
      } else {
        for (const chunk of session.rawSnapshot(this.lastSeq, false).outputs) {
          this.send({ type: 'output', seq: chunk.seq, data: chunk.dataBase64 });
          this.lastSeq = chunk.seq;
        }
      }
      first = false;
      if (!this.exitSent && session.info.state !== 'running') {
        this.exitSent = true;
        this.send({ type: 'exit', exitCode: session.info.exitCode, reason: 'exit' });
        return;
      }
      this.pumpTimer = setTimeout(tick, PUMP_IDLE_MS);
      this.pumpTimer.unref?.();
    };
    tick();
  }
}
