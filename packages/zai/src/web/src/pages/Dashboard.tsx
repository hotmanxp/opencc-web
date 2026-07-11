import { Card, Col, Row, Statistic, Button, Spin, Alert, message, Select } from 'antd';
import { RocketOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import type { SystemInfo, CliStatus, SseEvent } from '@shared/types';
import { KNOWN_REGISTRIES } from '@shared/types';
import { api } from '../lib/api';
import { useSse } from '../lib/sse';
import LogPanel from '../components/LogPanel';

export default function Dashboard() {
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [cliStatuses, setCliStatuses] = useState<CliStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [switchingRegistry, setSwitchingRegistry] = useState(false);
  const [quickstartEvents, setQuickstartEvents] = useState<SseEvent[]>([]);
  const [quickstartRunning, setQuickstartRunning] = useState(false);
  const [quickstartSeq, setQuickstartSeq] = useState(0);

  useEffect(() => {
    Promise.all([api.get<SystemInfo>('/system'), api.get<CliStatus[]>('/cli')])
      .then(([sys, cli]) => {
        setSystemInfo(sys);
        setCliStatuses(cli);
      })
      .catch((err) => message.error(`加载失败: ${err.message}`))
      .finally(() => setLoading(false));
  }, []);

  const handleQuickstart = () => {
    if (quickstartRunning) return;
    setQuickstartEvents([]);
    setQuickstartRunning(true);
    setQuickstartSeq((n) => n + 1);
  };

  const refreshStatuses = () => {
    setLoading(true);
    Promise.all([api.get<SystemInfo>('/system'), api.get<CliStatus[]>('/cli')])
      .then(([sys, cli]) => {
        setSystemInfo(sys);
        setCliStatuses(cli);
      })
      .finally(() => setLoading(false));
  };

  // Use the generic /api/exec endpoint to run `npm config set registry <url>`.
  // No bespoke backend route needed — exec already whitelists `npm` and
  // returns exit code via SSE.
  const handleSwitchRegistry = async (key: string) => {
    const opt = KNOWN_REGISTRIES.find((r) => r.key === key);
    if (!opt) return;
    setSwitchingRegistry(true);
    try {
      const exitCode = await runNpmConfigSet(opt.url);
      if (exitCode !== 0) {
        message.error(`切换失败，npm 退出码 ${exitCode}`);
        return;
      }
      message.success(`已切换 Registry: ${opt.label}`);
      // Refresh system info so the Statistic card shows the new value.
      const sys = await api.get<SystemInfo>('/system');
      setSystemInfo(sys);
    } catch (err) {
      message.error(`切换失败: ${(err as Error).message}`);
    } finally {
      setSwitchingRegistry(false);
    }
  };

  if (loading) return <Spin size="large" className="block mx-auto my-20" />;

  // Filter to only the AI-facing CLIs that the dashboard cares about.
  // agent-login is a credential helper, not an "AI tool" the user runs
  // day-to-day, so it lives on the Tools page but not here.
  const AI_TOOL_NAMES = ['nova', 'opencode', 'opencc'] as const;
  const aiTools = cliStatuses.filter((c) => AI_TOOL_NAMES.includes(c.name as typeof AI_TOOL_NAMES[number]));

  return (
    <div className="space-y-6">
      <Row gutter={[16, 16]}>
        <Col xs={24} md={12} lg={8}>
          <Card style={{ borderTop: '2px solid', borderImage: 'linear-gradient(90deg, #ff6600, #ff8533) 1' }}>
            <Statistic
              title="Node.js 版本"
              value={systemInfo?.nodeVersion || '未知'}
              prefix={
                systemInfo?.nodeMajor && systemInfo.nodeMajor >= 20 ? (
                  <CheckCircleOutlined style={{ color: 'var(--success)' }} />
                ) : (
                  <CloseCircleOutlined style={{ color: 'var(--error)' }} />
                )
              }
            />
          </Card>
        </Col>
        <Col xs={24} md={12} lg={8}>
          <Card style={{ borderTop: '2px solid', borderImage: 'linear-gradient(90deg, #ff6600, #ff8533) 1' }}>
            <Statistic
              title="npm 版本"
              value={systemInfo?.npmVersion || '未安装'}
              valueStyle={{ color: systemInfo?.npmVersion ? 'var(--success)' : 'var(--error)' }}
            />
          </Card>
        </Col>
        <Col xs={24} md={12} lg={8}>
          <Card style={{ borderTop: '2px solid', borderImage: 'linear-gradient(90deg, #ff6600, #ff8533) 1' }}>
            <div className="ant-statistic-title" style={{ marginBottom: 16 }}>CLI 工具</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              {aiTools.map((cli) => (
                <div
                  key={cli.name}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 14,
                    color: cli.installed ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    fontWeight: 500,
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: cli.installed ? 'var(--success)' : 'var(--text-tertiary)',
                    }}
                  />
                  {cli.name}
                </div>
              ))}
            </div>
          </Card>
        </Col>
      </Row>

      <Card
        title="npm Registry"
        extra={
          <Select
            style={{ width: 240 }}
            placeholder="选择 Registry"
            value={
              KNOWN_REGISTRIES.find((o) => o.url === systemInfo?.npmRegistry)?.key
            }
            loading={switchingRegistry}
            onChange={handleSwitchRegistry}
            options={KNOWN_REGISTRIES.map((o) => ({ value: o.key, label: o.label }))}
          />
        }
      >
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          当前 Registry：<code style={{ color: 'var(--accent-start)' }}>{systemInfo?.npmRegistry || '未知'}</code>
        </div>
      </Card>

      {systemInfo && systemInfo.nodeMajor < 20 && (
        <Alert
          type="warning"
          showIcon
          message="Node.js 版本过低"
          description="建议升级到 Node.js 20 或更高版本"
        />
      )}

      <Button type="primary" size="large" icon={<RocketOutlined />} onClick={handleQuickstart}>
        快速启动
      </Button>

      {quickstartRunning && (
        <Card title="快速启动日志">
          <LogPanel events={quickstartEvents} />
          <QuickstartSseSubscriber
            key={`quickstart-${quickstartSeq}`}
            path="/quickstart"
            onEvent={(ev) => setQuickstartEvents((prev) => [...prev, ev])}
            onEnd={() => {
              message.success('快速启动完成');
              setQuickstartRunning(false);
              refreshStatuses();
            }}
          />
        </Card>
      )}
    </div>
  );
}

function QuickstartSseSubscriber({
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

// Run an npm config command via the generic /api/exec endpoint and resolve
// with the child's exit code. The endpoint returns SSE; we read the stream
// until the 'exit' event arrives and return its code.
//
// `--workspaces=false` is required because npm 10+ refuses to run
// `config get/set` from inside a workspace tree (ENOWORKSPACES). The zai
// package itself is a workspace member, so the backend always launches
// from such a directory.
async function runNpmConfigSet(value: string): Promise<number> {
  const token = localStorage.getItem('zai-token') || '';
  const res = await fetch('/api/exec', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Zai-Token': token,
    },
    body: JSON.stringify({
      cmd: 'npm',
      args: ['config', 'set', 'registry', value, '--location=global', '--workspaces=false'],
    }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let exitCode = -1;

  while (true) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    buffer += decoder.decode(chunk, { stream: true });
    // SSE events are separated by a blank line (\n\n).
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      try {
        const ev = JSON.parse(dataLine.slice(6)) as SseEvent;
        if (ev.type === 'exit') {
          exitCode = ev.code ?? -1;
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          return exitCode;
        }
      } catch {
        /* ignore parse errors mid-stream */
      }
    }
  }
  return exitCode;
}
