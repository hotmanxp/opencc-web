import { Card, Form, Input, Button, message, Spin, Row, Col, Typography, Menu, List, Popconfirm, Select, Space, Modal, Tooltip } from 'antd';
import { PlusOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ConfigTool, ProviderProfile, SystemInfo } from '@shared/types';
import { api } from '../lib/api';

const { Text } = Typography;

const tools: { key: ConfigTool; label: string }[] = [
  { key: 'opencc', label: 'OpenCC' },
  { key: 'opencode', label: 'OpenCode' },
  { key: 'nova', label: 'Nova' },
];

const KNOWN_PROVIDERS = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'azure', label: 'Azure OpenAI' },
  { value: 'google', label: 'Google AI' },
  { value: '自定义', label: '自定义 Provider' },
];

const BUILTIN_PROFILES: ProviderProfile[] = [
  {
    id: 'provider_f55e52139db6',
    name: 'Anthropic-MIX',
    provider: 'anthropic',
    baseUrl: 'https://zn-nova.paic.com.cn/novai',
    model: 'MiniMax-M3,MiniMax-M2.7-highspeed,qwen3.7-plus,glm-5.2,qwen3.7-max,deepseek-v4-flash,deepseek-v4-pro',
  },
  {
    id: 'provider_61d7d2e26e62',
    name: 'OpenAI-Mix',
    provider: 'openai',
    baseUrl: 'https://wizard-ai.paic.com.cn/code_pilot/api/v1',
    model: 'zhiniao-MiniMax-M2.7,zhiniao-MiniMax-M2.7-highspeed,zhiniao-qwen3.6-plus,zhiniao-glm-5.1',
    apiFormat: 'chat_completions',
  },
];

const OPENCC_DEFAULT_CONTENT: Record<string, unknown> = {
  permissions: {
    allow: [
      'Bash(*)',
      'Read',
      'Write',
      'Edit',
      'Monitor(*)',
      'mcp__chrome-devtools-mcp__*',
      'mcp__codegraph__codegraph_search',
      'mcp__codegraph__codegraph_context',
      'mcp__codegraph__codegraph_callers',
      'mcp__codegraph__codegraph_callees',
      'mcp__codegraph__codegraph_impact',
      'mcp__codegraph__codegraph_node',
      'mcp__codegraph__codegraph_status',
    ],
    defaultMode: 'bypassPermissions',
  },
  attribution: {
    commit: '',
  },
  env: {
    ANTHROPIC_BASE_URL: 'https://zn-nova.paic.com.cn/novai',
    OPENAI_BASE_URL: 'https://wizard-ai.paic.com.cn/code_pilot/api/v1',
  },
  extraKnownMarketplaces: {
    'zn-plugins-market': {
      source: {
        source: 'git',
        url: 'git@code.paic.com.cn:git/zn-agent-assets.git',
      },
    },
  },
};

