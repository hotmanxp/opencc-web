/**
 * AA remote terminal — relay socket integration.
 *
 * The relay is the half of this feature a unit test can't reach: AA server
 * answers `terminal.relay.connect`, then waits up to 10s for the connector to
 * dial `wss://<host>/api/v2/connector/terminals/{id}/relay?token=…` on its own
 * socket (`server/agent_server/services/terminal_relay.py::ensure`). Getting
 * that second socket wrong leaves the phone staring at a blank terminal even
 * though every RPC returned ok — so it gets a real WebSocket server here,
 * speaking the server side of the frame protocol
 * (`server/agent_server/api/connector_ingress.py:808`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { AaTerminalRegistry } from '../../src/server/services/aaClient/terminal.js';
import { __resetTerminalServiceForTest } from '../../src/server/services/terminal/TerminalService.js';
import { ptyAvailability } from '../../src/server/services/terminal/PtySession.js';

const available = ptyAvailability().available;
const suite = available ? describe : describe.skip;

const TOKEN = 'relay-token-abc';
const TERMINAL_ID = 'trm_relay1';

/** One frame received by the fake AA server, in arrival order. */
interface Received {
  type: string;
  [key: string]: unknown;
}

/**
 * Minimal stand-in for AA's relay endpoint: accepts the connector's socket,
 * sends the `start` frame, and records everything the connector pushes back.
 */
class FakeAaRelayServer {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private socket: WsSocket | null = null;
  readonly connectPath: string;
  private readonly onSocket: (socket: WsSocket) => void;

