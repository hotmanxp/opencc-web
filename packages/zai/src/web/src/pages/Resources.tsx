import { Tabs, Button, Spin, message, Card, Empty, Typography, Space, Tag } from 'antd';
import {
  DownloadOutlined,
  SyncOutlined,
  CheckCircleOutlined,
  FolderOutlined,
  FileOutlined,
} from '@ant-design/icons';
import { useEffect, useState, useMemo } from 'react';
import type { ResourceItem, ResourceType, SseEvent } from '@shared/types';
import { api } from '../lib/api';
import { useSse } from '../lib/sse';
import LogPanel from '../components/LogPanel';

const tabs: { key: ResourceType; label: string }[] = [
  { key: 'skills', label: 'Skills' },
  { key: 'commands', label: 'Commands' },
  { key: 'extensions', label: 'Extensions' },
  { key: 'agents', label: 'Agents' },
];

/** Responsive card grid — as many columns as fit at ≥260px each. */
const GRID_CLASS = 'grid gap-3 grid-cols-[repeat(auto-fill,minmax(260px,1fr))]';

/**
 * Card shell shared by both card types. `flex-col` + `flex-1` on the body
 * lets the inner column stretch to the full row height so `mt-auto` can
 * pin the version/install row to the bottom of every card.
 *
 * `resource-card` carries the border override — the global .ant-card rule
 * in index.css is `!important` and outranks Tailwind utilities, so the
 * accent border for this grid lives there.
 */
const CARD_CLASS = 'resource-card h-full flex flex-col';
const CARD_BODY_STYLE = { flex: 1, display: 'flex', flexDirection: 'column' } as const;

/** Resource chip inside a collection card — click to install that one item. */
const CHIP_CLASS =
  'px-2 py-[1px] rounded-md text-xs leading-5 transition-colors ' +
  'border border-[var(--border-mid)] bg-[var(--bg-faint-08)] text-[var(--text-secondary)] ' +
  'hover:border-[var(--accent-start)] hover:text-[var(--accent-start)] hover:bg-[var(--glow)] ' +
  'disabled:cursor-not-allowed disabled:opacity-70';

/**
 * Build the SSE install endpoint for an item. Updating an already-installed
 * resource appends force=1 so the server overwrites existing files with the
 * latest cached copy.
 */
function installPathFor(item: ResourceItem): string {
  const q = new URLSearchParams({
    type: item.type,
    name: item.name,
  });
  if (item.installedVersion) q.set('force', '1');
  return `/install/resource?${q.toString()}`;
}

/**
 * Render the version cell. Behavior:
 * - Both null → no versions known yet (legacy / npx fallback)
 * - installed null, latest set → "未安装 v<latest>"
 * - installed set, latest null → "v<installed>"
 * - both equal → "v<latest>" + green "已是最新" tag
 * - both differ → "v<installed> → v<latest>" + amber "可更新" tag
 */
function VersionLine({ item }: { item: ResourceItem }) {
  const { installedVersion, latestVersion } = item;
  const dim = 'text-xs text-[var(--text-tertiary)]';
  const strong = 'text-xs text-[var(--text-primary)]';
  if (!installedVersion && !latestVersion) {
    return <span className={dim}>版本未知</span>;
  }
  if (!installedVersion && latestVersion) {
    return (
      <Space size={4}>
        <span className={dim}>未安装</span>
        <Tag color="blue">v{latestVersion}</Tag>
      </Space>
    );
  }
  if (installedVersion === latestVersion) {
    return (
      <Space size={4}>
        <span className={strong}>v{installedVersion}</span>
        <Tag icon={<CheckCircleOutlined />} color="success">已是最新</Tag>
      </Space>
    );
  }
  return (
    <Space size={4}>
      <span className={dim}>v{installedVersion}</span>
      <span className={dim}>→</span>
      <span className={strong}>v{latestVersion}</span>
      <Tag color="warning">可更新</Tag>
    </Space>
  );
}

/** A collection row plus the resources nested under it. */
interface ResourceGroup {
  collection: ResourceItem;
  children: ResourceItem[];
}

/**
 * Split the flat server list into collection groups and top-level
 * singletons. Child entries carry the collection prefix in their name
 * ("golang-lan-sets/golang-patterns"), so they attach to the collection
 * card instead of getting a card of their own.
 */
