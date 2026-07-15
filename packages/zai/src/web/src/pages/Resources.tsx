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
  Modal,
  Form,
  Input,
  Select,
  Popconfirm,
} from 'antd';
import type { DataNode } from 'antd/es/tree';
import {
  DownloadOutlined,
  SyncOutlined,
  CheckCircleOutlined,
  FolderOutlined,
  FileOutlined,
  EditOutlined,
  DeleteOutlined,
  PlusOutlined,
  CopyOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useState, useMemo } from 'react';
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
      console.error(err);
      setResources([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchResources(activeTab);
  }, [activeTab]);

  const [commandList, setCommandList] = useState<Array<{ name: string; description?: string; argumentHint?: string; whenToUse?: string }>>([])
  const [commandLoading, setCommandLoading] = useState(false)
  const [editingCommand, setEditingCommand] = useState<null | { name: string; frontmatter: Record<string, unknown>; body: string }>(null)
  const [editingIsNew, setEditingIsNew] = useState(false)
  const [commandForm] = Form.useForm()

  const fetchCommandList = useCallback(async () => {
    setCommandLoading(true)
    try {
      const res = await fetch('/api/agent/commands')
      const data = await res.json()
      setCommandList(Array.isArray(data.items) ? data.items : [])
    } catch {
      setCommandList([])
    } finally {
      setCommandLoading(false)
    }
  }, [])

  useEffect(() => { fetchCommandList() }, [fetchCommandList])

  const openCreateCommand = () => {
    setEditingIsNew(true)
    setEditingCommand({ name: '', frontmatter: { description: '', argumentHint: '' }, body: '' })
    commandForm.resetFields()
  }

  const openEditCommand = async (name: string) => {
    try {
      const res = await fetch(`/api/agent/commands/${encodeURIComponent(name)}`)
      if (!res.ok) { message.error('读取失败'); return }
      const data = await res.json()
      setEditingIsNew(false)
      setEditingCommand({ name: data.name, frontmatter: data.frontmatter ?? {}, body: data.body ?? '' })
      commandForm.setFieldsValue({
        name: data.name,
        description: data.frontmatter?.description ?? '',
        argumentHint: data.frontmatter?.argumentHint ?? '',
        argNames: Array.isArray(data.frontmatter?.argNames) ? data.frontmatter.argNames.join(', ') : '',
        allowedTools: Array.isArray(data.frontmatter?.allowedTools) ? data.frontmatter.allowedTools.join(', ') : '',
        model: data.frontmatter?.model ?? '',
        effort: data.frontmatter?.effort ?? '',
        body: data.body ?? '',
      })
    } catch (err) {
      message.error(`读取失败: ${(err as Error).message}`)
    }
  }

  const submitCommand = async () => {
    const v = await commandForm.validateFields()
    const fm: Record<string, unknown> = {}
    if (v.description) fm.description = v.description
    if (v.argumentHint) fm.argumentHint = v.argumentHint
    if (v.argNames) fm.argNames = v.argNames.split(',').map((s: string) => s.trim()).filter(Boolean)
    if (v.allowedTools) fm.allowedTools = v.allowedTools.split(',').map((s: string) => s.trim()).filter(Boolean)
    if (v.model) fm.model = v.model
    if (v.effort) fm.effort = v.effort
    const name = v.name
    try {
      const res = editingIsNew
        ? await fetch('/api/agent/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, frontmatter: fm, body: v.body }) })
        : await fetch(`/api/agent/commands/${encodeURIComponent(name)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ frontmatter: fm, body: v.body }) })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        message.error(err.error ?? `HTTP ${res.status}`)
        return
      }
      message.success(editingIsNew ? '已创建' : '已更新')
      setEditingCommand(null)
      fetchCommandList()
    } catch (err) {
      message.error(`保存失败: ${(err as Error).message}`)
    }
  }

  const deleteCommand = async (name: string) => {
    try {
      const res = await fetch(`/api/agent/commands/${encodeURIComponent(name)}`, { method: 'DELETE' })
      if (!res.ok) { message.error('删除失败'); return }
      message.success('已删除')
      fetchCommandList()
    } catch (err) {
      message.error(`删除失败: ${(err as Error).message}`)
    }
  }

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
      console.error(err);
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

      <Card title="用户命令 (User Commands)" extra={
        <Button icon={<PlusOutlined />} type="primary" onClick={openCreateCommand}>新建</Button>
      }>
        {commandLoading ? <Spin /> : commandList.length === 0 ? (
          <Empty description="暂无用户命令" />
        ) : (
          <Space direction="vertical" style={{ width: '100%' }}>
            {commandList.map((c) => (
              <Card key={c.name} size="small" type="inner"
                title={<Space><Typography.Text code>/{c.name}</Typography.Text>{c.description && <Typography.Text type="secondary">{c.description}</Typography.Text>}</Space>}
                extra={
                  <Space>
                    <Button icon={<EditOutlined />} size="small" onClick={() => openEditCommand(c.name)}>编辑</Button>
                    <Popconfirm title={`删除 /${c.name}?`} onConfirm={() => deleteCommand(c.name)}>
                      <Button icon={<DeleteOutlined />} size="small" danger>删除</Button>
                    </Popconfirm>
                  </Space>
                }
              >
                {c.argumentHint && <Tag>arg: {c.argumentHint}</Tag>}
                {c.whenToUse && <Typography.Text type="secondary"> {c.whenToUse}</Typography.Text>}
              </Card>
            ))}
          </Space>
        )}
      </Card>

      <Modal
        open={editingCommand !== null}
        title={editingIsNew ? '新建用户命令' : `编辑 /${editingCommand?.name ?? ''}`}
        onCancel={() => setEditingCommand(null)}
        onOk={submitCommand}
        okText="保存"
        cancelText="取消"
        width={720}
        destroyOnClose
      >
        <Form form={commandForm} layout="vertical" preserve={false}>
          <Form.Item label="name" name="name" rules={[
            { required: true, message: '必填' },
            { pattern: /^[a-z0-9][a-z0-9-_]*$/, message: '小写字母/数字/-/_ 开头' },
          ]}>
            <Input disabled={!editingIsNew} placeholder="例如 greet" />
          </Form.Item>
          <Form.Item label="description" name="description"><Input /></Form.Item>
          <Form.Item label="argumentHint" name="argumentHint"><Input placeholder="例如 [name]" /></Form.Item>
          <Form.Item label="argNames (逗号分隔)" name="argNames"><Input placeholder="例如 name, age" /></Form.Item>
          <Form.Item label="allowedTools (逗号分隔)" name="allowedTools"><Input /></Form.Item>
          <Form.Item label="model" name="model"><Input placeholder="例如 claude-3-5-sonnet" /></Form.Item>
          <Form.Item label="effort" name="effort">
            <Select allowClear options={[
              { value: 'low', label: 'low' }, { value: 'medium', label: 'medium' },
              { value: 'high', label: 'high' }, { value: 'max', label: 'max' },
            ]} />
          </Form.Item>
          <Form.Item label="body (markdown;可用 $ARGUMENTS / $1 / ${name})" name="body" rules={[{ required: true, message: '必填' }]}>
            <Input.TextArea rows={10} placeholder="Hello $ARGUMENTS" />
          </Form.Item>
        </Form>
      </Modal>
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