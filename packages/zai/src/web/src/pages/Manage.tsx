import { Tabs } from 'antd';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import Resources from './Resources';
import Config from './Config';
import Directory from './Directory';
import Tools from './Tools';
import AASettings from './AASettings';
import { useAppStore } from '../store/useAppStore';

// 合并三个原独立页面(/resources /config /dirs)到 /manage 入口;另外把
// Tools 工具检测页和 Agents Anywhere (AA) 设置也收进来。
// /login 因为是用户常用入口,保留为顶层菜单 (Layout ALL_MENU_ITEMS 内 /login)。
// 用 AntD Tabs (tabPosition="top") 顶部横排;active tab 用 ?tab=<key>
// 持久化。Config 内部仍读 ?tool= 选 provider 子 tab,与 ?tab= 共存无冲突。
const TAB_KEYS = ['resources', 'config', 'dirs', 'tools', 'aa'] as const;
type TabKey = (typeof TAB_KEYS)[number];

function isTabKey(value: string | null): value is TabKey {
  return value !== null && (TAB_KEYS as readonly string[]).includes(value);
}

export default function Manage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // 「AA 桥」tab 只在本次进程带 `--aa` 启动时存在(后端 GET /api/system 的
  // aaEnabled,Layout hydrate 进 instanceContext)。没带 --aa 就不渲染这个 tab ——
  // AA 对绝大多数用户是无关功能,常驻一个入口只会让人以为漏配了什么。
  // fail-open:见 useAppStore 注释 —— undefined(老后端)按启用处理,只有显式
  // false 才藏,避免滚动期把 AA 实例上的入口误藏。
  const aaEnabled = useAppStore((s) => s.instanceContext?.aaEnabled !== false);
  const rawTab = searchParams.get('tab');
  // 老书签 / 旧链接 (?tab=aa) 落在未启用 AA 的进程上时回落到「配置」,
  // 否则 activeKey 指向不存在的 tab,AntD 会渲染一片空白。
  const activeTab: TabKey =
    !aaEnabled && rawTab === 'aa' ? 'config' : isTabKey(rawTab) ? rawTab : 'config';

  const items = useMemo(
    () => [
      { key: 'resources', label: '资源', children: <Resources /> },
      { key: 'config', label: '配置', children: <Config /> },
      { key: 'dirs', label: '目录', children: <Directory /> },
      { key: 'tools', label: '工具', children: <Tools /> },
      ...(aaEnabled ? [{ key: 'aa', label: 'AA 桥', children: <AASettings /> }] : []),
    ],
    [aaEnabled],
  );

  return (
    <div
      className="h-full flex flex-col min-h-0 px-6 pb-6"
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