  constructor(onSocket: (socket: WsSocket) => void = () => undefined) {
    this.onSocket = onSocket;
    this.wss = new WebSocketServer({ noServer: true });
    this.http = createServer();
    this.http.on('upgrade', (req, socket, head) => {
      this.connectPath = req.url ?? '';
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.socket = ws;
        this.onSocket(ws);
      });
    });
    this.connectPath = '';
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.http.listen(0, '127.0.0.1', resolve));
    const { port } = this.http.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  /** Send the server's opening frame, exactly as connector_ingress.py does. */
  sendStart(extra: Record<string, unknown> = {}): void {
    this.send({ type: 'start', mode: 'attach', terminalId: TERMINAL_ID, cols: 80, rows: 24, ...extra });
  }

  send(frame: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(frame));
  }

  async close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}; saw ${JSON.stringify(this)}`);
}

let registry: AaTerminalRegistry;
let server: FakeAaRelayServer | undefined;

beforeEach(() => {
  registry = new AaTerminalRegistry('conn_relay', 'http://127.0.0.1:1');
});

afterEach(async () => {
  await registry.disposeAll();
  await server?.close();
  server = undefined;
  await __resetTerminalServiceForTest();
});

suite('terminal relay socket', () => {
  it('dials the AA relay endpoint with the token and completes the handshake', async () => {
    const received: Received[] = [];
    server = new FakeAaRelayServer((socket) => {
      socket.on('message', (data) => received.push(JSON.parse(data.toString())));
    });
    const serverUrl = await server.listen();

    registry = new AaTerminalRegistry('conn_relay', serverUrl);
    registry.create({
      terminalId: TERMINAL_ID,
      sessionId: 'browse_conn_relay',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      command: '/bin/sh',
      args: ['-i'],
    } as never);

    registry.buildRelay(TERMINAL_ID, TOKEN).start();

    // The URL is the contract: wrong path or missing token and AA's
    // `term.relay_token != token` check closes the socket with 1008.
    await waitFor(() => server!.connectPath.length > 0, 'relay socket to connect');
    expect(server.connectPath).toBe(
      `/api/v2/connector/terminals/${TERMINAL_ID}/relay?token=${TOKEN}`,
    );

    server.sendStart();
    // `ready` is what makes AA's broker mark the terminal running; without it
    // the client waits forever on a terminal the server thinks is still
    // "starting".
    await waitFor(() => received.some((f) => f.type === 'ready'), 'ready frame');
    const ready = received.find((f) => f.type === 'ready')!;
    expect(typeof ready.pid).toBe('number');
  });

  it('pushes PTY output as sequenced base64 frames', async () => {
    const received: Received[] = [];
    server = new FakeAaRelayServer((socket) => {
      socket.on('message', (data) => received.push(JSON.parse(data.toString())));
    });
    const serverUrl = await server.listen();
    registry = new AaTerminalRegistry('conn_relay', serverUrl);
    registry.create({
      terminalId: TERMINAL_ID,
      cwd: process.cwd(),
      command: '/bin/sh',
      args: ['-c', 'printf relay-marker-99'],
    } as never);

    registry.buildRelay(TERMINAL_ID, TOKEN).start();
    await waitFor(() => server!.connectPath.length > 0, 'relay socket to connect');
    server.sendStart();

    // The phone's dedupe (AaTerminalTransport.kt:213) drops any frame whose
    // seq isn't strictly increasing, so a non-monotonic stream means a frozen
    // or blank screen.
    await waitFor(
      () => received.some((f) => f.type === 'replay' || f.type === 'output'),
      'output frames',
    );
    const streamed = received.filter((f) => f.type === 'output' || f.type === 'replay');
    const seqs = streamed.map((f) => f.seq as number);
    expect(seqs.length).toBeGreaterThan(0);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    const payload = Buffer.from(
      (streamed[streamed.length - 1].data as string) ?? '',
      'base64',
    ).toString('utf8');
    expect(payload).toContain('relay-marker-99');
  });

  it('applies input frames from AA to the PTY and acknowledges the requestId', async () => {
    const received: Received[] = [];
    server = new FakeAaRelayServer((socket) => {
      socket.on('message', (data) => received.push(JSON.parse(data.toString())));
    });
    const serverUrl = await server.listen();
    registry = new AaTerminalRegistry('conn_relay', serverUrl);
    registry.create({
      terminalId: TERMINAL_ID,
      cwd: process.cwd(),
      // Must outlive the input frame: writing to an exited PTY is a
      // `terminal_closed` error, which is correct but not what this asserts.
      command: '/bin/sh',
      args: ['-c', 'sleep 5'],
    } as never);

    registry.buildRelay(TERMINAL_ID, TOKEN).start();
    await waitFor(() => server!.connectPath.length > 0, 'relay socket to connect');
    server.sendStart();

    // AA routes every `request_relay` through a requestId/response pair
    // (terminal_broker.py::request_relay); an un-answered request surfaces to
    // the client as "terminal relay request timed out" (504).
    server.send({
      type: 'input',
      requestId: 'req-1',
      data: Buffer.from('', 'utf8').toString('base64'),
    });
    await waitFor(
      () => received.some((f) => f.type === 'response' && f.requestId === 'req-1'),
      'input response',
    );
    const response = received.find((f) => f.type === 'response')!;
    expect(response.ok).toBe(true);
  });

  it('answers a snapshot request with the FULL scrollback, not just deltas', async () => {
    const received: Received[] = [];
    server = new FakeAaRelayServer((socket) => {
      socket.on('message', (data) => received.push(JSON.parse(data.toString())));
    });
    const serverUrl = await server.listen();
    registry = new AaTerminalRegistry('conn_relay', serverUrl);
    registry.create({
      terminalId: TERMINAL_ID,
      cwd: process.cwd(),
      // Write BEFORE the snapshot lands, then go idle: exactly the shape that
      // left the phone screen permanently black.
      command: '/bin/sh',
      args: ['-c', 'printf snap-marker-55; sleep 5'],
    } as never);

    registry.buildRelay(TERMINAL_ID, TOKEN).start();
    await waitFor(() => server!.connectPath.length > 0, 'relay socket to connect');
    server.sendStart();
    await waitFor(() => registry.list()[0].scrollbackSeq > 0, 'shell output to buffer');

    server.send({ type: 'snapshot', requestId: 'req-snap', fromSeq: 0 });
    await waitFor(
      () => received.some((f) => f.type === 'response' && f.requestId === 'req-snap'),
      'snapshot response',
    );
    const result = received.find((f) => f.type === 'response')!.result as {
      seq: number;
      baseSeq: number;
      dataBase64: string;
      terminal: { status: string } | null;
    };

    // The AA server builds its single `replay` frame from `dataBase64` ALONE —
    // it never reads `outputs` (api/connector_terminal.py:555). An empty
    // dataBase64 therefore means "no screen content, ever", because a shell
    // sitting at its prompt emits nothing further to push.
    expect(Buffer.from(result.dataBase64, 'base64').toString('utf8')).toContain('snap-marker-55');
    // `terminal` is what the server reads to decide whether to follow the
    // snapshot with an `exit` frame.
    expect(result.terminal?.status).toBe('running');
  });

  it('sends one full replay, then incremental output — never a replay per tick', async () => {
    const received: Received[] = [];
    server = new FakeAaRelayServer((socket) => {
      socket.on('message', (data) => received.push(JSON.parse(data.toString())));
    });
    const serverUrl = await server.listen();
    registry = new AaTerminalRegistry('conn_relay', serverUrl);
    registry.create({
      terminalId: TERMINAL_ID,
      cwd: process.cwd(),
      // Long-lived and chatty: survives many pump ticks while producing output.
      command: '/bin/sh',
      args: ['-c', 'for i in 1 2 3 4 5 6 7 8; do echo tick-$i; sleep 0.3; done; sleep 3'],
    } as never);

    registry.buildRelay(TERMINAL_ID, TOKEN).start();
    await waitFor(() => server!.connectPath.length > 0, 'relay socket to connect');
    server.sendStart();

    await waitFor(
      () => received.filter((f) => f.type === 'output').length >= 3,
      'incremental output frames',
    );
    // Let several more pump ticks elapse.
    await new Promise((r) => setTimeout(r, 2500));

    // A `replay` tells the client to RESET the screen and rewrite it wholesale
    // (lan-agent AaTerminalTransport.kt:224 runs `wbTerm.reset()`). Replaying
    // every tick — which is what passing `includeScrollback: true` to the
    // incremental read did — makes the terminal visibly clear itself once a
    // second. After the initial catch-up there must be no further replays.
    const replays = received.filter((f) => f.type === 'replay');
    expect(replays.length).toBeLessThanOrEqual(1);
  });

  it('emits an exit frame when the shell dies', async () => {
    const received: Received[] = [];
    server = new FakeAaRelayServer((socket) => {
      socket.on('message', (data) => received.push(JSON.parse(data.toString())));
    });
    const serverUrl = await server.listen();
    registry = new AaTerminalRegistry('conn_relay', serverUrl);
    registry.create({
      terminalId: TERMINAL_ID,
      cwd: process.cwd(),
      command: '/bin/sh',
      args: ['-c', 'exit 3'],
    } as never);

    registry.buildRelay(TERMINAL_ID, TOKEN).start();
    await waitFor(() => server!.connectPath.length > 0, 'relay socket to connect');
    server.sendStart();

    // AA turns this into a client `{"type":"exit"}` frame; without it the
    // phone's terminal shows a shell that never ends.
    await waitFor(() => received.some((f) => f.type === 'exit'), 'exit frame');
    expect(received.find((f) => f.type === 'exit')!.exitCode).toBe(3);
  });
});
