/**
 * Tests for AA protocol frame schemas and builders.
 *
 * Pure data-shape tests — no I/O. Validates that the zod schemas correctly
 * parse AA's wire format and that builders produce parseable output.
 */
import { describe, expect, it } from 'vitest';
import {
  InboundFrameSchema,
  NotificationFrameSchema,
  RequestFrameSchema,
  ResponseFrameSchema,
  SERVER_TO_ZAI_METHODS,
  ZAI_TO_SERVER_NOTIFICATIONS,
  buildNotification,
  buildRequest,
  buildResponse,
  buildResponseError,
} from '../../src/server/services/aaClient/protocol.js';

describe('protocol frame schemas', () => {
  it('parses Request frame', () => {
    const frame = RequestFrameSchema.parse({
      type: 'request',
      id: 'req_1',
      method: 'session.send_message',
      params: { sessionId: 'sess_x', content: 'hi' },
    });
    expect(frame.method).toBe('session.send_message');
  });

  it('parses ok Response frame', () => {
    const frame = ResponseFrameSchema.parse({
      type: 'response',
      id: 'req_1',
      ok: true,
      result: { status: 'ok' },
    });
    expect(frame.ok).toBe(true);
    if (frame.ok) expect(frame.result).toEqual({ status: 'ok' });
  });

  it('parses error Response frame', () => {
    const frame = ResponseFrameSchema.parse({
      type: 'response',
      id: 'req_1',
      ok: false,
      error: { code: 'rate_limit', message: 'too many requests' },
    });
    expect(frame.ok).toBe(false);
    if (!frame.ok) {
      expect(frame.error.code).toBe('rate_limit');
      expect(frame.error.message).toBe('too many requests');
    }
  });

  it('parses Notification frame', () => {
    const frame = NotificationFrameSchema.parse({
      type: 'notification',
      method: 'timeline.itemUpsert',
      params: { sessionId: 'sess_x' },
    });
    expect(frame.method).toBe('timeline.itemUpsert');
  });

  it('InboundFrameSchema discriminates by type', () => {
    const req = InboundFrameSchema.parse({
      type: 'request', id: '1', method: 'foo', params: {},
    });
    expect(req.type).toBe('request');
    const res = InboundFrameSchema.parse({
      type: 'response', id: '1', ok: true, result: null,
    });
    expect(res.type).toBe('response');
    const notif = InboundFrameSchema.parse({
      type: 'notification', method: 'bar', params: {},
    });
    expect(notif.type).toBe('notification');
  });

  it('rejects unknown frame type', () => {
    expect(() => InboundFrameSchema.parse({ type: 'garbage' })).toThrow();
  });

  it('rejects request with empty method', () => {
    expect(() =>
      RequestFrameSchema.parse({ type: 'request', id: '1', method: '' }),
    ).toThrow();
  });

  it('rejects response with both result and error', () => {
    expect(() =>
      ResponseFrameSchema.parse({
        type: 'response', id: '1', ok: true, result: null, error: { code: 'x', message: 'y' },
      }),
    ).toThrow();
  });
});

describe('frame builders', () => {
  it('buildRequest produces parseable output', () => {
    const frame = buildRequest('req_x', 'session.discover', { foo: 'bar' });
    expect(RequestFrameSchema.parse(frame)).toEqual(frame);
  });

  it('buildResponse produces parseable output', () => {
    const frame = buildResponse('req_x', { ok: 1 });
    expect(ResponseFrameSchema.parse(frame)).toEqual(frame);
  });

  it('buildResponseError produces parseable output', () => {
    const frame = buildResponseError('req_x', 'not_found', 'session gone');
    expect(ResponseFrameSchema.parse(frame)).toEqual(frame);
  });

  it('buildNotification produces parseable output', () => {
    const frame = buildNotification('session.state.updated', { sessionId: 's' });
    expect(NotificationFrameSchema.parse(frame)).toEqual(frame);
  });
});

describe('method whitelists', () => {
  it('server-to-zai methods include the key mobile-triggered actions', () => {
    expect(SERVER_TO_ZAI_METHODS).toContain('session.send_message');
    expect(SERVER_TO_ZAI_METHODS).toContain('session.steer');
    expect(SERVER_TO_ZAI_METHODS).toContain('session.interrupt');
    expect(SERVER_TO_ZAI_METHODS).toContain('interaction.respond');
    expect(SERVER_TO_ZAI_METHODS).toContain('runtime.discover');
  });

  it('zai-to-server notifications include heartbeat + timeline + notices', () => {
    expect(ZAI_TO_SERVER_NOTIFICATIONS).toContain('connector.heartbeat');
    expect(ZAI_TO_SERVER_NOTIFICATIONS).toContain('timeline.itemUpsert');
    expect(ZAI_TO_SERVER_NOTIFICATIONS).toContain('notice.upsert');
    expect(ZAI_TO_SERVER_NOTIFICATIONS).toContain('session.meta.upsert');
  });
});
