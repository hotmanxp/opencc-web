/**
 * Smoke test for the AASettings page — verifies it renders the disabled
 * state without crashing when the server returns `aa_disabled`. Other
 * states (connected, pairing, etc.) require fetch mocking which is
 * exercised end-to-end via T13 / manual QA.
 */
// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import AASettings from '../../src/web/src/pages/AASettings';

// `aaApi.getStatus` is the only network call on mount. Mock it to return
// `disabled` so we exercise the "restart with --aa" branch without
// needing a real server.
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

function renderWithProviders(ui: React.ReactNode) {
  return render(<ConfigProvider>{ui}</ConfigProvider>);
}

describe('AASettings page', () => {
  beforeEach(() => {
    // Provide a token so headers don't blow up if the page ever decides
    // to make another request.
    localStorage.setItem('zai-token', 'tok-test');
  });
  afterEach(() => {
    localStorage.removeItem('zai-token');
  });

  it('renders the disabled-state alert when AA is not enabled', async () => {
    renderWithProviders(<AASettings />);
    await waitFor(() => {
      expect(screen.getByText(/AA 桥未启用/)).toBeTruthy();
    });
    // Should show the "restart with --aa" hint
    expect(screen.getByText(/zai start --aa/)).toBeTruthy();
  });

  it('renders the page title with the AA icon', async () => {
    renderWithProviders(<AASettings />);
    await waitFor(() => {
      expect(screen.getByText('Agents Anywhere')).toBeTruthy();
    });
  });
});
