/**
 * AASettings page — the AA (Agents Anywhere) config surface.
 *
 * The page only exists on a process started with `--aa`; the tab that hosts
 * it (/manage「AA 桥」) and the per-instance AA switch are both gated on the
 * same flag, so the only way to reach this component without AA is a stale
 * bookmark. That case must render nothing at all — the old "restart with
 * --aa" card is gone (it was pure noise for the ~all users who never pair).
 *
 * The enabled side (status / pairing form) needs `aaApi.getStatus` mocked;
 * the full pairing round-trip is exercised manually / e2e.
 */
// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import AASettings from '../../src/web/src/pages/AASettings';
import { aaApi, type AaConnectionState } from '../../src/web/src/lib/aaApi';

vi.mock('../../src/web/src/lib/aaApi', () => ({
  aaApi: {
    getStatus: vi.fn(async () => ({
      ok: true,
      data: { status: 'disabled', config: undefined, connection: undefined },
    })),
    startPairing: vi.fn(async () => ({ ok: true, data: { status: 'pending' } })),
    cancelPairing: vi.fn(async () => ({ ok: true, data: { status: 'cancelled' } })),
    pollPairing: vi.fn(async () => ({ ok: true, data: { status: 'pending' } })),
  },
}));

const getStatus = vi.mocked(aaApi.getStatus);

function statusReturning(status: AaConnectionState) {
  getStatus.mockImplementation(async () => ({
    ok: true as const,
    data: { status, config: undefined, connection: undefined },
  }));
}

function renderWithProviders(ui: React.ReactNode) {
  return render(<ConfigProvider>{ui}</ConfigProvider>);
}

describe('AASettings page', () => {
  beforeEach(() => {
    // Provide a token so headers don't blow up if the page ever decides
    // to make another request.
    localStorage.setItem('zai-token', 'tok-test');
    getStatus.mockReset();
  });
  afterEach(() => {
    localStorage.removeItem('zai-token');
  });

  it('renders nothing when the process started without --aa', async () => {
    statusReturning('disabled');
    const { container } = renderWithProviders(<AASettings />);
    await waitFor(() => {
      expect(getStatus).toHaveBeenCalled();
    });
    // Give the resolved state a tick to render (or not render) before asserting.
    await waitFor(() => {
      expect(container.innerHTML).toBe('');
    });
    expect(screen.queryByText('Agents Anywhere')).toBeNull();
  });

  it('stops polling once it learns AA is disabled', async () => {
    statusReturning('disabled');
    const { container } = renderWithProviders(<AASettings />);
    await waitFor(() => {
      expect(container.innerHTML).toBe('');
    });
    const callsAfterFirstTick = getStatus.mock.calls.length;
    // 'disabled' can only change across a process restart, so the 5s poll
    // loop must not keep hammering /api/aa/status behind a hidden page.
    await new Promise((r) => setTimeout(r, 50));
    expect(getStatus.mock.calls.length).toBe(callsAfterFirstTick);
  });

  it('renders the title and pairing form when AA is enabled but unpaired', async () => {
    statusReturning('unpaired');
    renderWithProviders(<AASettings />);
    await waitFor(() => {
      expect(screen.getByText('Agents Anywhere')).toBeTruthy();
    });
    expect(screen.getByText(/AA 服务器地址/)).toBeTruthy();
    expect(screen.getByText('启动配对')).toBeTruthy();
    // The old disabled-state hint must not reappear anywhere.
    expect(screen.queryByText(/AA 桥未启用/)).toBeNull();
    expect(screen.queryByText(/zai start --aa/)).toBeNull();
  });
});