function ProviderForm() {
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();

  const fetchProfiles = async () => {
    setLoading(true);
    try {
      const data = await api.get<{ profiles: ProviderProfile[] }>('/config/opencc/provider');
      setProfiles(data.profiles || []);
    } catch {
      message.error('加载 Provider 失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProfiles();
  }, []);

  const openAddModal = () => {
    // Pre-fill with the first existing profile, or the first builtin as a starting point.
    // The user said "以我的当前的配置未初始值（默认值）" — current config first, then builtin fallback.
    const seed = profiles[0] ?? BUILTIN_PROFILES[0];
    form.setFieldsValue({
      provider: seed.provider,
      name: seed.name,
      baseUrl: seed.baseUrl,
      model: seed.model,
      apiFormat: seed.apiFormat,
    });
    setModalOpen(true);
  };

  // Watch the Provider select so switching anthropic ↔ openai auto-refills
  // the rest of the form with the matching builtin defaults. This makes the
  // modal behave as a "one-click preset" for both protocol flavours.
  const watchedProvider = Form.useWatch('provider', form);
  useEffect(() => {
    if (!modalOpen) return;
    if (watchedProvider !== 'anthropic' && watchedProvider !== 'openai') return;
    const preset = BUILTIN_PROFILES.find((p) => p.provider === watchedProvider);
    if (!preset) return;
    form.setFieldsValue({
      name: preset.name,
      baseUrl: preset.baseUrl,
      model: preset.model,
      apiFormat: preset.apiFormat,
    });
  }, [watchedProvider, modalOpen, form]);

  const handleModalOk = async () => {
    try {
      const values = await form.validateFields();
      const newProfile: ProviderProfile = {
        id: `provider_${Date.now()}`,
        name: values.name,
        provider: values.provider,
        baseUrl: values.baseUrl,
        model: values.model,
        apiFormat: values.apiFormat,
      };
      const updated = [...profiles, newProfile];
      setSaving(true);
      await api.put('/config/opencc/provider', { profiles: updated });
      setProfiles(updated);
      message.success('Provider 已添加');
      setModalOpen(false);
    } catch (err) {
      if (err instanceof Error) message.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    const updated = profiles.filter((p) => p.id !== id);
    setSaving(true);
    try {
      await api.put('/config/opencc/provider', { profiles: updated });
      setProfiles(updated);
      message.success('已删除');
    } catch {
      message.error('删除失败');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Spin />;

  return (
    <Card
      title="Provider 一键配置"
      size="small"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openAddModal}>
          添加
        </Button>
      }
    >
      <Text type="secondary" style={{ marginBottom: 8, display: 'block' }}>
        已配置 {profiles.length} 个 Provider
      </Text>

      <List
        dataSource={profiles}
        locale={{ emptyText: '暂无配置的 Provider，点击右上角"添加"创建' }}
        renderItem={(item) => (
          <List.Item
            actions={[
              <Popconfirm key="del" title="确定删除？" onConfirm={() => item.id && handleDelete(item.id)}>
                <Button type="text" danger size="small" icon={<DeleteOutlined />} loading={saving} />
              </Popconfirm>,
            ]}
          >
            <List.Item.Meta
              title={item.name || item.provider}
              description={
                <Space direction="vertical" size={0}>
                  <Text type="secondary" style={{ fontSize: 12 }}>Provider: {item.provider}</Text>
                  {item.baseUrl && <Text type="secondary" style={{ fontSize: 12 }}>BaseURL: {item.baseUrl}</Text>}
                  {item.model && <Text type="secondary" style={{ fontSize: 12 }}>模型: {item.model}</Text>}
                </Space>
              }
            />
          </List.Item>
        )}
      />

      <Modal
        title="添加 Provider"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleModalOk}
        confirmLoading={saving}
        okText="确定"
        cancelText="取消"
        destroyOnClose
        width={600}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="provider" label="Provider" rules={[{ required: true, message: '请选择 Provider' }]}>
            <Select placeholder="选择 Provider" options={KNOWN_PROVIDERS} />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="如 Anthropic-MIX" />
          </Form.Item>
          <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true, message: '请输入 Base URL' }]}>
            <Input placeholder="https://api.openai.com/v1" />
          </Form.Item>
          <Form.Item name="model" label="模型" rules={[{ required: true, message: '请输入模型' }]}>
            <Input placeholder="MiniMax-M2.7-highspeed" />
          </Form.Item>
          <Form.Item name="apiFormat" label="API 格式（可选）">
            <Select
              allowClear
              placeholder="选择 API 格式"
              options={[
                { value: 'chat_completions', label: 'chat_completions' },
                { value: 'responses', label: 'responses' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

const BUILTIN_PLUGINS = [
  { value: 'oh-my-agents@latest', label: 'oh-my-agents@latest' },
];

function PluginForm() {
  const [plugin, setPlugin] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState('');

  const fetchPlugins = async () => {
    setLoading(true);
    try {
      const data = await api.get<{ content: { plugin?: string[] } }>('/config/opencode');
      setPlugin(data.content?.plugin || []);
    } catch {
      message.error('加载插件失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPlugins();
  }, []);

  const persist = async (next: string[]) => {
    setSaving(true);
    try {
      // Read-modify-write: keep all other fields intact, only swap `plugin`.
      // Avoid clobbering unrelated keys (provider, $schema, etc.) the user may
      // have added by hand.
      const data = await api.get<{ content: Record<string, unknown> }>('/config/opencode');
      const nextContent = { ...(data.content || {}), plugin: next };
      await api.put('/config/opencode', nextContent);
      setPlugin(next);
    } catch (err) {
      message.error(`保存失败: ${err}`);
    } finally {
      setSaving(false);
    }
  };

  const openAddModal = () => {
    setDraft(BUILTIN_PLUGINS[0].value);
    setModalOpen(true);
  };

  const handleAdd = async () => {
    const name = draft.trim();
    if (!name) {
      message.warning('请选择或输入插件名');
      return;
    }
    if (plugin.includes(name)) {
      message.warning('该插件已存在');
      return;
    }
    await persist([...plugin, name]);
    message.success('插件已添加');
    setModalOpen(false);
  };

  const handleDelete = async (name: string) => {
    await persist(plugin.filter((p) => p !== name));
    message.success('已删除');
  };

  if (loading) return <Spin />;

  return (
    <Card
      title="OpenCode 插件"
      size="small"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={openAddModal}>
          添加
        </Button>
      }
    >
      <Text type="secondary" style={{ marginBottom: 8, display: 'block' }}>
        已配置 {plugin.length} 个插件
      </Text>
      <List
        dataSource={plugin}
        locale={{ emptyText: '暂无插件，点击右上角"添加"安装到 opencode.json' }}
        renderItem={(item) => (
          <List.Item
            actions={[
              <Popconfirm key="del" title="确定删除？" onConfirm={() => handleDelete(item)}>
                <Button type="text" danger size="small" icon={<DeleteOutlined />} loading={saving} />
              </Popconfirm>,
            ]}
          >
            <code style={{ fontSize: 13, color: 'var(--accent-start)' }}>{item}</code>
          </List.Item>
        )}
      />

      <Modal
        title="添加插件"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleAdd}
        confirmLoading={saving}
        okText="确定"
        cancelText="取消"
        width={500}
        destroyOnClose
      >
        <Form layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label="选择内置插件">
            <Select
              value={draft}
              onChange={(v) => setDraft(v)}
              placeholder="选择插件"
              options={BUILTIN_PLUGINS}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

function SettingsEditor({ tool, label, defaultContent }: { tool: ConfigTool; label: string; defaultContent?: Record<string, unknown> }) {
  const [content, setContent] = useState<Record<string, unknown> | null>(null);
  const [filePath, setFilePath] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchContent = async () => {
    setLoading(true);
    try {
      const data = await api.get<{ path: string; exists: boolean; content: Record<string, unknown>; missing?: boolean }>(`/config/${tool}`);
      setFilePath(data.path);
      setContent(data.content);
      setMissing(!!data.missing);
    } catch {
      message.error('加载配置失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchContent();
  }, [tool]);

  const openEditor = () => {
    // When the file is missing, seed the editor with `defaultContent` (or {})
    // so the user can adjust before clicking save to create the file.
    const seed = missing ? (defaultContent ?? {}) : (content ?? {});
    setDraft(JSON.stringify(seed, null, 2));
    setModalOpen(true);
  };

  const handleSave = async () => {
    // Validate JSON before sending — the server is the source of truth but a
    // client-side check gives instant feedback and avoids round-trip on
    // obviously bad input.
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch (err) {
      message.error(`JSON 解析失败: ${(err as Error).message}`);
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      message.error('配置文件必须是 JSON 对象');
      return;
    }
    setSaving(true);
    try {
      await api.put(`/config/${tool}`, parsed as Record<string, unknown>);
      message.success('配置已保存');
      setModalOpen(false);
      await fetchContent();
    } catch (err) {
      message.error(`保存失败: ${err}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Spin />;

  return (
    <Card
      title={`${label} settings`}
      size="small"
      extra={
        <Button type="primary" icon={<EditOutlined />} onClick={openEditor}>
          {missing ? '新增' : '编辑'}
        </Button>
      }
      style={{ marginTop: 16, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
      styles={{ body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 12 } }}
    >
      <Tooltip title={filePath}>
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
          路径: {filePath}{missing && ' (文件不存在，保存后将创建)'}
        </Text>
      </Tooltip>
      <pre
        style={{
          background: 'var(--bg-body)',
          color: 'var(--text-primary)',
          padding: 12,
          borderRadius: 8,
          fontSize: 12,
          lineHeight: 1.6,
          overflow: 'auto',
          flex: 1,
          minHeight: 0,
          margin: 0,
          fontFamily: 'JetBrains Mono, Fira Code, monospace',
        }}
      >
        {JSON.stringify(content ?? {}, null, 2)}
      </pre>

      <Modal
        title={`编辑 ${label} settings`}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSave}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        width={760}
        destroyOnClose
      >
        <Input.TextArea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoSize={{ minRows: 16, maxRows: 30 }}
          spellCheck={false}
          style={{ fontFamily: 'JetBrains Mono, Fira Code, monospace', fontSize: 12 }}
        />
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          必须是合法 JSON 对象。保存时自动校验。
        </Text>
      </Modal>
    </Card>
  );
}

export default function Config() {
  const [searchParams] = useSearchParams();
  const initialTool = searchParams.get('tool') as ConfigTool | null;
  const [activeTool, setActiveTool] = useState<ConfigTool>(initialTool || 'opencc');
  // Platform comes from the server (process.platform) so client detection is
  // authoritative and doesn't depend on user-agent sniffing.
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);

  useEffect(() => {
    api
      .get<SystemInfo>('/system')
      .then(setSystemInfo)
      .catch(() => setSystemInfo(null));
  }, []);

  // OpenCode config defaults. On Windows, set `shell: "cmd"` so the bash tool
  // routes through cmd.exe by default. Free-form string per OpenCode schema.
  const opencodeDefaultContent: Record<string, unknown> = {
    ...(systemInfo?.platform === 'win32' ? { shell: 'cmd' } : {}),
  };

  const handleMenuClick = ({ key }: { key: string }) => {
    setActiveTool(key as ConfigTool);
  };

  return (
    <Row gutter={24}>
      <Col xs={24} md={6}>
        <Card size="small">
          <Menu
            mode="inline"
            selectedKeys={[activeTool]}
            onClick={handleMenuClick}
            items={tools.map((t) => ({
              key: t.key,
              label: t.label,
            }))}
          />
        </Card>
      </Col>
      <Col
        xs={24}
        md={18}
        style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 112px)' }}
      >
        {activeTool === 'opencc' ? (
          <>
            <ProviderForm />
            <SettingsEditor tool="opencc" label="OpenCC" defaultContent={OPENCC_DEFAULT_CONTENT} />
          </>
        ) : activeTool === 'opencode' ? (
          <>
            <PluginForm />
            <SettingsEditor tool="opencode" label="OpenCode" defaultContent={opencodeDefaultContent} />
          </>
        ) : (
          <SettingsEditor tool={activeTool} label={tools.find((t) => t.key === activeTool)?.label || activeTool} />
        )}
      </Col>
    </Row>
  );
}