function groupResources(resources: ResourceItem[]): {
  collections: ResourceGroup[];
  singles: ResourceItem[];
} {
  const collections = new Map<string, ResourceGroup>();
  for (const item of resources) {
    if (item.isCollection) {
      collections.set(item.name, { collection: item, children: [] });
    }
  }

  const singles: ResourceItem[] = [];
  for (const item of resources) {
    if (item.isCollection) continue;
    const slashIdx = item.name.indexOf('/');
    const parent = slashIdx >= 0 ? collections.get(item.name.slice(0, slashIdx)) : undefined;
    if (parent) {
      parent.children.push(item);
      continue;
    }
    singles.push(item);
  }

  return { collections: [...collections.values()], singles };
}

/**
 * Button label for a resource row:
 *   - not installed → "安装" / "安装全部 (N 项)"
 *   - installed     → "更新" / "更新全部 (N 项)"（点击强制用最新缓存覆盖本地）
 */
function installButtonLabel(item: ResourceItem): string {
  const isInstalled = !!item.installedVersion;
  if (item.isCollection) {
    const suffix = ` (${item.collectionSize ?? 0} 项)`;
    return isInstalled ? `更新全部${suffix}` : `安装全部${suffix}`;
  }
  return isInstalled ? '更新' : '安装';
}

interface CardHandlers {
  onInstall: (item: ResourceItem) => void;
  installingName: string | undefined;
}

function InstallButton({ item, handlers }: { item: ResourceItem; handlers: CardHandlers }) {
  const isInstalled = !!item.installedVersion;
  const label = installButtonLabel(item);
  return (
    <Button
      size="small"
      type={isInstalled ? 'default' : 'primary'}
      icon={
        isInstalled ? (
          <SyncOutlined />
        ) : item.isCollection ? (
          <FolderOutlined />
        ) : (
          <DownloadOutlined />
        )
      }
      loading={handlers.installingName === item.name}
      aria-label={label}
      onClick={() => handlers.onInstall(item)}
    >
      {label}
    </Button>
  );
}

