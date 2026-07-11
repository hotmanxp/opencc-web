import { Card, Button, Row, Col, message, Alert } from 'antd';
import { LoginOutlined, ApiOutlined } from '@ant-design/icons';
import { useState } from 'react';
import type { SseEvent, LoginType } from '@shared/types';
import { useSse } from '../lib/sse';
import LogPanel from '../components/LogPanel';

interface LoginTypeConfig {
  key: LoginType;
  title: string;
  description: string;
  icon: JSX.Element;
  // Optional secondary action — currently only PA offers a 6-day validity ticket.
  longAction?: { key: LoginType; label: string };
}

const loginTypes: LoginTypeConfig[] = [
  {
    key: 'pa',
    title: 'PA 神兵登录',
    description: '通过 PA 神兵系统进行身份验证',
    icon: <LoginOutlined style={{ fontSize: 32, color: '#ff6600' }} />,
    longAction: { key: 'pa-long', label: '登录(6日有效)' },
  },
  {
    key: 'op',
    title: '开放平台登录',
    description: '登录知鸟开放平台',
    icon: <ApiOutlined style={{ fontSize: 32, color: '#ff8533' }} />,
  },
];

// React StrictMode mounts effects twice in dev, and a remount of LoginStream
// creates a second EventSource that re-delivers the same already-replayed
// events. We tag each event with an arrival counter on its source, then drop
// events with a counter we've already seen in the run window.
let arrivalSeq = 0;

type LogState = { events: SseEvent[]; done: boolean };

export default function Login() {
  const [running, setRunning] = useState<LoginType | null>(null);
  const [logs, setLogs] = useState<Record<LoginType, LogState>>({
    pa: { events: [], done: false },
    'pa-long': { events: [], done: false },
    op: { events: [], done: false },
  });

  const startLogin = (type: LoginType) => {
    if (running !== null) return;
    arrivalSeq += 1;
    setRunning(type);
    setLogs((prev) => ({ ...prev, [type]: { events: [], done: false } }));
  };

  const anyDone = Object.values(logs).some((l) => l.done);

  return (
    <div className="space-y-4">
      <Alert
        type="info"
        showIcon
        message="登录说明"
        description="点击登录按钮后,系统将在后台执行登录流程,请在页面查看实时输出日志。"
      />

      <Row gutter={[16, 16]}>
        {loginTypes.map((item) => (
          <Col key={item.key} xs={24} sm={12} md={12}>
            <Card hoverable className="h-full" style={{ textAlign: 'center' }}>
              <div style={{ padding: '24px 0' }}>
                <div style={{ marginBottom: 16 }}>{item.icon}</div>
                <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>{item.title}</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 24 }}>
                  {item.description}
                </p>
                <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
                  <Button
                    type="primary"
                    size="large"
                    loading={running === item.key}
                    disabled={running !== null && running !== item.key}
                    onClick={() => startLogin(item.key)}
                  >
                    登录
                  </Button>
                  {item.longAction && (
                    <Button
                      type="primary"
                      size="large"
                      loading={running === item.longAction.key}
                      disabled={running !== null && running !== item.longAction.key}
                      onClick={() => startLogin(item.longAction!.key)}
                    >
                      {item.longAction.label}
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          </Col>
        ))}
      </Row>

      {running !== null && (
        <LoginStream
          key={`${running}-${arrivalSeq}`}
          url={`/api/login?type=${running}`}
          runId={arrivalSeq}
          onEvent={(ev) =>
            setLogs((prev) => ({
              ...prev,
              [running]: { events: [...prev[running].events, ev], done: prev[running].done },
            }))
          }
          onSettled={(last) => {
            setLogs((prev) => {
              const cur = prev[running];
              if (cur.done) return prev;
              return { ...prev, [running]: { events: cur.events, done: true } };
            });
            if (last) {
              if (last.type === 'exit' && last.code === 0) {
                message.success(`${running} 登录成功`);
              } else if (last.type === 'exit') {
                message.warning(`${running} 退出码 ${last.code ?? '-'}`);
              } else if (last.type === 'error') {
                message.error(`登录失败: ${last.message ?? '未知错误'}`);
              }
            }
            setRunning(null);
          }}
        />
      )}

      {(running !== null || anyDone) && (
        <Card title="实时输出" size="small">
          <LogPanel
            events={
              running !== null
                ? logs[running].events
                : (loginTypes.find((t) => logs[t.key].done)?.key
                    ? logs[loginTypes.find((t) => logs[t.key].done)!.key].events
                    : [])
            }
          />
        </Card>
      )}
    </div>
  );
}

interface LoginStreamProps {
  url: string;
  runId: number;
  onEvent: (ev: SseEvent) => void;
  onSettled: (last: SseEvent | null) => void;
}

function LoginStream({ url, runId, onEvent, onSettled }: LoginStreamProps) {
  const seen = new Set<string>();
  const lastRef = { current: null as SseEvent | null };
  useSse(
    url,
    (ev) => {
      lastRef.current = ev;
      // StrictMode re-mount duplicates deliveries of the same SSE event.
      // Tag each arrival with this runId so duplicate deliveries from
      // stale sources are filtered out.
      const tag = `${runId}:${ev.type}:${ev.line ?? ev.command ?? ev.code ?? ev.message ?? ''}`;
      if (seen.has(tag)) return;
      seen.add(tag);
      onEvent(ev);
    },
    () => onSettled(lastRef.current),
  );
  return null;
}