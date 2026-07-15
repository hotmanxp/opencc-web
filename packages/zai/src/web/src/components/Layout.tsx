import { useEffect, useState } from 'react';
import { Layout as AntLayout, Menu, Tag } from 'antd';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  DashboardOutlined,
  ToolOutlined,
  AppstoreOutlined,
  LoginOutlined,
  SettingOutlined,
  FolderOutlined,
  RobotOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from '@ant-design/icons';
import { useAppStore } from '../store/useAppStore';
import { api } from '../lib/api';

const { Sider, Header, Content } = AntLayout;

const menuItems = [
  { key: '/login', icon: <LoginOutlined />, label: '登录' },
  // / 路径保留为入口重定向到 /login，菜单的"系统信息"显式指向 /dashboard 子路由，
  // 否则 antd Menu 拿 / 作为 selectedKey 会触发跳转再被 Navigate 弹回 /login。
  { key: '/dashboard', icon: <DashboardOutlined />, label: '系统信息' },
  { key: '/tools', icon: <ToolOutlined />, label: '工具' },
  { key: '/resources', icon: <AppstoreOutlined />, label: '资源' },
  { key: '/config', icon: <SettingOutlined />, label: '配置' },
  { key: '/dirs', icon: <FolderOutlined />, label: '目录' },
  { key: '/agent', icon: <RobotOutlined />, label: 'Agent' },
];

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { sidebarCollapsed, toggleSidebar, setInstanceContext } = useAppStore();
  const [version, setVersion] = useState<string>('…');

  useEffect(() => {
    api
      .get<{ ok: boolean; version: string; cwd: string; cwdName: string; branch: string | null }>('/system')
      .then((data) => {
        setVersion(data.version);
        setInstanceContext({ cwd: data.cwd, cwdName: data.cwdName, branch: data.branch ?? null });
        document.title = `知鸟AI - ${data.cwdName}`;
      })
      .catch(() => {
        setVersion('unknown');
        document.title = '知鸟AI';
      });
  }, [setInstanceContext]);

  return (
    // 用 height: 100vh (而不是 minHeight) 把 AntLayout 锁死在视口高度,
    // 这样内部 flex: 1 (Content / 子页面 wrapper) 才有确定的剩余空间可分配,
    // 否则内容一长 AntLayout 会跟着拉高, 整页出现滚动条, 把底部输入框推出视口.
    <AntLayout style={{ height: '100vh' }}>
      <Sider
        collapsible
        collapsed={sidebarCollapsed}
        onCollapse={toggleSidebar}
        width={150}
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
            fontSize: 24,
            fontWeight: 700,
            background: 'linear-gradient(135deg, #ff6600, #ff8533)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            gap: 8,
          }}
        >
          <span>🐦</span>
          {!sidebarCollapsed && <span>知鸟AI</span>}
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
        />
        {/* 自定义触发条: trigger={null} 关闭了 antd 自带的 .ant-layout-sider-trigger
            (深蓝底色), 这里手动渲染一个, 用主题橙 (#ff6600) + 浅橙底, hover 加深,
            点击切 sidebarCollapsed. 图标用 MenuFold / MenuUnfold (双向箭头),
            比 antd 默认的单边 < > 更有方向感. */}
        <div
          onClick={toggleSidebar}
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: 40,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            background: 'rgba(255, 102, 0, 0.12)',
            color: '#ff6600',
            borderTop: '1px solid rgba(255, 102, 0, 0.25)',
            transition: 'background 0.15s ease',
          }}
          onMouseEnter={(e) => {
            ;(e.currentTarget as HTMLDivElement).style.background =
              'rgba(255, 102, 0, 0.22)'
          }}
          onMouseLeave={(e) => {
            ;(e.currentTarget as HTMLDivElement).style.background =
              'rgba(255, 102, 0, 0.12)'
          }}
          title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
        >
          {sidebarCollapsed ? (
            <MenuUnfoldOutlined style={{ fontSize: 16 }} />
          ) : (
            <MenuFoldOutlined style={{ fontSize: 16 }} />
          )}
        </div>
      </Sider>
      <AntLayout>
        <Header
          style={{
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0, color: '#f1f5f9' }}>知鸟AI 平台</h1>
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
        </Header>
        {/* Content 用 flex column, 让子页面 (例如 Agent) 可以 flex: 1 自适应
            填满 Content 的可用高度, 不再依赖 calc(100vh - X) 的硬编码, 这样
            调整 Header 高度或 padding 都不会再把对话输入框挤出底部.
            注意 Content 自身必须有 flex: 1 才能在 AntLayout (flex column) 里
            占满 Header 之外的剩余高度, 否则子页面会以 content 高度为准溢出. */}
        <Content style={{ flex: 1, padding: '24px 24px 0 24px', width: '100%', display: 'flex', flexDirection: 'column' }}>
          <Outlet />
        </Content>
      </AntLayout>
    </AntLayout>
  );
}