/** Card for a single (non-collection) resource. */
function ResourceCard({ item, handlers }: { item: ResourceItem; handlers: CardHandlers }) {
  return (
    <Card size="small" className={CARD_CLASS} styles={{ body: CARD_BODY_STYLE }}>
      <div className="flex flex-col gap-2 h-full">
        <div className="flex items-center gap-2 min-w-0">
          <FileOutlined className="text-[var(--text-tertiary)]" />
          <span className="text-sm font-medium truncate text-[var(--text-primary)]" title={item.name}>
            {item.name}
          </span>
        </div>
        {item.description ? (
          <p
            className="m-0 text-xs leading-relaxed text-[var(--text-secondary)] line-clamp-3"
            title={item.description}
          >
            {item.description}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-2 mt-auto pt-1">
          <VersionLine item={item} />
          <InstallButton item={item} handlers={handlers} />
        </div>
      </div>
    </Card>
  );
}

/**
 * Card for a collection. Contained resources show up as clickable tags
 * (each installs on its own, matching the previous tree leaf behavior);
 * the card button installs every child in one shot.
 */
function CollectionCard({ group, handlers }: { group: ResourceGroup; handlers: CardHandlers }) {
  const { collection, children } = group;
  return (
    <Card size="small" className={CARD_CLASS} styles={{ body: CARD_BODY_STYLE }}>
      <div className="flex flex-col gap-2 h-full">
        <div className="flex items-center gap-2 min-w-0">
          <FolderOutlined className="text-[var(--accent-start)]" />
          <span className="text-sm font-medium truncate text-[var(--text-primary)]" title={collection.name}>
            {collection.name}
          </span>
          {collection.isPlatformFolder ? (
            <Tag color="geekblue">平台</Tag>
          ) : (
            <Tag color="purple">集合</Tag>
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          {children.map((child) => {
            const shortName = child.name.slice(child.name.indexOf('/') + 1);
            const isInstalling = handlers.installingName === child.name;
            return (
              <button
                key={child.name}
                type="button"
                className={CHIP_CLASS}
                title={child.description ?? child.name}
                disabled={!!handlers.installingName && !isInstalling}
                onClick={() => handlers.onInstall(child)}
              >
                {isInstalling ? (
                  <Space size={4}>
                    <SyncOutlined spin className="text-[var(--accent-start)]" />
                    {shortName}
                  </Space>
                ) : (
                  shortName
                )}
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-2 mt-auto pt-1">
          <span className="text-xs text-[var(--text-tertiary)]">
            共 {children.length} 项 · 点标签可单独安装
          </span>
          <InstallButton item={collection} handlers={handlers} />
        </div>
      </div>
    </Card>
  );
}

export default function Resources() {
  const [activeTab, setActiveTab] = useState<ResourceType>('skills');
  const [resources, setResources] = useState<ResourceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState<ResourceItem | null>(null);
  const [globalRefreshing, setGlobalRefreshing] = useState(false);
  const [installEvents, setInstallEvents] = useState<SseEvent[]>([]);
  // Bump on each install so the SSE subscriber remounts with a fresh URL.
  const [installSeq, setInstallSeq] = useState(0);

  const fetchResources = async (type: ResourceType) => {
    setLoading(true);
    try {
      const data = await api.get<ResourceItem[]>(`/resources/${type}`);
      setResources(data);
    } catch (err) {
      console.error(err);
      setResources([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchResources(activeTab);
  }, [activeTab]);

  const handleInstall = (item: ResourceItem) => {
    if (installing) return;
    setInstallEvents([]);
    setInstalling(item);
    setInstallSeq((n) => n + 1);
  };

  // Global refresh button: re-fetches the latest plugin version from npm
  // and re-extracts ~/.zai/zn-assets/<version>/, regardless of TTL or
  // current state.
  const handleGlobalRefresh = async () => {
    if (globalRefreshing) return;
    setGlobalRefreshing(true);
    const hide = message.loading('正在刷新资源缓存…', 0);
    try {
      const result = await api.post<{
        latestVersion: string;
        cachedVersions: string[];
      }>('/refresh/resources');
      hide();
      message.success(
        `已刷新到 v${result.latestVersion}（缓存 ${result.cachedVersions.length} 个版本）`,
      );
      await fetchResources(activeTab);
    } catch (err) {
      hide();
      console.error(err);
    } finally {
      setGlobalRefreshing(false);
    }
  };

  const groups = useMemo(() => groupResources(resources), [resources]);
  const handlers: CardHandlers = {
    onInstall: handleInstall,
    installingName: installing?.name,
  };

  return (
    <div className="p-6 space-y-4">
      <Card
        title={<Typography.Title level={4} style={{ margin: 0 }}>资源管理</Typography.Title>}
        extra={
          <Button
            icon={<SyncOutlined />}
            loading={globalRefreshing}
            onClick={handleGlobalRefresh}
          >
            刷新资源缓存
          </Button>
        }
      >
        <Tabs
          activeKey={activeTab}
          onChange={(key) => setActiveTab(key as ResourceType)}
          items={tabs.map((tab) => ({
            key: tab.key,
            label: tab.label,
            children: loading ? (
              <Spin className="block my-10" />
            ) : resources.length === 0 ? (
              <Empty description='暂无资源 — 点击右上角"刷新资源缓存"加载' />
            ) : (
              <div className={GRID_CLASS}>
                {groups.collections.map((group) => (
                  <CollectionCard key={group.collection.name} group={group} handlers={handlers} />
                ))}
                {groups.singles.map((item) => (
                  <ResourceCard key={item.name} item={item} handlers={handlers} />
                ))}
              </div>
            ),
          }))}
        />
      </Card>

      {installing && (
        <Card title={`安装日志: ${installing.name}`}>
          <LogPanel events={installEvents} />
          <InstallSseSubscriber
            key={`${installing.type}-${installing.name}-${installSeq}`}
            path={installPathFor(installing)}
            onEvent={(ev) => setInstallEvents((prev) => [...prev, ev])}
            onEnd={() => {
              message.success(`${installing.name} ${installing.installedVersion ? '更新完成' : '安装完成'}`);
              setInstalling(null);
              // Re-fetch to reflect the just-installed version in the list.
              fetchResources(activeTab);
            }}
          />
        </Card>
      )}
    </div>
  );
}

// SSE subscriber rendered as a child so useSse is called inside a render —
// the Rules of Hooks require this. Calling useSse directly from an event
// handler (the previous version) never produced an EventSource because the
// useEffect it schedules is not processed outside a render.
function InstallSseSubscriber({
  path,
  onEvent,
  onEnd,
}: {
  path: string;
  onEvent: (ev: SseEvent) => void;
  onEnd: () => void;
}) {
  useSse(path, onEvent, onEnd);
  return null;
}