import {
  Tabs,
  Button,
  Spin,
  message,
  Card,
  Empty,
  Typography,
  Space,
  Tag,
  Tree,
} from 'antd';
import type { DataNode } from 'antd/es/tree';
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
  if (!installedVersion && !latestVersion) {
    return <Typography.Text type="secondary">版本未知</Typography.Text>;
  }
  if (!installedVersion && latestVersion) {
    return (
      <Space size={4}>
        <Typography.Text type="secondary">未安装</Typography.Text>
        <Tag color="blue">v{latestVersion}</Tag>
      </Space>
    );
  }
  if (installedVersion === latestVersion) {
    return (
      <Space size={4}>
        <Typography.Text>v{installedVersion}</Typography.Text>
        <Tag icon={<CheckCircleOutlined />} color="success">已是最新</Tag>
      </Space>
    );
  }
  return (
    <Space size={4}>
      <Typography.Text type="secondary">v{installedVersion}</Typography.Text>
      <Typography.Text type="secondary">→</Typography.Text>
      <Typography.Text>v{latestVersion}</Typography.Text>
      <Tag color="warning">可更新</Tag>
    </Space>
  );
}

export default function Resources() {
  const [activeTab, setActiveTab] = useState<ResourceType>('skills');
  const [resources, setResources] = useState<ResourceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState<ResourceItem | null>(null);
  const [globalRefreshing, setGlobalRefreshing] = useState(false);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  const [installEvents, setInstallEvents] = useState<SseEvent[]>([]);
  // Bump on each install so the SSE subscriber remounts with a fresh URL.
  const [installSeq, setInstallSeq] = useState(0);

  const fetchResources = async (type: ResourceType) => {
    setLoading(true);
    try {
      const data = await api.get<ResourceItem[]>(`/resources/${type}`);
      setResources(data);
      // Default-expand all collection nodes so users see the tree shape
      // without having to click every folder.
      setExpandedKeys(
        data.filter((i) => i.isCollection).map((i) => `${type}/${i.name}`),
      );
    } catch (err) {
      message.error(`加载失败: ${err}`);
      setResources([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchResources(activeTab);
  }, [activeTab]);

  const handleInstall = (item: ResourceItem) => {
    if (installing || item.installedVersion) return;
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
      message.error(`刷新失败: ${err}`);
    } finally {
      setGlobalRefreshing(false);
    }
  };

  /**
   * Build an antd Tree from the flat resource list. The list mixes
   * collection entries (isCollection=true) and child resources whose
   * names already carry the collection prefix (e.g.
   * "golang-lan-sets/golang-patterns"). We group child entries under
   * their parent collection and leave top-level singletons as root
   * leaves.
   */
  const treeData = useMemo<DataNode[]>(() => {
    const collectionNodes = new Map<string, DataNode>();
    const rootNodes = new Map<string, DataNode>();

    const makeTitle = (item: ResourceItem, isFolder: boolean) =>
      renderNodeTitle(item, isFolder, {
        onInstall: handleInstall,
        installingName: installing?.name,
      });

    for (const item of resources) {
      if (item.isCollection) {
        collectionNodes.set(item.name, {
          key: `${item.type}/${item.name}`,
          title: makeTitle(item, true),
          children: [],
          selectable: false,
        });
        continue;
      }
      // Nested resource → attach to its collection node.
      const slashIdx = item.name.indexOf('/');
      if (slashIdx >= 0) {
        const colName = item.name.slice(0, slashIdx);
        const colNode = collectionNodes.get(colName);
        if (colNode) {
          colNode.children!.push({
            key: `${item.type}/${item.name}`,
            title: makeTitle(item, false),
            isLeaf: true,
            selectable: false,
          });
        }
        continue;
      }
      // Top-level single resource.
      rootNodes.set(item.name, {
        key: `${item.type}/${item.name}`,
        title: makeTitle(item, false),
        isLeaf: true,
        selectable: false,
      });
    }

    // Collections first, then top-level singletons (e.g. "planning-with-files").
    return [...collectionNodes.values(), ...rootNodes.values()];
  }, [resources, installing]);

  return (
    <div className="space-y-4">
      <Card
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
              <Tree
                showLine={{ showLeafIcon: false }}
                blockNode
                expandedKeys={expandedKeys}
                onExpand={(keys) => setExpandedKeys(keys)}
                treeData={treeData}
                style={{ rowGap: 8 }}
              />
            ),
          }))}
        />
      </Card>

      {installing && (
        <Card title={`安装日志: ${installing.name}`}>
          <LogPanel events={installEvents} />
          <InstallSseSubscriber
            key={`${installing.type}-${installing.name}-${installSeq}`}
            path={`/install/resource?type=${encodeURIComponent(installing.type)}&name=${encodeURIComponent(installing.name)}`}
            onEvent={(ev) => setInstallEvents((prev) => [...prev, ev])}
            onEnd={() => {
              message.success(`${installing.name} 安装完成`);
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

interface NodeTitleHandlers {
  onInstall: (item: ResourceItem) => void;
  installingName: string | undefined;
}

/**
 * Render the title cell of a single tree node. Each row keeps exactly
 * one action button to avoid crowding the tree:
 *   - not installed → "安装" / "安装全部 (N 项)"
 *   - installed     → disabled "已装 vX.Y.Z"
 *
 * The row-level "更新" button was removed because the global "刷新资源
 * 缓存" button in the Card header already covers that flow, and showing
 * two buttons per node ate the available width.
 */
function renderNodeTitle(
  item: ResourceItem,
  isFolder: boolean,
  handlers: NodeTitleHandlers,
) {
  const isInstalled = !!item.installedVersion;
  const isInstalling = handlers.installingName === item.name;
  const installLabel = isInstalled
    ? `已装 v${item.installedVersion}`
    : isFolder
      ? `安装全部 (${item.collectionSize ?? 0} 项)`
      : '安装';

  return (
    <div className="flex items-center justify-between gap-3 w-full pr-4 py-2">
      <div className="flex items-center gap-2 min-w-0">
        {isFolder ? <FolderOutlined /> : <FileOutlined />}
        <span className="font-medium truncate">{item.name}</span>
        {item.isPlatformFolder ? (
          <Tag color="geekblue">平台</Tag>
        ) : item.isCollection ? (
          <Tag color="purple">集合</Tag>
        ) : null}
        {!isFolder ? <VersionLine item={item} /> : null}
      </div>
      <Space size={4} onClick={(e) => e.stopPropagation()}>
        <Button
          size="small"
          type={isInstalled ? 'default' : 'primary'}
          icon={isInstalled ? <CheckCircleOutlined /> : isFolder ? <FolderOutlined /> : <DownloadOutlined />}
          loading={isInstalling}
          disabled={isInstalled}
          onClick={() => handlers.onInstall(item)}
        >
          {installLabel}
        </Button>
      </Space>
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