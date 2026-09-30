/**
 * /manage「AA 桥」tab gating.
 *
 * AA config only makes sense on a process started with `--aa`
 * (`GET /api/system` → `aaEnabled`, hydrated by Layout into
 * `useAppStore.instanceContext`). This test covers the two halves of the
 * gate: the tab is not rendered at all when the flag is off, and a stale
 * `?tab=aa` bookmark doesn't leave AntD pointing at a non-existent pane
 * (which renders a blank page area).
 *
 * The five tab panes are stubbed — this is about the tab list, not about
 * Config/Directory's own behaviour.
 */
// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import Manage from '../../src/web/src/pages/Manage';
import { useAppStore } from '../../src/web/src/store/useAppStore';

vi.mock('../../src/web/src/pages/Resources', () => ({ default: () => <div data-testid="pane-resources" /> }));
vi.mock('../../src/web/src/pages/Config', () => ({ default: () => <div data-testid="pane-config" /> }));
vi.mock('../../src/web/src/pages/Directory', () => ({ default: () => <div data-testid="pane-dirs" /> }));
vi.mock('../../src/web/src/pages/Tools', () => ({ default: () => <div data-testid="pane-tools" /> }));
vi.mock('../../src/web/src/pages/AASettings', () => ({ default: () => <div data-testid="pane-aa" /> }));

function setAaEnabled(aaEnabled: boolean) {
  useAppStore.getState().setInstanceContext({
    cwd: '/tmp',
    cwdName: 'tmp',
    branch: null,
    aaEnabled,
  });
}

function renderManage(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <ConfigProvider>
        <Manage />
      </ConfigProvider>
    </MemoryRouter>,
  );
}

describe('/manage AA 桥 tab gating', () => {
  beforeEach(() => {
    setAaEnabled(false);
  });

  it('hides the AA tab when the server explicitly says AA is off', () => {
    renderManage('/manage');
    expect(screen.getByRole('tab', { name: '工具' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'AA 桥' })).toBeNull();
  });

  it('shows the AA tab when the server says AA is on', () => {
    setAaEnabled(true);
    renderManage('/manage');
    expect(screen.getByRole('tab', { name: 'AA 桥' })).toBeTruthy();
  });

  it('shows the AA tab when the server is on the old build (aaEnabled missing — fail-open)', () => {
    // 老后端(`/api/system` 不回 aaEnabled)滚动期不能误藏 AA 入口。
    // instanceContext 没设 aaEnabled → undefined → !== false → 启用。
    useAppStore.getState().setInstanceContext({
      cwd: '/tmp',
      cwdName: 'tmp',
      branch: null,
    });
    renderManage('/manage');
    expect(screen.getByRole('tab', { name: 'AA 桥' })).toBeTruthy();
  });

  it('falls back to the config tab for a stale ?tab=aa bookmark when AA is off', () => {
    renderManage('/manage?tab=aa');
    expect(screen.queryByRole('tab', { name: 'AA 桥' })).toBeNull();
    // activeKey points at a tab that exists → the pane renders instead of a
    // blank area.
    expect(screen.getByTestId('pane-config')).toBeTruthy();
  });

  it('honours ?tab=aa when AA is on', () => {
    setAaEnabled(true);
    renderManage('/manage?tab=aa');
    expect(screen.getByTestId('pane-aa')).toBeTruthy();
  });
});
