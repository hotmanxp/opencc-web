import { useCallback, useEffect, useRef, useState } from 'react';
import { Tabs } from 'antd';
import { GitTab } from './GitTab.js';
import { FsTab } from './FsTab.js';
import { BashTab } from './BashTab.js';
import { useAgentStore } from '../../store/useAgentStore.js';
import { useAppStore } from '../../store/useAppStore.js';
import {
  STORAGE_KEYS,
  MIN_WIDTH,
  MAX_WIDTH,
  DEFAULT_WIDTH_VW,
  RESPONSIVE_BREAKPOINT,
  clampWidth,
  useLocalStorageState,
  useIsGitRepo,
} from './shared.js';

/**
 * 首次打开分屏时的默认宽度: 60vw (DEFAULT_WIDTH_VW). storage 已有值
 * (用户拖拽过) 沿用 storage — 仅"首次"用 60vw.
 *
 * SSR 安全: typeof window 守卫避免在非浏览器环境 (测试 / SSR) 抛错.
 */
function resolveInitialWidth(): number {
  return DEFAULT_WIDTH_VW;
}

type TabKey = 'git' | 'fs' | 'bash';

export interface SplitPaneProps {
  cwd: string | null;
}

/**
 * Three-column container:
 *   [slot]            [messages (passed via children, not used here)]      [panel]
 *
 * We don't take children — Agent.tsx wraps its own messages column and
 * passes `cwd` here. The panel column is fully owned by SplitPane.
 */
