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
 * Per-port scoping: each child has its own outbox so a backlog from one
 * noisy child doesn't head-of-line-block another.
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

  constructor(conn: AaConnection, port: number) {
    this.conn = conn;
    this.port = port;
  }

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
    await ensureAaDir();
    const path = aaOutboxPath(this.port);
    const line = JSON.stringify({
      method,
      payload,
      enqueuedAt: new Date().toISOString(),
    }) + '\n';
    await appendFile(path, line, 'utf-8');
    await this.enforceSizeCap(path);
  }

  /** Force a drain attempt. Returns the number of notifications replayed. */
  async maybeDrain(): Promise<number> {
    if (this.draining) return 0;
    if (this.conn.getStatus().state !== 'connected') return 0;
    const path = aaOutboxPath(this.port);
    if (!existsSync(path)) return 0;

    this.draining = true;
    try {
      const text = await readFile(path, 'utf-8');
      const lines = text.split('\n').filter((l) => l.trim().length > 0);
      if (lines.length === 0) return 0;

      let replayed = 0;
      const remaining: string[] = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as { method: string; payload: unknown };
          this.conn.sendNotification(entry.method, entry.payload);
          replayed++;
        } catch {
          // Corrupt line — drop it instead of blocking the queue.
          console.warn('[aa.offlineBuffer] dropping corrupt outbox line');
        }
      }
      // All entries consumed — clear the file. If sendNotification silently
      // dropped (because of a race where status flipped again), the next
      // tick re-reads the file and re-enqueues.
      await writeFile(path, '', 'utf-8');
      return replayed;
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
      const trimmed = lines.slice(keepFrom).join('\n');
      await writeFile(path, trimmed, 'utf-8');
      console.warn(
        `[aa.offlineBuffer] port ${this.port} outbox exceeded ${MAX_BYTES} bytes; ` +
        `dropped ${lines.length - keepFrom} oldest entries`,
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
