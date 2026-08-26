import { Tabs } from 'antd';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import Resources from './Resources';
import Config from './Config';
import Directory from './Directory';
import Tools from './Tools';

// 合并三个原独立页面(/resources /config /dirs)到 /manage 入口;另外把
// Tools 工具检测页也收进来(原先 /tools 是单独的)。/login 因为是用户
// 常用入口,保留为顶层菜单 (Layout ALL_MENU_ITEMS 内 /login)。
// 用 AntD Tabs (tabPosition="top") 顶部横排;active tab 用 ?tab=<key>
// 持久化。Config 内部仍读 ?tool= 选 provider 子 tab,与 ?tab= 共存无冲突。
const TAB_KEYS = ['resources', 'config', 'dirs', 'tools'] as const;
type TabKey = (typeof TAB_KEYS)[number];

function isTabKey(value: string | null): value is TabKey {
  return value !== null && (TAB_KEYS as readonly string[]).includes(value);
}

export default function Manage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  const activeTab: TabKey = isTabKey(rawTab) ? rawTab : 'config';

  const items = useMemo(
    () => [
      { key: 'resources', label: '资源', children: <Resources /> },
      { key: 'config', label: '配置', children: <Config /> },
      { key: 'dirs', label: '目录', children: <Directory /> },
      { key: 'tools', label: '工具', children: <Tools /> },
    ],
    [],
  );

  return (
    <div
      style={{
        padding: '0 24px 24px',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
      data-testid="manage-page"
    >
      <Tabs
        activeKey={activeTab}
        onChange={(key) => {
          const next = new URLSearchParams(searchParams);
          next.set('tab', key);
          // replace: true — tab 切换不污染 history 栈,后退直接跳出 /manage
          setSearchParams(next, { replace: true });
        }}
        items={items}
        tabPosition="top"
        style={{ flex: 1, display: 'flex', flexDirection: 'column' }}
      />
    </div>
  );
}