export function SplitPane({ cwd }: SplitPaneProps) {
  // 默认值取自 useAppStore.defaultSplitScreen(由 Layout 在 mount 时从
  // settings.json hydrate).localStorage 已有显式值时,显式值胜出 — 用户
  // 手动 toggle 过的偏好不会被此设置覆盖.
  const defaultSplitScreen = useAppStore((s) => s.defaultSplitScreen);
  const [openStored, setOpenStored] = useLocalStorageState<boolean>(STORAGE_KEYS.open, defaultSplitScreen);
  const [tab, setTab] = useLocalStorageState<TabKey>(STORAGE_KEYS.tab, 'git');
  const [widthStored, setWidthStored] = useLocalStorageState<number>(
    STORAGE_KEYS.width,
    resolveInitialWidth(),
  );
  const width = clampWidth(widthStored);
  const activeSessionId = useAgentStore((s) => s.sessionId ?? null)
  // 非 git 项目 (instanceContext.branch === null) 过滤 Git tab (见 shared.ts
  // useIsGitRepo). 用户此前若把 tab 停在 git,fallback 到 fs 避免空面板.
  const isGit = useIsGitRepo();
  const tabItems = [
    { key: 'fs', label: 'Files', children: <FsTab cwd={cwd} /> },
    ...(isGit
      ? [{ key: 'git', label: 'Git', children: <GitTab cwd={cwd} /> }]
      : []),
    { key: 'bash', label: 'Bash', children: <BashTab sessionId={activeSessionId} cwd={cwd} /> },
  ];
  const activeTab: TabKey = tab === 'git' && !isGit ? 'fs' : tab;

  // 实时同步 defaultSplitScreen → localStorage:用户在 /agent 页面打开设置,
  // 切换"默认启动分屏"时,立即把新值写入 localStorage 让面板按新设置显示,
  // 无需刷新页面.一旦 localStorage 中已有值且该值和意图不一致时
  // (用户在 Settings 里改了设置但页面没刷新,R1 false 被种子写入后
  // API hydrate 把 store 改成 true),仍需同步.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(STORAGE_KEYS.open);
    if (stored === null) {
      setOpenStored(defaultSplitScreen);
      return;
    }
    const storedBool = stored === 'true';
    if (storedBool !== defaultSplitScreen) {
      setOpenStored(defaultSplitScreen);
    }
    // setOpenStored 内部已经写 localStorage + 派发 zai-localstorage-sync,
    // Agent.tsx 的同名 hook 会通过 storage/sync 事件同步刷新.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultSplitScreen]);

  // Responsive: collapse when window is narrow regardless of stored state.
  const [responsiveClosed, setResponsiveClosed] = useState(
    typeof window !== 'undefined' && window.innerWidth < RESPONSIVE_BREAKPOINT,
  );
  useEffect(() => {
    const onResize = () => {
      setResponsiveClosed(window.innerWidth < RESPONSIVE_BREAKPOINT);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const open = openStored && !responsiveClosed;

  // Splitter drag state. width 存的是 vw (整数百分比), 但 pointer 移动给出 px,
  // 所以拖拽过程中实时把 px delta 折算成 vw delta:
  //   delta_vw = delta_px / window.innerWidth * 100
  // 然后加到 startW (vw) 上, clamp 进 [MIN_WIDTH, MAX_WIDTH].
  //
  // 2026-09-20: 去掉"拖动锁". hover 到分割线 (12px 命中区) 即可直接拖动,
  // 不再需要先点悬浮按钮解锁. 参考 deepseek-harness dockkit 的分割线做法:
  //   * 命中区比视觉线宽 (12px vs 1px border), hover 时淡入 2px accent grip;
  //   * pointerdown 里 preventDefault + body 挂 .zai-split-resizing
  //     (全局 user-select:none + col-resize), 拖动不会选中正文, 指针移出
  //     分割线后光标也不会跳回文本/箭头;
  //   * pointermove / pointerup / pointercancel 统一挂 window, 由 effect
  //     注册与清理 — 组件中途卸载不会残留监听;
  //   * pointercancel 也收尾 (触控被系统抢占时不至于卡在拖动中).
  const dragRef = useRef<{ startX: number; startW: number; last: number } | null>(null);
  const [resizing, setResizing] = useState(false);

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // 只响应左键 — 右键/中键不进入拖动.
      if (e.button !== 0) return;
      // 阻止按下时开始文本选择 / 抢焦点. 这是"分屏拖动不引发内容选择"的
      // 主防线; .zai-split-resizing 的 user-select:none 是兜底 (覆盖拖动
      // 途中经过的其它元素).
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startW: width, last: width };
      setResizing(true);
    },
    [width],
  );

  useEffect(() => {
    if (!resizing) return;
    document.body.classList.add('zai-split-resizing');
    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const viewport = window.innerWidth || 1;
      // Drag left → 分割线左移 → 分屏变宽; right → 变窄.
      const next = clampWidth(
        drag.startW + ((drag.startX - ev.clientX) / viewport) * 100,
      );
      // vw 取整后同一个整数会覆盖多帧 pointermove, 跳过重复值, 否则每个像素
      // 都要打一次 localStorage + 派发 zai-localstorage-sync.
      if (next === drag.last) return;
      drag.last = next;
      setWidthStored(next);
    };
    const stop = () => setResizing(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      dragRef.current = null;
      document.body.classList.remove('zai-split-resizing');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [resizing, setWidthStored]);

  // panelWidth 是 vw 字符串 ('60vw' / '0'), 跟随窗口宽度变化.
  const panelWidth = open ? `${width}vw` : 0;

  return (
    <div
      data-testid="split-pane"
      className="flex flex-col h-full relative overflow-hidden"
      style={{
        flex: '0 0 auto',
        width: panelWidth,
        minWidth: panelWidth,
        borderLeft: open ? '1px solid var(--border-light)' : 'none',
        // overflow-hidden: drag handle 现在完全落在 panel 内(见下), 不再需要
        // 让元素跨到 Agent 区. 各 Tab 内部仍有自己的 overflow:auto /
        // overflow:hidden, 面板边界裁切不会影响它们.
        // 拖动中关掉 width transition: 否则每一帧的宽度变化都会走 0.2s
        // 缓动, 手感是"追着鼠标跑"的橡皮筋.
        transition: resizing
          ? 'none'
          : 'width 0.2s ease, min-width 0.2s ease',
      }}
    >
      {open && (
        <>
          <Tabs
            activeKey={activeTab}
            onChange={(k) => setTab(k as TabKey)}
            size="small"
            // flex-1 + zai-pane-fill: 让 antd Tabs 撑满分屏高度, 并把
            // content / tabpane 拉满 (见 index.css). 没有这两条时 Tabs 是
            // 内容高度, 各 Tab 只能靠 calc(100vh - Npx) 的魔数撑开.
            className="zai-pane-fill flex-1 min-h-0"
            tabBarStyle={{
              margin: 0,
              padding: '0 8px',
              background: 'var(--bg-tab)',
              borderBottom: '1px solid var(--border-light)',
            }}
            items={tabItems}
          />
          {/* Splitter drag surface — 锚定在 panel 左边缘 (borderLeft 视觉分割线
              位置, Agent ↔ 分屏区 的分界). 始终可拖动: hover 淡入 2px accent
              grip 作为"这里能拖"的提示, 按下即开始拖动. touch-none 关掉浏览器
              自身的触控手势(否则触控板/触摸屏会把它当滚动).
              grip 走 --accent-start 降透明度 (hover 60% / 拖动中 75%) 而不是
              实色 — 分割线是常驻元素, 满饱和的品牌橙在浅色正文旁边太抢眼.

              命中区必须落在 panel 内侧 (left-0 + w-3), 不能像悬浮按钮那样跨到
              Agent 区: 左侧消息区的滚动条宽 6px (index.css ::-webkit-scrollbar
              6px) 紧贴这条分割线, 跨过去会把滚动条整个盖住, 拖滚动条变成拖分屏.
              grip 用 -left-px 反向溢出 1px, 正好压在 borderLeft 那一像素上 —
              视觉上仍是"分割线被点亮", 命中区则留在 panel 里. */}
          <div
            data-testid="split-pane-handle"
            onPointerDown={onHandlePointerDown}
            className="absolute top-0 left-0 w-3 h-full z-[5] cursor-col-resize touch-none group"
            title={`拖动以调整宽度 (${MIN_WIDTH}-${MAX_WIDTH}vw)`}
          >
            <div
              className={`absolute inset-y-0 -left-px w-[2px] rounded-full bg-[var(--accent-start)] transition-opacity duration-150 ${
                resizing ? 'opacity-75' : 'opacity-0 group-hover:opacity-60'
              }`}
            />
          </div>
        </>
      )}
    </div>
  );
}
