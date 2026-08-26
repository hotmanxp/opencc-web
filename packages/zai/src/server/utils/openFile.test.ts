// @vitest-environment node
import { describe, expect, test, vi, beforeEach } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { openWithSystem } from './openFile.js';

type ChildListener = (err?: Error) => void;
function makeChild() {
  const listeners: Record<string, ChildListener | undefined> = {};
  const child = {
    once: (ev: string, cb: ChildListener) => {
      listeners[ev] = cb;
      return child;
    },
    unref: vi.fn(),
  };
  return { child, listeners };
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe('utils/openFile.openWithSystem', () => {
  test('darwin: spawn open -- <path>, 等 spawn 事件 unref + resolve', async () => {
    const { child, listeners } = makeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = openWithSystem('/tmp/a.md', 'darwin');
    // 让 spawn 事件触发 → resolve
    listeners.spawn!();
    await expect(p).resolves.toBeUndefined();
    expect(spawnMock).toHaveBeenCalledWith('open', ['--', '/tmp/a.md'], { stdio: 'ignore' });
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  test('win32: spawn cmd /c start "" <path>', async () => {
    const { child, listeners } = makeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = openWithSystem('C:\\a\\b.txt', 'win32');
    listeners.spawn!();
    await expect(p).resolves.toBeUndefined();
    expect(spawnMock).toHaveBeenCalledWith(
      'cmd',
      ['/c', 'start', '', 'C:\\a\\b.txt'],
      { stdio: 'ignore' },
    );
  });

  test('linux: spawn xdg-open <path>', async () => {
    const { child, listeners } = makeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = openWithSystem('/tmp/a.pdf', 'linux');
    listeners.spawn!();
    await expect(p).resolves.toBeUndefined();
    expect(spawnMock).toHaveBeenCalledWith('xdg-open', ['/tmp/a.pdf'], { stdio: 'ignore' });
  });

  test('error 事件 reject, 抛出系统打开失败 + 原 error message', async () => {
    const { child, listeners } = makeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = openWithSystem('/tmp/nope', 'darwin');
    listeners.error!(new Error('ENOENT'));
    await expect(p).rejects.toThrow(/系统打开失败.*ENOENT/);
    expect(child.unref).not.toHaveBeenCalled();
  });
});
