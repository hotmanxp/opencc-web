import { Card, Row, Col, Button, Tag, Spin, Typography, Modal, Space, message } from 'antd';
import { SettingOutlined, DownloadOutlined, ReloadOutlined, SyncOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CliStatus, SseEvent } from '@shared/types';
import { api } from '../lib/api';
import { useSse } from '../lib/sse';
import LogPanel from '../components/LogPanel';

const { Text } = Typography;

interface ToolCardData {
  key: string;
  label: string;
  icon: string;
  desc: string;
  /** Whether this card has a "配置" entry. Internal helpers / dev tools have none. */
  configurable: boolean;
}

const TOOL_CARDS: ToolCardData[] = [
  {
    key: 'opencc',
    label: 'OpenCC',
    icon: '🔮',
    desc: 'OpenCC — Claude CLI 工具',
    configurable: true,
  },
  {
    key: 'opencode',
    label: 'OpenCode',
    icon: '⚡',
    desc: 'OpenCode — 代码智能助手',
    configurable: true,
  },
  {
    key: 'nova',
    label: 'Nova',
    icon: '🪄',
    desc: 'Nova CLI — AI 终端工具',
    configurable: true,
  },
  {
    key: 'codegraph',
    label: 'CodeGraph',
    icon: '🧭',
    desc: 'CodeGraph — MCP 代码智能服务',
    configurable: false,
  },
  {
    key: 'agent-login',
    label: 'Agent Login',
    icon: '🔐',
    desc: 'Agent Login — 凭证管理工具',
    configurable: false,
  },
  // zai 自身：从 /api/cli 的 CliStatus 拿真实状态，不再写死 "未安装"。
  // 当前 server 进程就是 zai，全局安装到 PATH 后这里会显示"已安装"+ 当前版本。
  {
    key: 'zai',
    label: 'zai',
    icon: '🐦',
    desc: '知鸟AI 平台（本工具）',
    configurable: false,
  },
];

export default function Tools() {
  const [tools, setTools] = useState<CliStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [installPkg, setInstallPkg] = useState<string | null>(null);
  const [installLabel, setInstallLabel] = useState<string>('');
  const [installEvents, setInstallEvents] = useState<SseEvent[]>([]);
  const [installSeq, setInstallSeq] = useState(0);
  const navigate = useNavigate();

  // 默认加载：currentVersion 每次都现拉（detect.ts 不缓存本地版本），
  // latestVersion 走 24h 缓存。
  const fetchTools = async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    try {
      const data = await api.get<CliStatus[]>(refresh ? '/cli?refresh=1' : '/cli');
      setTools(data);
    } catch {
      setTools([]);
    } finally {
      if (refresh) setRefreshing(false);
      else setLoading(false);
    }
  };

  useEffect(() => {
    fetchTools();
  }, []);

  const handleRefreshAll = async () => {
    await fetchTools(true);
    message.success('已重新拉取所有工具最新版本');
  };

  const handleInstall = (pkg: string, label: string) => {
    if (installPkg) return;
    setInstallEvents([]);
    setInstallPkg(pkg);
    setInstallLabel(label);
    setInstallSeq((n) => n + 1);
  };

  const getStatus = (card: ToolCardData) => {
    const t = tools.find((c) => c.name === card.key);
    if (!t) return { installed: false, currentVersion: null, latestVersion: null, upToDate: false };
    const upToDate =
      t.installed &&
      !!t.currentVersion &&
      !!t.latestVersion &&
      t.currentVersion === t.latestVersion;
    return { installed: t.installed, currentVersion: t.currentVersion, latestVersion: t.latestVersion, upToDate };
  };

  if (loading) return <Spin size="large" className="block mx-auto my-20" />;

  return (
    <div className="space-y-4">
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          icon={<SyncOutlined spin={refreshing} />}
          loading={refreshing}
          onClick={handleRefreshAll}
        >
          刷新最新版本
        </Button>
      </div>

      <Row gutter={[16, 16]}>
        {TOOL_CARDS.map((card) => {
          const status = getStatus(card);
          const cli = tools.find((c) => c.name === card.key);
          const showConfig = card.configurable && status.installed;

          return (
            <Col xs={24} md={8} key={card.key}>
              <Card
                style={{
                  borderTop: '2px solid',
                  borderImage: 'linear-gradient(90deg, #ff6600, #ff8533) 1',
                  cursor: 'default',
                }}
                styles={{ body: { padding: 24 } }}
              >
                <div style={{ textAlign: 'center', marginBottom: 20 }}>
                  <div style={{ fontSize: 48, lineHeight: 1 }}>{card.icon}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, marginTop: 12, color: 'var(--text-primary)' }}>
                    {card.label}
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                  {status.installed ? (
                    <Tag color="success">已安装</Tag>
                  ) : (
                    <Tag color="error">未安装</Tag>
                  )}
                  {status.installed && status.currentVersion && (
                    <span style={{ fontFamily: 'monospace', fontSize: 13 }}>
                      <span style={{ color: 'var(--success)' }}>{status.currentVersion}</span>
                      <span style={{ color: 'var(--text-tertiary)', margin: '0 4px' }}>/</span>
                      <span style={{ color: status.latestVersion ? 'var(--text-secondary)' : 'var(--text-tertiary)' }}>
                        {status.latestVersion ?? '?'}
                      </span>
                    </span>
                  )}
                  {status.upToDate && (
                    <Tag color="success" style={{ marginLeft: 0 }}>最新</Tag>
                  )}
                </div>

                <div
                  style={{
                    width: '80%',
                    margin: '0 auto',
                    display: 'flex',
                    justifyContent: 'center',
                    gap: 8,
                  }}
                >
                  <Button
                    type="primary"
                    style={{ flex: 1, minWidth: 0 }}
                    icon={status.installed ? <ReloadOutlined /> : <DownloadOutlined />}
                    loading={installPkg === cli?.pkg}
                    disabled={status.upToDate}
                    onClick={() => cli && handleInstall(cli.pkg, status.installed ? '更新' : '安装')}
                  >
                    {status.upToDate ? '已是最新' : (status.installed ? '更新' : '安装')}
                  </Button>
                  {showConfig && (
                    <Button
                      type="primary"
                      style={{ flex: 1, minWidth: 0 }}
                      icon={<SettingOutlined />}
                      onClick={() => navigate(`/config?tool=${card.key}`)}
                    >
                      配置
                    </Button>
                  )}
                </div>
              </Card>
            </Col>
          );
        })}
      </Row>

      <Modal
        title={`${installLabel}日志: ${installPkg}`}
        open={!!installPkg}
        onCancel={() => setInstallPkg(null)}
        footer={null}
        width={760}
        destroyOnClose
      >
        <LogPanel events={installEvents} />
        {installPkg && (
          <InstallSseSubscriber
            key={`${installPkg}-${installSeq}`}
            path={`/install/cli?pkg=${encodeURIComponent(installPkg)}`}
            onEvent={(ev) => setInstallEvents((prev) => [...prev, ev])}
            onEnd={() => {
              const last = installEvents[installEvents.length - 1];
              if (last?.type === 'exit' && last.code === 0) {
                message.success(`${installLabel}完成`);
                fetchTools();
              }
            }}
          />
        )}
      </Modal>
    </div>
  );
}

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
