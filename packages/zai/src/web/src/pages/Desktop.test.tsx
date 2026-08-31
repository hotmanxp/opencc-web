// @vitest-environment happy-dom
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { render, act, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Desktop from './Desktop.js';
import { useAppStore } from '../store/useAppStore.js';
import { LS_KEYS } from '../components/desktop/desktopStore.js';

vi.mock('../components/SettingsDrawer.js', () => ({ default: () => null })); // 设置抽屉副作用多,测试不管

// Desktop 内部会 fetch /api/agent/settings + PUT work-mode/main-agent + GET /desktop/fs/list
const fetchMock = vi.fn();
const settings = () => JSON.stringify({ workMode: 'code', mainAgent: 'default', mainAgents: [{ name: 'default' }, { name: 'office' }] });

const renderDesktop = () => render(<MemoryRouter><Desktop /></MemoryRouter>);

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes('/agent/settings')) {
      return new Response(settings(), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/desktop/fs/list')) {
      return new Response(JSON.stringify({ ok: true, path: '/Users/t', home: '/Users/t', parent: null, entries: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('Desktop', () => {
  test('挂载:snapshot 磁盘设置 → PUT work-mode=office + main-agent=office', async () => {
    renderDesktop();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const puts = fetchMock.mock.calls.filter(([u]) => String(u).includes('/agent/settings'));
    expect(puts.length).toBeGreaterThanOrEqual(2); // work-mode + main-agent 各一
    expect(JSON.stringify(puts)).toContain('office');
    // snapshot 已记录原值
    const snap = JSON.parse(localStorage.getItem(LS_KEYS.settingsSnapshot) ?? '{}');
    expect(snap.workMode).toBe('code');
    expect(snap.mainAgent).toBe('default');
  });

  test('卸载:读 snapshot 还原 workMode/mainAgent 并清 snapshot', async () => {
    const { unmount } = renderDesktop();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    fetchMock.mockClear();
    unmount();
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/agent/settings')).length).toBeGreaterThanOrEqual(2);
    expect(localStorage.getItem(LS_KEYS.settingsSnapshot)).toBeNull();
  });

  test('store.setWorkMode 被同步为 office', async () => {
    renderDesktop();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(useAppStore.getState().workMode).toBe('office');
  });

  test('已 office 时挂载不再重复 PUT(幂等)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/agent/settings')) return new Response(JSON.stringify({ workMode: 'office', mainAgent: 'office', mainAgents: [{ name: 'office' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    renderDesktop();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const puts = fetchMock.mock.calls.filter(([u]) => String(u).includes('/agent/settings') && String(u).includes('work-mode'));
    expect(puts.length).toBe(0);
  });

  test('双击不可预览文件 → POST /desktop/open 且不弹预览', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/agent/settings')) return new Response(settings(), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/desktop/fs/list')) {
        return new Response(JSON.stringify({ ok: true, path: '/Users/t', home: '/Users/t', parent: null, entries: [{ name: 'a.zip', kind: 'file', path: '/Users/t/a.zip', size: 1, mtime: 1 }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    renderDesktop();
    fireEvent.doubleClick(await screen.findByTestId('entry-a.zip'));
    await waitFor(() => {
      const open = fetchMock.mock.calls.filter(([u, init]) => String(u).includes('/desktop/open'));
      expect(open.length).toBe(1);
      expect(open[0]?.[1]?.method).toBe('POST');
      expect(String((open[0]?.[1] as RequestInit | undefined)?.body)).toContain('/Users/t/a.zip');
    });
    expect(screen.queryByTestId('desktop-window-preview')).toBeNull();
  });

  test('双击可预览文件 → 预览浮窗渲染文本预览', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/agent/settings')) return new Response(settings(), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/desktop/fs/list')) {
        return new Response(JSON.stringify({ ok: true, path: '/Users/t', home: '/Users/t', parent: null, entries: [{ name: 'a.md', kind: 'file', path: '/Users/t/a.md', size: 3, mtime: 1, preview: true }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/desktop/fs/file')) {
        return new Response(JSON.stringify({ ok: true, mime: 'text/plain', dataUrl: 'data:text/plain;base64,aGk=' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    renderDesktop();
    fireEvent.doubleClick(await screen.findByTestId('entry-a.md'));
    await waitFor(() => expect(screen.getByTestId('desktop-window-preview')).not.toBeNull());
  });

  test('双击 .md → 预览走 MarkdownText 渲染标题', async () => {
    // "# Title\n\nbody" base64 → 还原成 utf-8,FilePreviewBody 按 .md 扩展名走 MarkdownText 分支
    const md = '# Title\n\nhello body\n';
    const b64 = btoa(unescape(encodeURIComponent(md)));
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/agent/settings')) return new Response(settings(), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/desktop/fs/list')) {
        return new Response(JSON.stringify({ ok: true, path: '/Users/t', home: '/Users/t', parent: null, entries: [{ name: 'readme.md', kind: 'file', path: '/Users/t/readme.md', size: md.length, mtime: 1, preview: true }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/desktop/fs/file')) {
        return new Response(JSON.stringify({ ok: true, mime: 'text/plain', dataUrl: `data:text/plain;base64,${b64}` }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    renderDesktop();
    fireEvent.doubleClick(await screen.findByTestId('entry-readme.md'));
    // preview-markdown 测试 hook + heading 同时命中 → 验证走了 MarkdownText 分支
    await waitFor(() => expect(screen.getByTestId('preview-markdown')).not.toBeNull());
    expect(await screen.findByRole('heading', { name: 'Title' })).not.toBeNull();
  });

  test('双击 .ts → 预览走 CodeBlock (fallback / 高亮) 渲染', async () => {
    const code = 'const x = 1\n';
    const b64 = btoa(unescape(encodeURIComponent(code)));
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/agent/settings')) return new Response(settings(), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/desktop/fs/list')) {
        return new Response(JSON.stringify({ ok: true, path: '/Users/t', home: '/Users/t', parent: null, entries: [{ name: 'a.ts', kind: 'file', path: '/Users/t/a.ts', size: code.length, mtime: 1, preview: true }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/desktop/fs/file')) {
        return new Response(JSON.stringify({ ok: true, mime: 'text/plain', dataUrl: `data:text/plain;base64,${b64}` }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    renderDesktop();
    fireEvent.doubleClick(await screen.findByTestId('entry-a.ts'));
    // preview-code 测试 hook:CodeBlock 的容器元素(不论 SyntaxHighlighter 是否加载)
    await waitFor(() => expect(screen.getByTestId('preview-code')).not.toBeNull());
    // 内容展示:fallback <pre data-testid="code-fallback"> 或 SyntaxHighlighter 都会展示
    expect(await screen.findByText(/const x = 1/)).not.toBeNull();
  });

  test('双击 .png → 预览走 <img> 渲染', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/agent/settings')) return new Response(settings(), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/desktop/fs/list')) {
        return new Response(JSON.stringify({ ok: true, path: '/Users/t', home: '/Users/t', parent: null, entries: [{ name: 'logo.png', kind: 'file', path: '/Users/t/logo.png', size: 16, mtime: 1, preview: true }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/desktop/fs/file')) {
        // 1x1 透明 PNG (8 字节 magic 头),纯 base64 验证 mime 推断 → image 分支
        return new Response(JSON.stringify({ ok: true, mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX///+nxBvIAAAACklEQVR4nGNgAAAAAgABc3UBGAAAAABJRU5ErkJggg==' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    renderDesktop();
    fireEvent.doubleClick(await screen.findByTestId('entry-logo.png'));
    await waitFor(() => expect(screen.getByTestId('preview-image')).not.toBeNull());
    const img = await screen.findByAltText('logo.png');
    expect(img.tagName.toLowerCase()).toBe('img');
    expect(img.getAttribute('src') ?? '').toMatch(/^data:image\/png;base64,/);
  });

  test('上传壁纸:PUT /desktop/wallpaper 存服务端文件,localStorage 只保存 URL', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/agent/settings')) return new Response(settings(), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/desktop/fs/list')) {
        return new Response(JSON.stringify({ ok: true, path: '/Users/t', home: '/Users/t', parent: null, entries: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/desktop/wallpaper') && (init?.method === 'PUT' || !init?.method)) {
        const body = JSON.parse(String(init?.body)) as { dataUrl: string };
        expect(body.dataUrl).toMatch(/^data:image\/png;base64,/);
        return new Response(JSON.stringify({ ok: true, id: 'wabc', url: '/api/desktop/wallpaper/wabc' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    renderDesktop();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    // antd Popover 懒渲染:先打开壁纸面板,上传控件才在 DOM 里。
    // 上传控件必须是原生 input(WallpaperUploadField 头注解释为何不能用 antd Input),
    // 这里用它的 data-testid 精确选取,避开 AgentInputBox 的附件 file input。
    fireEvent.click(screen.getByTestId('dock-壁纸设置'));
    const input = await waitFor(() => {
      const el = document.querySelector('[data-testid="wallpaper-file-input"]') as HTMLInputElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    expect(input.tagName.toLowerCase()).toBe('input');
    // 防回归:不能包在 antd Input(rc-input)里 —— rc-input 会把
    // `C:\fakepath\x.png` 作为 value 回写 DOM,React commitUpdate 抛
    // InvalidStateError 并卸载整棵桌面树。
    expect(input.classList.contains('ant-input')).toBe(false);
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'wp.png', { type: 'image/png' });
    // happy-dom 下 fireEvent.change({target:{files}}) 不会真正落到 input.files
    // (FileList 是只读 getter),用 defineProperty 注入再派发 change。
    Object.defineProperty(input, 'files', { value: [png], configurable: true });
    await act(async () => {
      fireEvent.change(input);
      await new Promise((r) => setTimeout(r, 50));
    });
    // PUT 命中 + 壁纸以 URL(而非 dataURL)持久化
    const puts = fetchMock.mock.calls.filter(([u, init]) => String(u).includes('/desktop/wallpaper') && (init as RequestInit | undefined)?.method === 'PUT');
    expect(puts.length).toBe(1);
    const stored = localStorage.getItem(LS_KEYS.wallpaper);
    expect(stored).toBe('"/api/desktop/wallpaper/wabc"');
    // 桌面树仍在(旧 bug:合成事件里给 file input 赋 value 抛 InvalidStateError → 整树卸载)
    expect(screen.getByTestId('desktop-root')).not.toBeNull();
    expect(screen.getByTestId('desktop-window-agent')).not.toBeNull();
    // 根节点 background 引用服务端 URL
    expect(screen.getByTestId('desktop-root').getAttribute('style')).toContain('/api/desktop/wallpaper/wabc');
  });

  test('历史 dataURL 壁纸迁移:挂载后重置为默认预设,不再存 base64', async () => {
    localStorage.setItem(LS_KEYS.wallpaper, JSON.stringify('data:image/png;base64,AAAA'));
    renderDesktop();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(JSON.parse(localStorage.getItem(LS_KEYS.wallpaper) ?? '""')).toBe('preset:aurora');
  });
});
