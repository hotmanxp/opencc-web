import { spawn } from 'node:child_process';
import open from 'open';

/**
 * Open a URL in the system default browser in a cross-platform way.
 *
 * - macOS: `open` package → `/usr/bin/open`
 * - Linux: `open` package → `xdg-open`
 * - Windows: the `open` package shells out to PowerShell (`Start-Process`),
 *   which fails with EPERM when the OS policy disables PowerShell. Spawn
 *   `cmd /c start` directly instead — the first `""` argument is the window
 *   title placeholder, and `start` is unaffected by the PowerShell policy.
 *
 * Failures (no GUI, headless container, missing browser, WSL without a
 * default browser) are logged as a warning rather than thrown — the server
 * is already listening and the user can open the URL manually.
 */
export function openBrowser(url: string): void {
  if (process.platform === 'win32') {
    openWithCmd(url);
    return;
  }
  void open(url).catch((err: unknown) => {
    warnManualOpen(url, err);
  });
}

function openWithCmd(url: string): void {
  const child = spawn('cmd.exe', ['/c', 'start', '""', `"${url}"`], {
    windowsVerbatimArguments: true,
    stdio: 'ignore',
    detached: true,
  });
  child.on('error', (err) => warnManualOpen(url, err));
  // cmd 执行完 `start` 后即退出;detached + unref 让浏览器进程独立于
  // zai 存活,且不阻塞父进程退出。
  child.unref();
}

function warnManualOpen(url: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[zai] warning: failed to open browser: ${message}`);
  console.warn(`[zai] Open ${url} manually in your browser.`);
}