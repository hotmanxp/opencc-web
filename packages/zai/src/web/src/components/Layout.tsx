import { useEffect, useMemo, useState } from 'react';
import { Layout as AntLayout, Menu, Switch, Tag } from 'antd';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  ToolOutlined,
  AppstoreOutlined,
  LoginOutlined,
  SettingOutlined,
  FolderOutlined,
  RobotOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  ClusterOutlined,
  SunOutlined,
  MoonOutlined,
} from '@ant-design/icons';
import { useAppStore } from '../store/useAppStore';
import { useAgentStore } from '../store/useAgentStore';
import { api } from '../lib/api';
import type { OutputStyle, Theme } from '../../shared/settings.js';
import ZnLogo from './ZnLogo';
import { useIsMobile } from '../hooks/useIsMobile';
import { useEffectiveTheme } from '../hooks/useEffectiveTheme.js';
import { UpdateNotifier } from './UpdateNotifier';

const { Sider, Header, Content } = AntLayout;

// 完整菜单列表,instance 子实例(instance manager 派生的子进程)模式
// 下隐藏"实例管理"入口:子实例自己不能再 spawn 孙实例(由 routes/instances.ts
// 路由层 + server/index.ts init 双重防御),给它看到这个入口只会显示 404
// 页面,反而让用户困惑。Layout 在 useMemo 里按 isManagedChild 过滤。
const ALL_MENU_ITEMS = [
  { key: '/agent', icon: <RobotOutlined />, label: 'Agent' },
  { key: '/instances', icon: <ClusterOutlined />, label: '实例管理' },
  { key: '/login', icon: <LoginOutlined />, label: '登录' },
  { key: '/tools', icon: <ToolOutlined />, label: '工具' },
  { key: '/resources', icon: <AppstoreOutlined />, label: '资源' },
  { key: '/config', icon: <SettingOutlined />, label: '配置' },
  { key: '/dirs', icon: <FolderOutlined />, label: '目录' },
] as const;

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { sidebarCollapsed, toggleSidebar, setInstanceContext, setSettingsTheme, setOutputStyle, setMaxVisibleMessages, setDefaultSplitScreen, setEnableDynamicWorkflow, setAutoUpdate } = useAppStore();
  // 顶层 zai 实例(独立启动 / 顶层 managed supervisor)显示"实例管理"菜单;
  // instance 子实例(被 instance manager 派生的子进程)不显示 — 它不能 spawn
  // 孙实例,给它看到这个入口只会跳到 404 页面迷惑用户。
  const isInstanceChild = useAppStore((s) => s.instanceContext?.isManagedChild === true && (s.instanceContext?.instanceId ?? null) != null);
  const menuItems = useMemo(
    () => (isInstanceChild ? ALL_MENU_ITEMS.filter((m) => m.key !== '/instances') : [...ALL_MENU_ITEMS]),
    [isInstanceChild],
  );
  // Menu 跟随 effective theme: 之前硬编码 theme="dark" 让 AntD 在 light 主题下
  // 仍按暗色算法把 menu-item 文字渲成 rgba(255,255,255,0.65), 但 sider 背景
  // 被全局 CSS 强制为浅色 --bg-sidebar, 白字 + 浅底 = 几乎不可见。
  // 让 Menu 跟随主题后, light 主题下走 light 算法(深色文字) + 浅色 sider 配对,
  // dark 主题下走 dark 算法(白色文字) + 深色 sider 配对, 各自 OK。
  const effectiveTheme = useEffectiveTheme();
  // 桌面端右上角浮动主题切换 Switch — 直接复用 setSettingsTheme +
  // PUT /api/agent/settings/theme 写盘路径,与 SettingsDrawer 里"主题"行
  // 完全一致. 移动端 (isMobile===true) 不渲染, 避免挡住底部 home indicator
  // 和原本的 MobileHeader 工具栏.
  const isMobile = useAppStore((s) => s.isMobile);
  const handleToggleTheme = (checked: boolean) => {
    const next: Theme = checked ? 'light' : 'dark';
    setSettingsTheme(next);
    void fetch('/api/agent/settings/theme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next }),
    }).catch(() => {
      // swallow — 下次 GET 会重新对齐磁盘状态
    });
  };
  const [version, setVersion] = useState<string>('…');
  // 视口宽度监听 → 写 useAppStore.isMobile. 全局一次挂载即可, 子组件用
  // useAppStore((s) => s.isMobile) 直接读, 避免 props 透传.
  useIsMobile();

  useEffect(() => {
    api
      .get<{
        ok: boolean;
        version: string;
        cwd: string;
        cwdName: string;
        branch: string | null;
        host: string;
        port: number;
        ips: string[];
        isManagedChild?: boolean;
        supervisorPid?: number | null;
        instanceId?: string | null;
      }>('/system')
      .then((data) => {
        setVersion(data.version);
        setInstanceContext({
          cwd: data.cwd,
          cwdName: data.cwdName,
          branch: data.branch ?? null,
          host: data.host,
          port: data.port,
          ips: data.ips ?? [],
          isManagedChild: data.isManagedChild === true,
          supervisorPid: typeof data.supervisorPid === 'number' ? data.supervisorPid : null,
          instanceId: typeof data.instanceId === 'string' ? data.instanceId : null,
        });
        document.title = `${data.cwdName}-Z.AI`;
      })
      .catch(() => {
        setVersion('unknown');
        document.title = 'opencc-web-Z.AI';
      });
  }, [setInstanceContext]);

  // 冷启动 hydrate outputStyle:一次性 GET /api/agent/settings 把磁盘上的
  // settings.json 投影进 store.失败就保持 'default',与现有 settings 缺失
  // 兜底行为一致 — SettingsDrawer 重新打开时仍能写回磁盘.
  // 同步把 useAgentStore.transcriptCollapsed 设为 (compact === true),这样
  // MessageListView 在 compact 默认下立即进入折叠视图,无需"先看到再翻"
  // 的闪烁.
  const setTranscriptCollapsed = useAgentStore((s) => s.setTranscriptCollapsed)
  useEffect(() => {
    let cancelled = false
    api
      .get<{ outputStyle?: OutputStyle; theme?: Theme; maxVisibleMessages?: number; defaultSplitScreen?: boolean }>(
        '/agent/settings',
      )
      .then((data) => {
        if (cancelled) return
        if (
          data.outputStyle === 'default' ||
          data.outputStyle === 'compact' ||
          data.outputStyle === 'verbose'
        ) {
          setOutputStyle(data.outputStyle)
          setTranscriptCollapsed(data.outputStyle === 'compact')
        }
        // hydrate 主题:服务端已在 GET handler 走 resolveTheme() 把未知值折叠为 'auto',
        // 这里 4 档白名单校验是防御层(防 cache stale / transport 异常).
        if (
          data.theme === 'auto' ||
          data.theme === 'dark' ||
          data.theme === 'light' ||
          data.theme === 'high-contrast'
        ) {
          setSettingsTheme(data.theme)
        }
        if (typeof data.maxVisibleMessages === 'number') {
          // Mirror server-side clamp from settings/max-visible-messages PUT handler
          // so a tampered settings.json can't break the UI with a 0/negative/NaN.
          setMaxVisibleMessages(
            Math.max(1, Math.min(1000, Math.floor(data.maxVisibleMessages))),
          )
        }
        if (typeof data.defaultSplitScreen === 'boolean') {
          setDefaultSplitScreen(data.defaultSplitScreen)
        }
        if (typeof data.enableDynamicWorkflow === 'boolean') {
          setEnableDynamicWorkflow(data.enableDynamicWorkflow)
        }
        if (typeof data.autoUpdate === 'boolean') {
          setAutoUpdate(data.autoUpdate)
        }
      })
      .catch(() => {
        // swallow — keep default
      })
    return () => {
      cancelled = true
    }
  }, [setOutputStyle, setSettingsTheme, setMaxVisibleMessages, setDefaultSplitScreen, setEnableDynamicWorkflow, setAutoUpdate, setTranscriptCollapsed]);

  return (
    // 用 height: 100vh (而不是 minHeight) 把 AntLayout 锁死在视口高度,
    // 这样内部 flex: 1 (Content / 子页面 wrapper) 才有确定的剩余空间可分配,
    // 否则内容一长 AntLayout 会跟着拉高, 整页出现滚动条, 把底部输入框推出视口.
    <AntLayout style={{ height: '100vh' }}>
      {/* zai 自升级弹窗组件。监听 useAppStore.appUpdate 状态,complete/
          failed 时弹 Modal,checking/installing 时顶部 notification。
          AntD Modal/notification 默认 portal 到 body,DOM 位置不影响渲染。 */}
      <UpdateNotifier />
      <Sider
        collapsible
        collapsed={sidebarCollapsed}
        onCollapse={toggleSidebar}
        width={150}
        collapsedWidth={60}
        // trigger={false} 关闭 antd 自带的触发条 (避免 .ant-layout-sider-trigger
        // 的深蓝底色覆盖自定义样式). 我们自己渲染, 用主题紫 + 半透明紫底,
        // hover 时加深, 与全站紫色基调一致.
        trigger={null}
      >
        <div
          style={{
            height: 64,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 18,
            fontWeight: 700,
            background: 'linear-gradient(135deg, #ff6600, #ff8533)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent'
          }}
        >
          <ZnLogo size={42} />
          {!sidebarCollapsed && <span>Z.AI</span>}
        </div>
        <Menu
          theme={effectiveTheme === 'dark' ? 'dark' : 'light'}
          mode="inline"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <AntLayout>
        {/* <Header
          style={{
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>知鸟AI 平台</h1>
          <Tag
            color="orange"
            style={{
              margin: 0,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 12,
            }}
          >
            v{version}
          </Tag>
        </Header> */}
        {/* Content 用 flex column, 让子页面 (例如 Agent) 可以 flex: 1 自适应
            填满 Content 的可用高度, 不再依赖 calc(100vh - X) 的硬编码, 这样
            调整 Header 高度或 padding 都不会再把对话输入框挤出底部.
            注意 Content 自身必须有 flex: 1 才能在 AntLayout (flex column) 里
            占满 Header 之外的剩余高度, 否则子页面会以 content 高度为准溢出. */}
        <Content style={{ flex: 1, padding: '0', width: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
          {/* 桌面端右上角悬浮主题切换 Switch — 复用现有 setSettingsTheme +
              PUT /api/agent/settings/theme 写盘路径,与 SettingsDrawer 里"主题"
              行同源;移动端不渲染. */}
          {!isMobile && (
            <div
              data-testid="theme-floating-switch"
              style={{
                position: 'absolute',
                top: 0,
                right: 5,
                zIndex: 100,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 8px',
                borderRadius: 999,
                background: 'var(--bg-card)',
                border: '1px solid var(--border-subtle)',
                boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
              }}
            >
              <MoonOutlined style={{ fontSize: 12, color: effectiveTheme === 'dark' ? 'var(--accent-start)' : 'var(--text-tertiary)' }} />
              <Switch
                size="small"
                checked={effectiveTheme === 'light'}
                onChange={handleToggleTheme}
                checkedChildren={<SunOutlined />}
                unCheckedChildren={<MoonOutlined />}
                aria-label="切换主题"
              />
              <SunOutlined style={{ fontSize: 12, color: effectiveTheme === 'light' ? 'var(--accent-start)' : 'var(--text-tertiary)' }} />
            </div>
          )}
          <Outlet />
        </Content>
      </AntLayout>
    </AntLayout>
  );
}